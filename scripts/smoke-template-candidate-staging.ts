/** Exercise the existing candidate binding against two exact local template revisions. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { tsImport } from "tsx/esm/api";
import { EventsClient } from "@vibestudio/service-schemas/clients/eventsClient";
import { shellApprovalMethods } from "@vibestudio/service-schemas/shellApproval";
import { workspaceTemplateSourceMethods } from "@vibestudio/service-schemas/templates";
import { defaultAcceptance } from "@vibestudio/shared/authority/unitInstallReview";
import { schemaRpcCaller } from "@vibestudio/rpc/internal";
import { loadCliIdentity } from "../src/cli/credentialStore.js";
import { createRemoteWorkspace, selectRemoteWorkspace } from "../src/cli/remoteClient.js";
import { RpcClient } from "../src/cli/rpcClient.js";
import { createTemplatesClient } from "../src/cli/templatesClient.js";
import { typedClient } from "../src/cli/typedClients.js";
import { requireDevelopmentTemplateCheckouts } from "../src/dev/developmentTemplateConfig.js";
import { readDevInstanceRecord } from "../src/dev/instanceRegistry.js";
import { isManagedSystemTestInstance } from "../src/dev/systemTestInstance.js";

const [instanceName, commit] = process.argv.slice(2);
assert(
  instanceName && commit && /^[a-f0-9]{40}$/u.test(commit),
  "Pass a disposable System instance and its exact detached Examples checkpoint"
);
const root = path.resolve(import.meta.dirname, "..");
const { checkouts, sources } = requireDevelopmentTemplateCheckouts(root);
const examples = sources.find(({ id }) => id === "examples");
assert(examples);
const { bindTemplateCandidate } = await tsImport(
  path.join(checkouts.base, "skills/template-candidate-bindings/index.ts"),
  import.meta.url
);
const instance = readDevInstanceRecord(root, instanceName);
assert(isManagedSystemTestInstance(instance) && instance.lifecycle === "ephemeral");
const identity = loadCliIdentity(path.join(instance.root, "cli-credentials.json"));
assert(
  identity?.kind === "device" && identity.transport === "local" && identity.phase === "workspace"
);
const signal = AbortSignal.timeout(120_000);
const system = new RpcClient(identity, { signal });
let latest;
try {
  latest = await typedClient(
    "workspaceTemplateSource",
    workspaceTemplateSourceMethods,
    system
  ).resolveLocal(examples.url);
} finally {
  await system.close();
}
assert(latest && latest.commit !== commit);
const created = await createRemoteWorkspace(identity, {
  workspace: "template-update-smoke-" + randomUUID().slice(0, 8),
  operationId: randomUUID(),
  rootTemplate: { url: examples.url, ref: "refs/heads/local-checkout", commit },
});
const selected = await selectRemoteWorkspace(
  identity,
  { workspaceId: created.workspaceId },
  { signal }
);
assert.equal(selected.workspaceId, created.workspaceId);
const rpc = new RpcClient(selected, { signal });
const events = new EventsClient(schemaRpcCaller({ streamReadable: rpc.streamReadable.bind(rpc) }));
const approvals = typedClient("shellApproval", shellApprovalMethods, rpc);
const pending = Promise.withResolvers<void>();
void pending.promise.catch(() => {});
const aborted = () => pending.reject(signal.reason);
signal.addEventListener("abort", aborted, { once: true });
const stop = events.on("shell-approval:pending-changed", ({ pending: items }) => {
  if (
    items.some(
      ({ kind, callerId }) =>
        kind === "unit-install-review" && callerId === "system:workspace-creation"
    )
  )
    pending.resolve();
});
try {
  await events.subscribeAll(["shell-approval:pending-changed"]);
  const initial = await approvals.getWorkspaceCreationReviewState();
  if (initial.status === "preparing") await pending.promise;
  const state = await approvals.getWorkspaceCreationReviewState();
  if (state.status === "pending") {
    const approval = (await approvals.listPending()).find(
      ({ approvalId }) => approvalId === state.approvalId
    );
    assert(approval?.kind === "unit-install-review" && approval.mode === "adopt-root");
    const installed = await approvals.resolveInstallReview(
      approval.approvalId,
      defaultAcceptance(approval.mode, approval.parts)
    );
    assert.equal(installed.decision, "accepted");
  } else {
    assert(state.status === "resolved" || state.status === "not-required");
  }
  const templates = createTemplatesClient(rpc);
  const discovered = await templates.checkUpdates();
  const offer = discovered.checks.find(({ source }) => source.url === examples.url);
  assert(offer?.target && offer.source.commit === commit && offer.target.commit === latest.commit);
  assert.equal(offer.status, "available");
  const request = {
    goal: "Stage the exact selected Examples update for review",
    intent: "stage" as const,
    sourceUrl: examples.url,
    installedCommit: commit,
    incomingCommit: latest.commit,
    checkedAfterMs: offer.checkedAt,
    commandId: randomUUID(),
  };
  let preparedContext: string | undefined;
  const bind = () =>
    bindTemplateCandidate(
      templates,
      async () => {
        assert(preparedContext);
        const current = (await rpc.mainCall("vcs.status", [{ contextId: preparedContext }])) as {
          mainEventId: string;
        };
        return current.mainEventId;
      },
      request
    );
  const candidate = bind();
  assert.equal((await candidate.templateOffer.read())?.status, "available");
  const prepared = await candidate.templateCandidatePrepare.prepare();
  assert(prepared.outcome === "acknowledged");
  preparedContext = prepared.review.contextId;
  assert(prepared.review.repositories.length > 0);
  const read = await candidate.templateCandidateReview.read();
  assert.deepEqual(read, { review: prepared.review, mainEventId: prepared.review.mainEventId });
  assert.equal(read.review.state, "review");
  const resumed = await bind().templateCandidatePrepare.prepare();
  assert.deepEqual(resumed, prepared);
  console.log(
    JSON.stringify({
      staged: true,
      sameCandidateOnRetry: true,
      protectedMainUnchanged: true,
      changedRepositories: read.review.repositories.length,
      nativeConflicts: read.review.conflicts.length,
    })
  );
} finally {
  signal.removeEventListener("abort", aborted);
  stop();
  try {
    await events.unsubscribeAll();
  } finally {
    await rpc.close();
  }
}
