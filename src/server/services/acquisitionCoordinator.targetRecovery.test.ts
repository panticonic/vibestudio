import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import {
  createInvocationSnapshot,
  invocationSnapshotDigest,
} from "@vibestudio/shared/authority/invocationSnapshot";
import type { AcquisitionInfo } from "@vibestudio/rpc";
import { AcquisitionCoordinator, type AcquisitionRequestInput } from "./acquisitionCoordinator.js";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { storeAcquisitionInputs } from "./acquisitionRequestStorage.js";
import type { ApprovalQueueRequest, ApprovalQueueResolution } from "./approvalQueue.js";

const target = {
  targetSubject: "task:standing-one" as const,
  authorityPlanDigest: "plan:standing-one",
  operationKey: "gateway.fetch:example",
  capability: "service:gateway.fetch",
  capabilityDefinitionDigest: "definition:gateway",
  resource: { kind: "exact" as const, key: "https://example.com" },
  tier: "gated" as const,
  sourceUser: "user:alice" as const,
  renderedAction: "read example.com",
  review: {
    action: "read example.com",
    domain: "web" as const,
    verb: "see" as const,
    declaredBy: "host:gateway.fetch",
  },
};
function input(
  owner = "do:workers/test:Agent:one",
  sessionId = "session-one"
): AcquisitionRequestInput {
  const snapshot = createInvocationSnapshot({
    service: "gateway",
    method: "fetch",
    capability: target.capability,
    capabilityDefinitionDigest: target.capabilityDefinitionDigest,
    resourceType: "network",
    resourceKey: target.resource.key,
    provider: "-",
    providerExecutionDigest: "-",
    preparedStateDigest: "-",
    args: [target.resource.key],
    callerPrincipal: `session:${sessionId}`,
    sessionId,
    taskAuthority: target.targetSubject,
    missionSubject: "-",
    snippetDigest: "a".repeat(64),
    codeLineage: { class: "internal", chain: [] },
    initiatorChain: [target.sourceUser],
  });
  return {
    snapshot,
    snapshotDigest: invocationSnapshotDigest(snapshot),
    tier: "gated",
    caller: createVerifiedCaller(owner, "do"),
    resource: target.resource,
    renderedAction: target.renderedAction,
    presentation: {
      title: "Original title",
      details: [{ label: "Original", value: "immutable facts" }],
      deniedReason: "Denied",
      resource: { type: "network-origin", label: "Website", value: target.resource.key },
      operation: {
        kind: "network",
        verb: "read from",
        object: { type: "network-origin", label: "Website", value: target.resource.key },
      },
      authorityVocabulary: { domain: "web", verb: "see", declaredBy: "fixture" },
    },
  };
}
interface TargetFixture {
  statePath: string;
  grants: CapabilityGrantStore;
  calls: {
    request: ApprovalQueueRequest;
    resolve: (value: ApprovalQueueResolution) => void;
    promise: Promise<ApprovalQueueResolution>;
  }[];
  coordinators: AcquisitionCoordinator[];
  cancelled: string[];
  coordinator(
    resolveTaskTitle?: (subject: string, signal: AbortSignal) => Promise<string | null>
  ): AcquisitionCoordinator;
  failNext(error: Error, sync: boolean): void;
  reopen(): Promise<void>;
}
function fixture(): TargetFixture {
  const statePath = mkdtempSync(join(tmpdir(), "authority-target-recovery-"));
  const calls: TargetFixture["calls"] = [];
  const coordinators: AcquisitionCoordinator[] = [];
  const cancelled: string[] = [];
  let nextFailure: { error: Error; sync: boolean } | undefined;
  const queue = {
    cancelForCaller(callerId: string) {
      cancelled.push(callerId);
      for (const call of calls)
        if (call.request.callerId === callerId) call.resolve({ decision: "deny" });
    },
    requestWithHandle(request: ApprovalQueueRequest) {
      const failure = nextFailure;
      nextFailure = undefined;
      if (failure?.sync) throw failure.error;
      let resolve!: (value: ApprovalQueueResolution) => void;
      const resolution = failure
        ? Promise.reject<ApprovalQueueResolution>(failure.error)
        : new Promise<ApprovalQueueResolution>((r) => {
            resolve = r;
          });
      if (!failure) calls.push({ request, resolve, promise: resolution });
      const decision = resolution.then((value) => value.decision);
      void decision.catch(() => {}); // This fixture owns the unused companion promise too.
      return { approvalId: `fixture-${calls.length}`, resolution, decision };
    },
  };
  const f: TargetFixture = {
    statePath,
    grants: new CapabilityGrantStore({ statePath }),
    calls,
    coordinators,
    cancelled,
    coordinator(
      resolveTaskTitle?: (subject: string, signal: AbortSignal) => Promise<string | null>
    ) {
      const coordinator = new AcquisitionCoordinator({
        grantStore: f.grants,
        approvalQueue: queue as never,
        ...(resolveTaskTitle ? { resolveTaskTitle } : {}),
      });
      coordinators.push(coordinator);
      return coordinator;
    },
    failNext(error: Error, sync: boolean) {
      nextFailure = { error, sync };
    },
    async reopen() {
      for (const coordinator of coordinators) {
        await coordinator.quiesceOwnerDelivery();
        await coordinator.quiescePresentations();
      }
      f.grants.close();
      f.grants = new CapabilityGrantStore({ statePath });
    },
  };
  fixtures.push(f);
  return f;
}
const fixtures: TargetFixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    for (const coordinator of f.coordinators) await coordinator.closeAll();
    for (const call of f.calls) call.resolve({ decision: "deny" });
    await Promise.all(f.calls.map((call) => call.promise));
    for (const coordinator of f.coordinators) {
      await coordinator.joinPresentations();
      await coordinator.quiesceOwnerDelivery();
    }
    f.grants.close();
    rmSync(f.statePath, { recursive: true, force: true });
  }
});
function crashAdmission(f: TargetFixture, requests: readonly AcquisitionRequestInput[]) {
  f.grants.close();
  const script = `
    import {CapabilityGrantStore} from './src/server/services/capabilityGrantStore.ts';
    import {AcquisitionCoordinator} from './src/server/services/acquisitionCoordinator.ts';
    import {restoreAcquisitionInputs} from './src/server/services/acquisitionRequestStorage.ts';
    const [statePath, targetJson, requestsJson] = process.argv.slice(1);
    const grants = new CapabilityGrantStore({statePath});
    const coordinator = new AcquisitionCoordinator({grantStore:grants,approvalQueue:{request:()=>new Promise(()=>{})}});
    const target = coordinator.requestForTarget(JSON.parse(targetJson));
    const infos = restoreAcquisitionInputs(JSON.parse(requestsJson)).map(input=>coordinator.request(input));
    process.stdout.write(JSON.stringify({targetRequestId:target.requestId,infos}));
    process.exit(0);
  `;
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      script,
      f.statePath,
      JSON.stringify(target),
      JSON.stringify(storeAcquisitionInputs(requests)),
    ],
    { cwd: process.cwd(), encoding: "utf8" }
  );
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  f.grants = new CapabilityGrantStore({ statePath: f.statePath });
  return JSON.parse(child.stdout) as { targetRequestId: string; infos: AcquisitionInfo[] };
}

describe("canonical standing invocation joins", () => {
  it("preserves grants, target decisions and ordinary admissions through current-schema reopen", async () => {
    const f = fixture();
    const pending = f.grants.targetRequests.ensure(target);
    const grant = f.grants.issue({
      effect: "allow",
      subject: target.targetSubject,
      capability: target.capability,
      resource: target.resource,
      issuedBy: target.sourceUser,
      provenance: "acquisition",
      constraints: { lineageAtConsent: ["none"] },
    });
    const request = input();
    const admitted = f.grants.acquisitions.admit({
      requestKey: "ordinary-reopen",
      ownerRuntimeId: request.caller.runtime.id,
      sessionId: request.snapshot.sessionId,
      facts: { kind: "invocation", inputs: storeAcquisitionInputs([request]) },
    });
    await f.reopen();
    expect(f.grants.targetRequests.get(pending.requestId)).toEqual(pending);
    expect(f.grants.listAuthorityGrants()).toEqual([grant]);
    expect(
      f.grants.acquisitions.get(admitted.acquisitionId, {
        ownerRuntimeId: request.caller.runtime.id,
        sessionId: request.snapshot.sessionId,
      })
    ).toEqual(admitted);
  });

  it.each(["startup", "direct-wait"])(
    "consumes a retained target result on %s after admission loss without another prompt or grant",
    async (recovery) => {
      const f = fixture();
      const request = input();
      const parent = f.grants.targetRequests.ensure(target);
      const settled = f.grants.targetRequests.settle(
        parent.requestId,
        "granted",
        () =>
          f.grants.issue({
            effect: "allow",
            subject: target.targetSubject,
            capability: target.capability,
            resource: target.resource,
            issuedBy: target.sourceUser,
            provenance: "acquisition",
          }).id
      );
      const admitted = f.grants.acquisitions.admit({
        requestKey: "committed-before-target-consumption",
        ownerRuntimeId: request.caller.runtime.id,
        sessionId: request.snapshot.sessionId,
        facts: {
          kind: "target-join",
          targetRequestId: parent.requestId,
          inputs: storeAcquisitionInputs([request]),
        },
      });
      await f.reopen();
      const coordinator = f.coordinator();
      if (recovery === "startup") coordinator.resumePending();
      await expect(
        coordinator.awaitDecision({
          sessionId: "session-one",
          acquisitionId: admitted.acquisitionId,
          ownerRuntimeId: request.caller.runtime.id,
        })
      ).resolves.toMatchObject({ decision: "task", grantId: settled.grantId });
      expect(coordinator.pending()).toEqual([]);
      expect(f.calls).toHaveLength(0);
      expect(f.grants.listAuthorityGrants()).toHaveLength(1);
    }
  );

  it("recovers an actual process-exit join and preserves its exact receipt through late waits", async () => {
    const f = fixture();
    const request = input();
    const { targetRequestId, infos } = crashAdmission(f, [request]);
    const info = infos[0]!;
    expect(info.acquisitionId).not.toBe(targetRequestId);
    const coordinator = f.coordinator();
    coordinator.resumePending();
    coordinator.resumeTargetRequests();
    expect(f.calls).toHaveLength(1);
    expect(coordinator.pending()).toEqual([info]);
    const wait = coordinator.awaitDecision({
      sessionId: "session-one",
      acquisitionId: info.acquisitionId,
      ownerRuntimeId: request.caller.runtime.id,
    });
    const sql = new DatabaseSync(f.grants.databasePath);
    try {
      sql.exec(`CREATE TRIGGER require_target_settlement BEFORE UPDATE ON authority_acquisitions
        WHEN NEW.state='decided' AND NOT EXISTS(SELECT 1 FROM target_authority_requests WHERE request_id=json_extract(NEW.binding_json,'$.facts.targetRequestId') AND state='granted')
        BEGIN SELECT RAISE(ABORT,'target was not committed with its join'); END`);
      f.calls[0]!.resolve({ decision: "task" });
      await expect(wait).resolves.toMatchObject({ state: "decided", decision: "task" });
      expect(f.grants.targetRequests.get(targetRequestId)?.state).toBe("granted");
      expect(f.grants.listAuthorityGrants()).toHaveLength(1);
    } finally {
      sql.exec("DROP TRIGGER require_target_settlement");
      sql.close();
    }
    await f.reopen();
    const recovered = f.coordinator();
    await expect(
      recovered.awaitDecision({
        sessionId: "session-one",
        acquisitionId: info.acquisitionId,
        ownerRuntimeId: request.caller.runtime.id,
      })
    ).resolves.toMatchObject({ state: "decided", decision: "task" });
    await expect(
      recovered.awaitDecision({
        sessionId: "session-one",
        acquisitionId: info.acquisitionId,
        ownerRuntimeId: "do:foreign",
      })
    ).rejects.toMatchObject({ code: "EACCES" });
    recovered.resumePending();
    expect(f.calls).toHaveLength(1);
  });

  it("retains independent runtime/session bindings while one human decision settles all joins", async () => {
    const f = fixture();
    const requests = [input(), input("do:workers/test:Agent:two"), input(undefined, "session-two")];
    const { infos } = crashAdmission(f, requests);
    expect(new Set(infos.map((info) => info.acquisitionId)).size).toBe(3);
    expect(() =>
      f.grants.acquisitions.get(infos[0]!.acquisitionId, {
        ownerRuntimeId: requests[0]!.caller.runtime.id,
        sessionId: "session-two",
      })
    ).toThrow("not owned");
    const coordinator = f.coordinator();
    coordinator.resumePending();
    expect(f.calls).toHaveLength(1);
    const waits = infos.map((info, i) =>
      coordinator.awaitDecision({
        sessionId: requests[i]!.snapshot.sessionId,
        acquisitionId: info.acquisitionId,
        ownerRuntimeId: requests[i]!.caller.runtime.id,
      })
    );
    f.calls[0]!.resolve({ decision: "task" });
    expect((await Promise.all(waits)).every((outcome) => outcome.decision === "task")).toBe(true);
    expect(f.grants.listAuthorityGrants()).toHaveLength(1);
    expect(f.grants.acquisitions.scan().every((record) => record.state === "decided")).toBe(true);
  });

  it("preserves established coalescing without replacing the first immutable invocation facts", () => {
    const f = fixture();
    const coordinator = f.coordinator();
    coordinator.requestForTarget(target);
    const first = input();
    const info = coordinator.request(first);
    const changed = {
      ...first,
      renderedAction: "changed presentation",
      snapshot: { ...first.snapshot, args: ["changed"] },
    };
    changed.snapshotDigest = invocationSnapshotDigest(changed.snapshot);
    expect(coordinator.request(changed)).toEqual(info);
    const record = f.grants.acquisitions.get(info.acquisitionId, {
      ownerRuntimeId: first.caller.runtime.id,
      sessionId: first.snapshot.sessionId,
    })!;
    expect(record.admission.facts).toMatchObject({
      kind: "target-join",
      inputs: { inputs: [{ renderedAction: first.renderedAction, snapshot: first.snapshot }] },
    });
    expect(f.calls).toHaveLength(1);
  });

  it.each([true, false])(
    "retains presentation failure and allows a fresh retry without stale presenter cleanup: synchronous=%s",
    async (sync) => {
      const f = fixture();
      const request = input();
      f.grants.targetRequests.ensure(target);
      const coordinator = f.coordinator();
      const failure = Object.assign(new Error("presentation failed"), { code: "EPRESENTATION" });
      vi.spyOn(console, "error").mockImplementation(() => {});
      f.failNext(failure, sync);
      await expect(coordinator.requestAndWait(request)).rejects.toBe(failure);
      const old = f.grants.acquisitions.scan()[0]!;
      expect(old.state).toBe("failed");
      coordinator.invalidate([request]);
      const info = coordinator.request(request);
      expect(info.acquisitionId).not.toBe(old.acquisitionId);
      await Promise.resolve();
      expect(coordinator.request(request)).toEqual(info);
      expect(f.calls).toHaveLength(1);
      const wait = coordinator.awaitDecision({
        sessionId: "session-one",
        acquisitionId: info.acquisitionId,
        ownerRuntimeId: request.caller.runtime.id,
      });
      f.calls[0]!.resolve({ decision: "task" });
      await expect(wait).resolves.toMatchObject({ decision: "task" });
      await f.reopen();
      await expect(
        f.coordinator().awaitDecision({
          sessionId: "session-one",
          acquisitionId: old.acquisitionId,
          ownerRuntimeId: request.caller.runtime.id,
        })
      ).rejects.toMatchObject({ message: failure.message, code: failure.code });
    }
  );

  it("rolls back the grant, target and first receipt batch when a later joined receipt cannot commit", async () => {
    const f = fixture();
    const coordinator = f.coordinator();
    const pending = coordinator.requestForTarget(target);
    const requests = Array.from({ length: 70 }, (_, i) => input(`do:workers/test:Agent:${i}`));
    const infos = requests.map((request) => coordinator.request(request));
    const sorted = f.grants.acquisitions.scan();
    // scan is a bounded 64-row page; choose a join beyond that first page.
    const later = infos.find(
      (info) => !sorted.some((record) => record.acquisitionId === info.acquisitionId)
    )!;
    const sql = new DatabaseSync(f.grants.databasePath);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      sql.exec(`CREATE TRIGGER reject_join BEFORE UPDATE ON authority_acquisitions
        WHEN NEW.state='decided' AND OLD.acquisition_id='${later.acquisitionId}'
        BEGIN SELECT RAISE(ABORT,'rejected later join'); END`);
      f.calls[0]!.resolve({ decision: "task" });
      await vi.waitFor(() => expect(logged).toHaveBeenCalled());
      expect(f.grants.targetRequests.get(pending.requestId)?.state).toBe("pending");
      expect(f.grants.listAuthorityGrants()).toEqual([]);
      for (const [i, info] of infos.entries())
        expect(
          f.grants.acquisitions.get(info.acquisitionId, {
            ownerRuntimeId: requests[i]!.caller.runtime.id,
            sessionId: requests[i]!.snapshot.sessionId,
          })?.state
        ).toBe("failed");
    } finally {
      sql.exec("DROP TRIGGER reject_join");
      sql.close();
    }
  });

  it("joins presentation withdrawal before reopening storage and keeps the standing ask pending", async () => {
    const f = fixture();
    const coordinator = f.coordinator();
    const pending = coordinator.requestForTarget(target);
    const lifetime = f.calls[0]!.request.signal!;
    await coordinator.quiescePresentations();
    expect(lifetime.aborted).toBe(true);
    expect(f.cancelled).toEqual([f.calls[0]!.request.callerId]);
    expect(f.grants.targetRequests.get(pending.requestId)).toEqual(pending);
    expect(f.grants.listAuthorityGrants()).toEqual([]);
    await f.reopen();
    const replacement = f.coordinator();
    replacement.resumeTargetRequests();
    expect(f.calls).toHaveLength(2);
    f.calls[1]!.resolve({ decision: "task" });
    await replacement.joinPresentations();
    expect(f.grants.targetRequests.get(pending.requestId)?.state).toBe("granted");
  });

  it("cancels and joins title preparation without presenting or deciding the standing ask", async () => {
    const f = fixture();
    let preparationJoined = false;
    const resolveTitle = vi.fn(
      async (_subject: string, signal: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              preparationJoined = true;
              reject(signal.reason);
            },
            { once: true }
          );
        })
    );
    const coordinator = f.coordinator(resolveTitle);
    const requests = coordinator.requestTaskRulesForTarget([target]);
    expect(resolveTitle).toHaveBeenCalledOnce();
    await coordinator.quiescePresentations();
    expect(preparationJoined).toBe(true);
    expect(f.calls).toEqual([]);
    expect(f.grants.targetRequests.get(requests[0]!.requestId)?.state).toBe("pending");
    expect(f.grants.listAuthorityGrants()).toEqual([]);
  });

  it("settles known joins on session retirement without closing another session or its standing approval", async () => {
    const f = fixture();
    const coordinator = f.coordinator();
    const parent = coordinator.requestForTarget(target);
    const first = input();
    const second = input(undefined, "session-two");
    const infos = [coordinator.request(first), coordinator.request(second)];
    const waits = infos.map((info, i) =>
      coordinator.awaitDecision({
        sessionId: [first, second][i]!.snapshot.sessionId,
        acquisitionId: info.acquisitionId,
        ownerRuntimeId: first.caller.runtime.id,
      })
    );
    await coordinator.closeSession(first.snapshot.sessionId);
    await expect(waits[0]).resolves.toMatchObject({ state: "closed" });
    expect(f.grants.targetRequests.get(parent.requestId)?.state).toBe("pending");
    expect(coordinator.request(first)).toMatchObject({
      acquisitionId: infos[0]!.acquisitionId,
      pending: false,
    });
    const freshTarget = {
      ...target,
      operationKey: "gateway.fetch:other",
      resource: { kind: "exact" as const, key: "https://other.example" },
    };
    coordinator.requestForTarget(freshTarget);
    const fresh = {
      ...first,
      resource: freshTarget.resource,
      snapshot: {
        ...first.snapshot,
        resourceKey: freshTarget.resource.key,
        args: [freshTarget.resource.key],
      },
    };
    fresh.snapshotDigest = invocationSnapshotDigest(fresh.snapshot);
    expect(() => coordinator.request(fresh)).toThrow("retired");
    f.calls[0]!.resolve({ decision: "task" });
    await expect(waits[1]).resolves.toMatchObject({ decision: "task" });
    await f.reopen();
    await expect(
      f.coordinator().awaitDecision({
        sessionId: first.snapshot.sessionId,
        acquisitionId: infos[0]!.acquisitionId,
        ownerRuntimeId: first.caller.runtime.id,
      })
    ).resolves.toMatchObject({ state: "closed" });
  });

  it.each(["ordinary", "standing"])(
    "refuses another session's %s live and recovered waits without disturbing its owner",
    async (kind) => {
      const f = fixture();
      const coordinator = f.coordinator();
      if (kind === "standing") coordinator.requestForTarget(target);
      const request = input();
      const info = coordinator.request(request);
      const foreign = {
        acquisitionId: info.acquisitionId,
        ownerRuntimeId: request.caller.runtime.id,
        sessionId: "session-two",
      };
      await expect(coordinator.awaitDecision(foreign)).rejects.toMatchObject({ code: "EACCES" });
      expect(coordinator.pending()).toHaveLength(1);
      const wait = coordinator.awaitDecision({ ...foreign, sessionId: request.snapshot.sessionId });
      f.calls[0]!.resolve({ decision: "deny" });
      await expect(wait).resolves.toMatchObject({ decision: "deny" });
      await f.reopen();
      await expect(f.coordinator().awaitDecision(foreign)).rejects.toMatchObject({
        code: "EACCES",
      });
      await expect(
        f.coordinator().awaitDecision({ ...foreign, sessionId: request.snapshot.sessionId })
      ).resolves.toMatchObject({ decision: "deny" });
      expect(f.calls).toHaveLength(1);
    }
  );

  it("keeps a multi-plan standing join on its existing grouped prompt", async () => {
    const f = fixture();
    const coordinator = f.coordinator();
    const prior = f.grants.targetRequests.ensure({ ...target, authorityPlanDigest: "plan:a" });
    const [same] = coordinator.requestTaskRulesForTarget([
      { ...target, authorityPlanDigest: "plan:z" },
    ]);
    expect(same?.requestId).toBe(prior.requestId);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.request.effectiveVersion).toBe("plan:z");
    const request = input();
    const wait = coordinator.requestAndWait(request);
    expect(f.calls).toHaveLength(1);
    f.calls[0]!.resolve({ decision: "task", selectedAuthorityFacetKeys: [prior.requestId] });
    await expect(wait).resolves.toMatchObject({ decision: "task" });
    expect(f.grants.listAuthorityGrants()).toHaveLength(1);
  });

  it("binds overlapping task rules cards to only their displayed facets", async () => {
    const f = fixture();
    const coordinator = f.coordinator();
    const other = {
      ...target,
      operationKey: "gateway.fetch:other",
      resource: { kind: "exact" as const, key: "https://other.example" },
      review: { ...target.review, action: "read other.example" },
    };
    const [first] = coordinator.requestTaskRulesForTarget([target]);
    const [same, second] = coordinator.requestTaskRulesForTarget([target, other]);
    expect(same?.requestId).toBe(first!.requestId);
    expect(f.calls).toHaveLength(2);
    expect(f.calls.map((call) => call.request.operationId)).toEqual([
      expect.any(String),
      expect.any(String),
    ]);
    expect(f.calls[0]!.request.operationId).not.toBe(f.calls[1]!.request.operationId);
    expect(
      f.calls.map((call) =>
        call.request.kind === "capability"
          ? call.request.authorityFacets?.map((facet) => facet.selectionKey)
          : undefined
      )
    ).toEqual([[first!.requestId], [second!.requestId]]);
    const wait = coordinator.requestAndWait(input());
    f.calls[1]!.resolve({
      decision: "task",
      // A forged selection for a facet this card did not display cannot settle it.
      selectedAuthorityFacetKeys: [first!.requestId, second!.requestId],
    });
    await vi.waitFor(() =>
      expect(f.grants.targetRequests.get(second!.requestId)?.state).toBe("granted")
    );
    expect(f.grants.targetRequests.get(first!.requestId)?.state).toBe("pending");
    f.calls[0]!.resolve({ decision: "deny" });
    await expect(wait).resolves.toMatchObject({ state: "closed" });
    expect(f.grants.listAuthorityGrants()).toEqual([
      expect.objectContaining({ resource: other.resource }),
    ]);
  });

  it("cancels the actual grouped card after canonical subject retirement", async () => {
    const f = fixture();
    const coordinator = f.coordinator();
    coordinator.registerTargetSubject(
      target.targetSubject,
      target.authorityPlanDigest,
      target.sourceUser,
      "do:controller"
    );
    const [parent] = coordinator.requestTaskRulesForTarget([target]);
    const wait = coordinator.requestAndWait(input());
    expect(f.calls).toHaveLength(1);
    coordinator.retireTargetSubject(target.targetSubject);
    await expect(wait).resolves.toMatchObject({ state: "closed" });
    expect(f.cancelled).toEqual([f.calls[0]!.request.callerId]);
    expect(f.grants.targetRequests.get(parent!.requestId)?.state).toBe("cancelled");
    await f.calls[0]!.promise;
    expect(f.grants.listAuthorityGrants()).toEqual([]);
  });

  it("shares an invocation prompt admitted while a task rules title is being prepared", async () => {
    const f = fixture();
    let resolveTitle!: (title: string) => void;
    const title = new Promise<string>((resolve) => {
      resolveTitle = resolve;
    });
    const coordinator = f.coordinator(() => title);
    const [parent] = coordinator.requestTaskRulesForTarget([target]);
    const wait = coordinator.requestAndWait(input());
    expect(f.calls).toHaveLength(1);
    resolveTitle("Prepared task");
    await title;
    await Promise.resolve();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.request).toMatchObject({ dedupKey: parent!.requestId });
    f.calls[0]!.resolve({ decision: "task" });
    await expect(wait).resolves.toMatchObject({ decision: "task" });
    expect(f.grants.listAuthorityGrants()).toHaveLength(1);
  });

  it("does not create a grouped prompt when its subject retires during title lookup", async () => {
    const f = fixture();
    let resolveTitle!: (title: string) => void;
    const title = new Promise<string>((resolve) => {
      resolveTitle = resolve;
    });
    const coordinator = f.coordinator(() => title);
    coordinator.registerTargetSubject(
      target.targetSubject,
      target.authorityPlanDigest,
      target.sourceUser,
      "do:controller"
    );
    const [parent] = coordinator.requestTaskRulesForTarget([target]);
    expect(f.calls).toHaveLength(0);
    coordinator.retireTargetSubject(target.targetSubject);
    resolveTitle("Retired task");
    await title;
    await Promise.resolve();
    expect(f.calls).toHaveLength(0);
    expect(f.grants.targetRequests.get(parent!.requestId)?.state).toBe("cancelled");
  });

  it("commits registered target retirement with closed join receipts before projection cancellation", async () => {
    const f = fixture();
    const coordinator = f.coordinator();
    coordinator.registerTargetSubject(
      target.targetSubject,
      target.authorityPlanDigest,
      target.sourceUser,
      "do:controller"
    );
    const parent = coordinator.requestForTarget(target);
    const request = input();
    const info = coordinator.request(request);
    const wait = coordinator.awaitDecision({
      sessionId: "session-one",
      acquisitionId: info.acquisitionId,
      ownerRuntimeId: request.caller.runtime.id,
    });
    coordinator.retireTargetSubject(target.targetSubject);
    await expect(wait).resolves.toMatchObject({ state: "closed" });
    expect(f.grants.targetRequests.get(parent.requestId)?.state).toBe("cancelled");
    expect(
      f.grants.acquisitions.get(info.acquisitionId, {
        ownerRuntimeId: request.caller.runtime.id,
        sessionId: request.snapshot.sessionId,
      })?.state
    ).toBe("closed");
    f.calls[0]!.resolve({ decision: "task" });
    await f.calls[0]!.promise;
    expect(f.grants.listAuthorityGrants()).toEqual([]);
  });
});
