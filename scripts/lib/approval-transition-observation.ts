import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { schemaRpcCaller } from "@vibestudio/rpc/internal";
import { EventsClient } from "@vibestudio/service-schemas/clients/eventsClient";
import { shellApprovalMethods } from "@vibestudio/service-schemas/shellApproval";
import { workspaceTemplateSourceMethods } from "@vibestudio/service-schemas/templates";
import type { PendingApproval } from "@vibestudio/shared/approvals";
import { readApprovalQueueSnapshot } from "../../src/cli/approvalCommands.js";
import { loadCliIdentity } from "../../src/cli/credentialStore.js";
import { createRemoteWorkspace, selectRemoteWorkspace } from "../../src/cli/remoteClient.js";
import { RpcClient } from "../../src/cli/rpcClient.js";
import { typedClient } from "../../src/cli/typedClients.js";
import { requireDevelopmentTemplateCheckouts } from "../../src/dev/developmentTemplateConfig.js";
import { readDevInstanceRecord } from "../../src/dev/instanceRegistry.js";
import { isManagedSystemTestInstance } from "../../src/dev/systemTestInstance.js";

function isCreationReview(approval: PendingApproval) {
  return (
    approval.kind === "unit-install-review" &&
    approval.mode === "adopt-root" &&
    approval.callerId === "system:workspace-creation"
  );
}

export async function liveApprovalTransition(instanceName: string, outerSignal?: AbortSignal) {
  const root = path.resolve(import.meta.dirname, "../..");
  const instance = readDevInstanceRecord(root, instanceName);
  assert(isManagedSystemTestInstance(instance) && instance.lifecycle === "ephemeral");
  const identity = loadCliIdentity(path.join(instance.root, "cli-credentials.json"));
  assert(
    identity?.kind === "device" && identity.transport === "local" && identity.phase === "workspace"
  );
  const deadline = AbortSignal.timeout(60_000);
  const signal = outerSignal ? AbortSignal.any([deadline, outerSignal]) : deadline;
  const template = requireDevelopmentTemplateCheckouts(root).sources.find(
    ({ id }) => id === "examples"
  );
  assert(template, "The catalog needs the Examples template");
  const system = new RpcClient(identity, { signal });
  const rootTemplate = await (async () => {
    try {
      return await typedClient(
        "workspaceTemplateSource",
        workspaceTemplateSourceMethods,
        system
      ).resolveLocal(template.url);
    } finally {
      await system.close();
    }
  })();
  assert(rootTemplate, "The owned instance needs a local Examples checkpoint");
  const created = await createRemoteWorkspace(identity, {
    workspace: "approval-journey-" + randomUUID().slice(0, 8),
    operationId: randomUUID(),
    rootTemplate,
  });
  const assigned = await selectRemoteWorkspace(
    identity,
    { workspaceId: created.workspaceId },
    { signal }
  );
  assert.equal(assigned.workspaceId, created.workspaceId);
  assert.notEqual(assigned.workspaceId, "workspaceId" in identity ? identity.workspaceId : null);

  const rpc = new RpcClient(assigned, { signal });
  const events = new EventsClient(
    schemaRpcCaller({ streamReadable: rpc.streamReadable.bind(rpc) })
  );
  const approvals = typedClient("shellApproval", shellApprovalMethods, rpc);
  let observed!: () => void;
  let rejectObservation!: (reason: unknown) => void;
  const available = new Promise<void>((resolve, reject) => {
    observed = resolve;
    rejectObservation = reject;
  });
  const aborted = () => rejectObservation(signal.reason);
  void available.catch(() => {});
  signal.addEventListener("abort", aborted, { once: true });
  const unlisten = events.on("shell-approval:pending-changed", ({ pending }) => {
    if (pending.some(isCreationReview)) observed();
  });
  try {
    signal.throwIfAborted();
    await events.subscribeAll(["shell-approval:pending-changed"]);
    if (!(await approvals.listPending()).some(isCreationReview)) await available;
    const state = await approvals.getWorkspaceCreationReviewState();
    assert(state.status === "pending", "The assigned workspace creation review is pending");
    const { approvalId } = state;
    assert(
      (await approvals.listPending()).some(
        (item) => item.approvalId === approvalId && isCreationReview(item)
      )
    );
    const before = await readApprovalQueueSnapshot(assigned, signal);
    const resolution = await approvals.resolveInstallReview(approvalId, { decision: "cancel" });
    assert.equal(resolution.approvalId, approvalId);
    assert.equal(resolution.decision, "cancelled");
    const after = await readApprovalQueueSnapshot(assigned, signal);
    assert.equal(before.caller, after.caller);
    assert.equal(before.caller, "device-workspace");
    const aliases = new Map<string, string>();
    const alias = (id: string) => {
      if (!aliases.has(id)) aliases.set(id, randomUUID());
      return aliases.get(id)!;
    };
    function redact(sample: typeof before, listed: boolean) {
      const receipts = sample.receipts.map(({ source, kind, ids }) => ({
        source,
        kind,
        ids: ids.map(alias),
      }));
      assert.deepEqual(
        receipts.map(({ source, kind }) => [source, kind]),
        [
          ["workspace", "snapshot"],
          ["hub", "snapshot"],
        ]
      );
      assert.equal(receipts[0]!.ids.includes(alias(approvalId)), listed);
      assert.equal(receipts[1]!.ids.includes(alias(approvalId)), false);
      return {
        receipts,
        report: {
          coverage: "complete",
          surfaces: receipts.map(({ source, ids }) => ({ source, state: "visible", ids })),
          location: listed
            ? { status: "located", source: "workspace" }
            : { status: "absent", source: null },
        },
      };
    }
    const earlier = redact(before, true);
    const later = redact(after, false);
    return {
      id: "approval-queue-live-cancelled-creation-review",
      workspaceId: created.workspaceId,
      request: {
        goal: "Follow the assigned workspace review across both approval queue observations.",
        caller: before.caller,
        approvalId: alias(approvalId),
        earlier: earlier.receipts,
        later: later.receipts,
      },
      expected: { transition: "no-longer-listed", earlier: earlier.report, later: later.report },
    };
  } finally {
    signal.removeEventListener("abort", aborted);
    unlisten();
    try {
      await events.unsubscribeAll();
    } finally {
      await rpc.close();
    }
  }
}
