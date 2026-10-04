import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createVerifiedCaller, ServiceError } from "@vibestudio/shared/serviceDispatcher";
import {
  createInvocationSnapshot,
  invocationSnapshotDigest,
} from "@vibestudio/shared/authority/invocationSnapshot";
import type { AcquisitionInfo } from "@vibestudio/rpc";
import { AcquisitionCoordinator, type AcquisitionRequestInput } from "./acquisitionCoordinator.js";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { acquisitionJson, storeAcquisitionInputs } from "./acquisitionRequestStorage.js";
import type {
  ApprovalQueue,
  ApprovalQueueRequest,
  ApprovalQueueResolution,
} from "./approvalQueue.js";

function input(): AcquisitionRequestInput {
  const snapshot = createInvocationSnapshot({
    service: "gateway",
    method: "fetch",
    capability: "service:gateway.fetch",
    capabilityDefinitionDigest: "-",
    resourceType: "network",
    provider: "-",
    providerExecutionDigest: "-",
    resourceKey: "https://example.com",
    args: ["https://example.com"],
    preparedStateDigest: "-",
    callerPrincipal: "session:chat-1",
    sessionId: "chat-1",
    taskAuthority: "task:closure-chat-1",
    missionSubject: "-",
    snippetDigest: "a".repeat(64),
    codeLineage: { class: "internal", chain: [] },
    initiatorChain: ["user:u"],
  });
  return {
    snapshot,
    snapshotDigest: invocationSnapshotDigest(snapshot),
    tier: "gated",
    caller: createVerifiedCaller("do:workers/test:Agent:one", "do"),
    renderedAction: "read example.com",
    resource: { kind: "exact", key: snapshot.resourceKey },
    presentation: {
      title: "Read example.com",
      deniedReason: "Denied",
      authorityVocabulary: { domain: "web", verb: "see", declaredBy: "recovery-fixture" },
      details: [{ label: "Original", value: "exact request" }],
      resource: { type: "network", label: "Website", value: snapshot.resourceKey },
      operation: {
        kind: "network",
        verb: "read",
        object: { type: "network", label: "Website", value: snapshot.resourceKey },
      },
    },
  };
}

interface QueuedApproval {
  request: ApprovalQueueRequest;
  resolve: (value: ApprovalQueueResolution) => void;
  promise: Promise<ApprovalQueueResolution>;
}
interface RecoveryFixture {
  statePath: string;
  grants: CapabilityGrantStore;
  queue: ApprovalQueue;
  calls: QueuedApproval[];
  coordinators: AcquisitionCoordinator[];
  coordinator(): AcquisitionCoordinator;
  reopen(): Promise<void>;
}
function fixture(): RecoveryFixture {
  const statePath = mkdtempSync(join(tmpdir(), "authority-coordinator-recovery-"));
  const grants = new CapabilityGrantStore({ statePath });
  const calls: Array<{
    request: ApprovalQueueRequest;
    resolve: (value: ApprovalQueueResolution) => void;
    promise: Promise<ApprovalQueueResolution>;
  }> = [];
  const enqueue = (request: ApprovalQueueRequest) => {
    let resolve!: (value: ApprovalQueueResolution) => void;
    const promise = new Promise<ApprovalQueueResolution>((done) => {
      resolve = done;
    });
    calls.push({ request, resolve, promise });
    const cancel = () => resolve({ decision: "deny" });
    if (request.signal?.aborted) cancel();
    else request.signal?.addEventListener("abort", cancel, { once: true });
    void promise.then(() => request.signal?.removeEventListener("abort", cancel));
    return promise;
  };
  const queue = {
    request: vi.fn((request: ApprovalQueueRequest) =>
      enqueue(request).then((value) => value.decision)
    ),
    requestWithHandle: vi.fn((request: ApprovalQueueRequest) => {
      const resolution = enqueue(request);
      return {
        approvalId: `test-${calls.length}`,
        resolution,
        decision: resolution.then((value) => value.decision),
      };
    }),
  } as unknown as ApprovalQueue;
  const coordinators: AcquisitionCoordinator[] = [];
  const f: RecoveryFixture = {
    statePath,
    grants,
    queue,
    calls,
    coordinators,
    coordinator: () => {
      const coordinator = new AcquisitionCoordinator({
        grantStore: f.grants,
        approvalQueue: queue,
      });
      coordinators.push(coordinator);
      return coordinator;
    },
    reopen: async () => {
      for (const coordinator of coordinators) {
        await coordinator.joinPresentations();
        await coordinator.quiesceOwnerDelivery();
      }
      f.grants.close();
      f.grants = new CapabilityGrantStore({ statePath });
    },
  };
  fixtures.push(f);
  return f;
}
const fixtures: RecoveryFixture[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const f of fixtures.splice(0)) {
    // Every test settles the live owner before its exact database and scratch directory retire.
    for (const coordinator of f.coordinators) {
      if (coordinator.pending().length) await coordinator.closeAll();
    }
    for (const call of f.calls) call.resolve({ decision: "deny" });
    await Promise.all(f.calls.map((call) => call.promise));
    for (const coordinator of f.coordinators) {
      await coordinator.joinPresentations();
      await coordinator.quiesceOwnerDelivery();
    }
    f.grants.close();
    rmSync(f.statePath, { recursive: true });
  }
});

function crashAdmission(
  f: ReturnType<typeof fixture>,
  requests: readonly AcquisitionRequestInput[],
  continuation: "in-band" | "owner-redrive" = "owner-redrive"
): AcquisitionInfo {
  const script = `
    import { CapabilityGrantStore } from './src/server/services/capabilityGrantStore.ts';
    import { AcquisitionCoordinator } from './src/server/services/acquisitionCoordinator.ts';
    import { restoreAcquisitionInputs } from './src/server/services/acquisitionRequestStorage.ts';
    const [statePath, stored] = process.argv.slice(1);
    const grantStore = new CapabilityGrantStore({ statePath });
    const pending = () => new Promise(() => {});
    const coordinator = new AcquisitionCoordinator({ grantStore, approvalQueue: { request: pending, requestWithHandle: () => ({ approvalId: 'crashed-presentation', decision: pending(), resolution: pending() }) } });
    const requests = restoreAcquisitionInputs(JSON.parse(stored));
    const info = ${JSON.stringify(continuation)} === 'in-band'
      ? (void coordinator.requestManyAndWait(requests), coordinator.pending()[0])
      : coordinator.requestMany(requests);
    process.stdout.write(JSON.stringify(info));
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
      JSON.stringify(storeAcquisitionInputs(requests)),
    ],
    { cwd: process.cwd(), encoding: "utf8" }
  );
  expect(child.error, child.stderr).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout) as AcquisitionInfo;
}

describe("canonical invocation acquisition recovery", () => {
  it("restores a real process-exited admission without changing its identity or exact presentation", async () => {
    const f = fixture();
    const request = input();
    const info = crashAdmission(f, [request]);
    const coordinator = f.coordinator();
    coordinator.resumePending();
    coordinator.resumePending();
    expect(f.calls).toHaveLength(1);
    expect(coordinator.request(request)).toEqual(info);
    expect(f.calls[0]!.request).toMatchObject({
      operationId: info.acquisitionId,
      snapshot: request.snapshot,
      details: request.presentation!.details,
    });
    const wait = coordinator.awaitDecision({
      sessionId: "chat-1",
      acquisitionId: info.acquisitionId,
      ownerRuntimeId: request.caller.runtime.id,
    });
    f.calls[0]!.resolve({ decision: "once" });
    await expect(wait).resolves.toEqual({ state: "decided", decision: "once" });
    await f.reopen();
    const replacement = f.coordinator();
    await expect(
      replacement.awaitDecision({
        sessionId: "chat-1",
        acquisitionId: info.acquisitionId,
        ownerRuntimeId: request.caller.runtime.id,
      })
    ).resolves.toEqual({ state: "decided", decision: "once" });
    expect(f.grants.listAuthorityGrants()).toHaveLength(1);
    expect(f.calls).toHaveLength(1);
    await expect(
      replacement.awaitDecision({
        sessionId: "chat-1",
        acquisitionId: info.acquisitionId,
        ownerRuntimeId: "another-runtime",
      })
    ).rejects.toMatchObject({ code: "EACCES" });
  });

  it("preserves pending inline ownership through a real process exit and requires an explicit returned request to acquire redrive", async () => {
    const f = fixture();
    const request = input();
    const info = crashAdmission(f, [request], "in-band");
    const notifyOwner = vi.fn(async () => undefined);
    const coordinator = new AcquisitionCoordinator({
      grantStore: f.grants,
      approvalQueue: f.queue,
      notifyOwner,
    });
    f.coordinators.push(coordinator);
    coordinator.resumePending();
    expect(
      f.grants.acquisitions.get(info.acquisitionId, {
        ownerRuntimeId: request.caller.runtime.id,
        sessionId: request.snapshot.sessionId,
      })?.deliveryOwner
    ).toBe("in-band");
    f.calls[0]!.resolve({ decision: "deny" });
    await coordinator.joinPresentations();
    await coordinator.reprojectOwnerDelivery();
    expect(notifyOwner).not.toHaveBeenCalled();
    expect(coordinator.request(request).acquisitionId).toBe(info.acquisitionId);
    await coordinator.reprojectOwnerDelivery();
    expect(notifyOwner).toHaveBeenCalledExactlyOnceWith(
      request.caller.runtime.id,
      info.acquisitionId,
      expect.any(AbortSignal)
    );
    const terminal = f.grants.acquisitions.get(info.acquisitionId, {
      ownerRuntimeId: request.caller.runtime.id,
      sessionId: request.snapshot.sessionId,
    })!;
    expect(terminal.deliveryOwner).toBe("owner-redrive");
    expect(terminal.acknowledgedAt).toBeUndefined();
  });

  it.each(["host-shutdown", "invocation-cancelled"] as const)(
    "joins owned title preparation on %s and releases its waiting caller",
    async (lifecycle) => {
      const f = fixture();
      const request = input();
      const invocation = new AbortController();
      let titleJoined = false;
      const resolveTaskTitle = vi.fn(
        async (_task: string, signal: AbortSignal) =>
          new Promise<string>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                titleJoined = true;
                reject(signal.reason);
              },
              { once: true }
            );
          })
      );
      const coordinator = new AcquisitionCoordinator({
        grantStore: f.grants,
        approvalQueue: f.queue,
        resolveTaskTitle,
      });
      f.coordinators.push(coordinator);
      const waiting = coordinator.requestAndWait(request, invocation.signal);
      const rejected = expect(waiting).rejects.toMatchObject(
        lifecycle === "host-shutdown"
          ? { message: "Authority presentation stopped" }
          : { code: "ABORT_ERR" }
      );
      expect(resolveTaskTitle).toHaveBeenCalledOnce();
      const acquisitionId = coordinator.pending()[0]!.acquisitionId;
      if (lifecycle === "host-shutdown") await coordinator.quiescePresentations();
      else {
        invocation.abort(new Error("invocation retired"));
        await coordinator.joinPresentations();
      }
      await rejected;
      expect(titleJoined).toBe(true);
      expect(coordinator.pending()).toEqual([]);
      expect(f.calls).toEqual([]);
      expect(f.grants.listAuthorityGrants()).toEqual([]);
      expect(
        f.grants.acquisitions.get(acquisitionId, {
          ownerRuntimeId: request.caller.runtime.id,
          sessionId: request.snapshot.sessionId,
        })?.state
      ).toBe(lifecycle === "host-shutdown" ? "pending" : "closed");
      if (lifecycle === "host-shutdown") {
        expect(() => coordinator.request(request)).toThrow("Authority presentation stopped");
        expect(f.grants.acquisitions.scan()).toHaveLength(1);
      }
    }
  );

  it("retires one captured owner lifetime and joins its prompt without cancelling another session", async () => {
    const f = fixture();
    const coordinator = f.coordinator();
    const first = input();
    const second = input();
    second.snapshot = {
      ...second.snapshot,
      sessionId: "later-session",
      callerPrincipal: "session:later-session",
    };
    second.snapshotDigest = invocationSnapshotDigest(second.snapshot);
    const firstInfo = coordinator.request(first);
    const secondInfo = coordinator.request(second);
    const firstWait = coordinator.awaitDecision({
      acquisitionId: firstInfo.acquisitionId,
      ownerRuntimeId: first.caller.runtime.id,
      sessionId: first.snapshot.sessionId,
    });
    await coordinator.closeOwner({
      ownerRuntimeId: first.caller.runtime.id,
      sessionId: first.snapshot.sessionId,
    });
    await expect(firstWait).resolves.toMatchObject({ state: "closed" });
    expect(f.calls[0]!.request.signal?.aborted).toBe(true);
    expect(f.calls[1]!.request.signal?.aborted).toBe(false);
    expect(coordinator.pending().map((info) => info.acquisitionId)).toEqual([
      secondInfo.acquisitionId,
    ]);
    expect(
      f.grants.acquisitions.get(secondInfo.acquisitionId, {
        ownerRuntimeId: second.caller.runtime.id,
        sessionId: second.snapshot.sessionId,
      })?.state
    ).toBe("pending");
    f.calls[1]!.resolve({ decision: "deny" });
    await coordinator.joinPresentations();
  });

  it("preserves exact retirement failure before aborting presentation ownership and joins title work on retry", async () => {
    const f = fixture();
    const request = input();
    let titleJoined = false;
    const resolveTaskTitle = vi.fn(
      async (_task: string, signal: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              titleJoined = true;
              reject(signal.reason);
            },
            { once: true }
          );
        })
    );
    const coordinator = new AcquisitionCoordinator({
      grantStore: f.grants,
      approvalQueue: f.queue,
      resolveTaskTitle,
    });
    f.coordinators.push(coordinator);
    const info = coordinator.request(request);
    const owner = {
      ownerRuntimeId: request.caller.runtime.id,
      sessionId: request.snapshot.sessionId,
    };
    const failure = new Error("owner retirement refused");
    const retire = vi.spyOn(f.grants.acquisitions, "retire").mockImplementationOnce(() => {
      throw failure;
    });
    await expect(coordinator.closeOwner(owner)).rejects.toBe(failure);
    expect(titleJoined).toBe(false);
    expect(f.grants.acquisitions.get(info.acquisitionId, owner)?.state).toBe("pending");
    retire.mockRestore();
    await coordinator.closeOwner(owner);
    expect(titleJoined).toBe(true);
    expect(f.calls).toEqual([]);
    expect(f.grants.acquisitions.get(info.acquisitionId, owner)?.state).toBe("closed");
    expect(coordinator.pending()).toEqual([]);
  });

  it.each(["owner", "runtime", "session", "agent", "all"] as const)(
    "%s closure joins title work, including repeated closure, without enqueueing a late prompt",
    async (scope) => {
      const f = fixture();
      const request = input();
      request.snapshot = { ...request.snapshot, agentBindingId: "binding:one" };
      request.snapshotDigest = invocationSnapshotDigest(request.snapshot);
      let releaseTitle!: (title: string) => void;
      let titleSignal!: AbortSignal;
      const coordinator = new AcquisitionCoordinator({
        grantStore: f.grants,
        approvalQueue: f.queue,
        resolveTaskTitle: async (_task, signal) => {
          titleSignal = signal;
          return await new Promise<string>((resolve) => {
            releaseTitle = resolve;
          });
        },
      });
      f.coordinators.push(coordinator);
      const info = coordinator.request(request);
      const owner = {
        ownerRuntimeId: request.caller.runtime.id,
        sessionId: request.snapshot.sessionId,
      };
      const waiting = coordinator.awaitDecision({ ...owner, acquisitionId: info.acquisitionId });
      const close = () => {
        switch (scope) {
          case "owner":
            return coordinator.closeOwner(owner);
          case "runtime":
            return coordinator.closeRuntime(owner.ownerRuntimeId);
          case "session":
            return coordinator.closeSession(owner.sessionId);
          case "agent":
            return coordinator.closeAgent("binding:one");
          case "all":
            return coordinator.closeAll();
        }
      };
      let firstJoined = false;
      let secondJoined = false;
      const first = close().then(() => {
        firstJoined = true;
      });
      const second = close().then(() => {
        secondJoined = true;
      });
      await expect(waiting).resolves.toMatchObject({ state: "closed" });
      expect(titleSignal.aborted).toBe(true);
      expect(firstJoined).toBe(false);
      expect(secondJoined).toBe(false);
      expect(f.calls).toEqual([]);
      releaseTitle("Title completed after retirement");
      await Promise.all([first, second]);
      expect(firstJoined).toBe(true);
      expect(secondJoined).toBe(true);
      expect(f.calls).toEqual([]);
      expect(coordinator.pending()).toEqual([]);
      expect(f.grants.acquisitions.get(info.acquisitionId, owner)?.state).toBe("closed");
      expect(f.grants.listAuthorityGrants()).toEqual([]);
    }
  );

  it("joins title work before propagating the original settlement failure from terminal closure", async () => {
    const f = fixture();
    const request = input();
    let releaseTitle!: (title: string) => void;
    const coordinator = new AcquisitionCoordinator({
      grantStore: f.grants,
      approvalQueue: f.queue,
      resolveTaskTitle: async () =>
        new Promise<string>((resolve) => {
          releaseTitle = resolve;
        }),
    });
    f.coordinators.push(coordinator);
    const info = coordinator.request(request);
    const original = new Error("settlement refused");
    vi.spyOn(f.grants.acquisitions, "resolve").mockImplementationOnce(() => {
      throw original;
    });
    let joined = false;
    const closing = coordinator.closeAll().catch((error: unknown) => {
      joined = true;
      throw error;
    });
    const rejected = expect(closing).rejects.toBe(original);
    await Promise.resolve();
    expect(joined).toBe(false);
    releaseTitle("Title completed after failed settlement");
    await rejected;
    expect(joined).toBe(true);
    expect(f.calls).toEqual([]);
    expect(coordinator.pending()).toEqual([]);
    expect(
      f.grants.acquisitions.get(info.acquisitionId, {
        ownerRuntimeId: request.caller.runtime.id,
        sessionId: request.snapshot.sessionId,
      })?.state
    ).toBe("closed");
  });

  it("restores every installation-review collection, origin and landing binding after process loss", async () => {
    const f = fixture();
    const request = input();
    request.presentation!.installReview = {
      mode: "part-changed",
      reportsLanding: true,
      landingToken: "landing-exact",
      unchangedPartCount: 2,
      configWrite: null,
      units: [
        {
          unitKind: "panel",
          unitName: "@workspace-panels/example",
          displayName: "Example",
          capabilities: [],
          source: { kind: "workspace-repo", repo: "panels/example", ref: "main" },
        },
      ],
      previousRequests: new Map([["panels/example", []]]),
      previouslyCleared: new Map([["panels/example", new Set(["row-one", "row-two"])]]),
      origins: new Map([
        [
          "panels/example",
          {
            url: null,
            originKey: "local",
            registrableDomain: null,
            version: null,
            isHostBuild: false,
            firstEncounter: false,
          },
        ],
      ]),
      identityKeys: new Map([["panels/example", "exact-version-key"]]),
      sections: new Map([["panels/example", "repair"]]),
      originallyInstalledFrom: new Map([["panels/example", "Example 1.2.0"]]),
    };
    const info = crashAdmission(f, [request]);
    const coordinator = f.coordinator();
    coordinator.resumePending();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.request).toMatchObject({
      kind: "unit-install-review",
      ...request.presentation!.installReview,
    });
    const wait = coordinator.awaitDecision({
      sessionId: "chat-1",
      acquisitionId: info.acquisitionId,
      ownerRuntimeId: request.caller.runtime.id,
    });
    f.calls[0]!.resolve({ decision: "accepted" });
    await expect(wait).resolves.toEqual({ state: "decided", decision: "once" });
    expect(f.grants.listAuthorityGrants()).toHaveLength(1);
  });

  it("rolls back all composed grants if a later facet fails, retaining the original live and structured recovered failure", async () => {
    const f = fixture();
    const coordinator = f.coordinator();
    const first = input();
    const second = {
      ...first,
      snapshot: { ...first.snapshot, capability: "service:gateway.other", resourceKey: "other" },
      resource: { kind: "exact" as const, key: "other" },
    };
    second.snapshotDigest = invocationSnapshotDigest(second.snapshot);
    const failure = new ServiceError(
      "authority",
      "decision",
      "second facet retired",
      "ERETIRED",
      undefined,
      "access",
      {
        authorityFailure: {
          reasonCode: "receiver-rejected",
          reason: "second facet retired",
          remediation: {
            kind: "retry-through-host",
            message: "Review current authority before retrying",
          },
        },
      }
    );
    const issue = f.grants.issue.bind(f.grants);
    vi.spyOn(f.grants, "issue")
      .mockImplementationOnce(issue)
      .mockImplementationOnce(() => {
        throw failure;
      });
    const result = coordinator.requestManyAndWait([first, second]);
    const assertion = expect(result).rejects.toBe(failure);
    f.calls[0]!.resolve({ decision: "once" });
    await assertion;
    expect(f.grants.listAuthorityGrants()).toEqual([]);
    const record = f.grants.acquisitions.scan()[0]!;
    expect(record.state).toBe("failed");
    await f.reopen();
    await expect(
      f.coordinator().awaitDecision({
        sessionId: first.snapshot.sessionId,
        acquisitionId: record.acquisitionId,
        ownerRuntimeId: first.caller.runtime.id,
      })
    ).rejects.toMatchObject({
      message: failure.message,
      code: "ERETIRED",
      errorKind: "access",
      errorData: failure.errorData,
    });
  });

  it("propagates outcome-write failure to observers without leaving a partial grant or fabricating a committed decision", async () => {
    const f = fixture();
    const request = input();
    const coordinator = f.coordinator();
    const result = coordinator.requestAndWait(request);
    const assertion = expect(result).rejects.toBeInstanceOf(AggregateError);
    const sql = new DatabaseSync(f.grants.databasePath);
    try {
      sql.exec(
        "CREATE TRIGGER reject_acquisition_result BEFORE UPDATE ON authority_acquisitions BEGIN SELECT RAISE(ABORT, 'rejected receipt'); END"
      );
      f.calls[0]!.resolve({ decision: "once" });
      await assertion;
      expect(f.grants.listAuthorityGrants()).toEqual([]);
      expect(f.grants.acquisitions.scan()[0]!.state).toBe("pending");
    } finally {
      sql.exec("DROP TRIGGER reject_acquisition_result");
      sql.close();
    }
    await coordinator.closeAll();
  });

  it("starts a new explicit one-use cycle while retaining the old decision through arbitrary clock changes", async () => {
    const f = fixture();
    const coordinator = f.coordinator();
    const request = input();
    const first = coordinator.requestAndWait(request);
    f.calls[0]!.resolve({ decision: "once" });
    const outcome = await first;
    const id = outcome.info!.acquisitionId;
    const grant = f.grants.listAuthorityGrants()[0]!;
    expect(f.grants.consume(grant.id!)).toBe(true);
    coordinator.invalidate([request]);
    const second = coordinator.requestAndWait(request);
    f.calls[1]!.resolve({ decision: "once" });
    const next = await second;
    expect(next.info!.acquisitionId).not.toBe(id);
    expect(f.grants.listAuthorityGrants()).toHaveLength(2);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2099-01-01"));
    await f.reopen();
    await expect(
      f.coordinator().awaitDecision({
        sessionId: "chat-1",
        acquisitionId: id,
        ownerRuntimeId: request.caller.runtime.id,
      })
    ).resolves.toEqual({ state: "decided", decision: "once" });
  });

  it("closes unreprojected requests and fences subsequent asks when their session is explicitly retired", async () => {
    const f = fixture();
    const request = input();
    const info = crashAdmission(f, [request]);
    const coordinator = f.coordinator();
    await coordinator.closeSession(request.snapshot.sessionId);
    expect(
      f.grants.acquisitions.get(info.acquisitionId, {
        ownerRuntimeId: request.caller.runtime.id,
        sessionId: request.snapshot.sessionId,
      })?.state
    ).toBe("closed");
    await f.reopen();
    const replacement = f.coordinator();
    replacement.resumePending();
    expect(f.calls).toHaveLength(0);
    const changed = { ...request, snapshot: { ...request.snapshot, argsDigest: "b".repeat(64) } };
    changed.snapshotDigest = invocationSnapshotDigest(changed.snapshot);
    expect(() => replacement.request(changed)).toThrow(/absent or retired/);
  });

  it("retains the original request while reusable installed-code invocations coalesce after replacement", async () => {
    const f = fixture();
    const request = input();
    request.caller = createVerifiedCaller(request.caller.runtime.id, "do", {
      callerId: request.caller.runtime.id,
      callerKind: "do",
      repoPath: "workers/test",
      effectiveVersion: "ev-test",
      executionDigest: "c".repeat(64),
      requested: [],
    });
    request.snapshot = {
      ...request.snapshot,
      callerPrincipal: `code:workers/test@${"c".repeat(64)}`,
    };
    request.snapshotDigest = invocationSnapshotDigest(request.snapshot);
    request.presentation!.allowedDecisions = ["version", "deny"];
    const info = crashAdmission(f, [request]);
    const coordinator = f.coordinator();
    const changed = {
      ...request,
      snapshot: { ...request.snapshot, argsDigest: "d".repeat(64), at: request.snapshot.at + 1 },
    };
    changed.snapshotDigest = invocationSnapshotDigest(changed.snapshot);
    expect(coordinator.request(changed)).toEqual(info);
    expect(f.calls[0]!.request).toMatchObject({ snapshot: request.snapshot });
    const wait = coordinator.awaitDecision({
      sessionId: "chat-1",
      acquisitionId: info.acquisitionId,
      ownerRuntimeId: request.caller.runtime.id,
    });
    f.calls[0]!.resolve({ decision: "version" });
    await expect(wait).resolves.toMatchObject({ state: "decided", decision: "version" });
    expect(f.grants.listAuthorityGrants()).toHaveLength(1);
  });

  it("keeps equal snapshot digests in distinct sessions separate and refuses unsupported live facts before admission", async () => {
    const f = fixture();
    const coordinator = f.coordinator();
    const first = input();
    const second = { ...first, snapshot: { ...first.snapshot, sessionId: "chat-2" } };
    second.snapshotDigest = invocationSnapshotDigest(second.snapshot);
    expect(second.snapshotDigest).toBe(first.snapshotDigest);
    const a = coordinator.request(first);
    const b = coordinator.request(second);
    expect(a.acquisitionId).not.toBe(b.acquisitionId);
    expect(() => acquisitionJson({ map: new Map() })).toThrow(/unsupported collection/);
    expect(() =>
      f.grants.acquisitions.admit({
        requestKey: "head\0tail",
        ownerRuntimeId: first.caller.runtime.id,
        sessionId: first.snapshot.sessionId,
        facts: {},
      })
    ).toThrow(/non-NUL/);
    const waits = [a, b].map((info, i) =>
      coordinator.awaitDecision({
        sessionId: [first, second][i]!.snapshot.sessionId,
        acquisitionId: info.acquisitionId,
        ownerRuntimeId: first.caller.runtime.id,
      })
    );
    for (const call of f.calls) call.resolve({ decision: "deny" });
    await Promise.all(waits);
  });

  it.each([false, true])(
    "restores source-delta rows and preserves the committed decision when live withdrawal fails: %s",
    async (failWithdrawal) => {
      const f = fixture();
      const request = input();
      request.snapshot = {
        ...request.snapshot,
        lineageClasses: ["source:web:https://outside.example"],
      };
      request.snapshotDigest = invocationSnapshotDigest(request.snapshot);
      const original = f.grants.issue({
        effect: "allow",
        subject: request.snapshot.taskAuthority!,
        capability: request.snapshot.capability,
        resource: request.resource,
        scope: "task",
        constraints: { lineageAtConsent: ["none"] },
        issuedBy: "user:u",
        provenance: "acquisition",
      });
      const info = crashAdmission(f, [request]);
      const coordinator = f.coordinator();
      coordinator.resumePending();
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]!.request).toMatchObject({
        operationId: info.acquisitionId,
        cardType: "task.rules",
        sourcesShown: ["web:https://outside.example"],
        authorityFacets: [expect.objectContaining({ selectionKey: original.id })],
      });
      const wait = coordinator.awaitDecision({
        sessionId: "chat-1",
        acquisitionId: info.acquisitionId,
        ownerRuntimeId: request.caller.runtime.id,
      });
      const withdrawals: string[] = [];
      const observed: unknown[] = [];
      const withdrawalFailure = new Error("live withdrawal failed");
      if (failWithdrawal)
        f.grants.onGrantWithdrawal(() => {
          throw withdrawalFailure;
        });
      f.grants.onGrantWithdrawal((grant) => {
        withdrawals.push(grant.id!);
        observed.push({
          state: f.grants.acquisitions.get(info.acquisitionId, {
            ownerRuntimeId: request.caller.runtime.id,
            sessionId: request.snapshot.sessionId,
          })?.state,
          active: f.grants.listActiveAuthorityGrants().map((item) => item.id),
        });
      });
      f.calls[0]!.resolve({ decision: "task", selectedAuthorityFacetKeys: [original.id!] });
      await expect(wait).resolves.toEqual({ state: "decided", decision: "task" });
      expect(withdrawals).toEqual([original.id]);
      expect(observed).toEqual([{ state: "decided", active: [expect.any(String)] }]);
      expect((observed[0] as { active: string[] }).active).not.toContain(original.id);
      expect(
        f.grants.listAuthorityGrants().find((grant) => grant.id === original.id)?.revokedAt
      ).toBeDefined();
      expect(f.grants.listActiveAuthorityGrants()).toEqual([
        expect.objectContaining({
          subject: request.snapshot.taskAuthority,
          constraints: { lineageAtConsent: ["none", "source:web:https://outside.example"] },
        }),
      ]);
      await f.reopen();
      await expect(
        f.coordinator().awaitDecision({
          sessionId: "chat-1",
          acquisitionId: info.acquisitionId,
          ownerRuntimeId: request.caller.runtime.id,
        })
      ).resolves.toEqual({ state: "decided", decision: "task" });
      expect(f.calls).toHaveLength(1);
    }
  );

  it("rolls back source grant revocation and replacement when the receipt cannot commit", async () => {
    const f = fixture();
    const request = input();
    request.snapshot = {
      ...request.snapshot,
      lineageClasses: ["source:web:https://outside.example"],
    };
    request.snapshotDigest = invocationSnapshotDigest(request.snapshot);
    const original = f.grants.issue({
      effect: "allow",
      subject: request.snapshot.taskAuthority!,
      capability: request.snapshot.capability,
      resource: request.resource,
      scope: "task",
      constraints: { lineageAtConsent: ["none"] },
      issuedBy: "user:u",
      provenance: "acquisition",
    });
    const coordinator = f.coordinator();
    const withdrawals: string[] = [];
    f.grants.onGrantWithdrawal((grant) => withdrawals.push(grant.id!));
    const result = coordinator.requestAndWait(request);
    const assertion = expect(result).rejects.toBeInstanceOf(AggregateError);
    const sql = new DatabaseSync(f.grants.databasePath);
    try {
      sql.exec(
        "CREATE TRIGGER reject_acquisition_result BEFORE UPDATE ON authority_acquisitions BEGIN SELECT RAISE(ABORT, 'rejected source receipt'); END"
      );
      f.calls[0]!.resolve({ decision: "task", selectedAuthorityFacetKeys: [original.id!] });
      await assertion;
      expect(f.grants.listAuthorityGrants()).toEqual([original]);
      expect(withdrawals).toEqual([]);
      expect(f.grants.acquisitions.scan()[0]!.state).toBe("pending");
    } finally {
      sql.exec("DROP TRIGGER reject_acquisition_result");
      sql.close();
    }
    await coordinator.closeAll();
  });

  it("preserves dismissal cooldown on reopen and starts a new ask only on a later attempt", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 9, 2);
    vi.setSystemTime(now);
    const f = fixture();
    const request = input();
    const coordinator = f.coordinator();
    const result = coordinator.requestAndWait(request);
    f.calls[0]!.resolve({ decision: "dismiss" });
    const closed = await result;
    expect(closed).toMatchObject({
      state: "closed",
      info: { pending: true, cooldownUntil: now + 600_000 },
    });
    await f.reopen();
    const replacement = f.coordinator();
    vi.setSystemTime(now + 60_000);
    replacement.invalidate([request]);
    expect(replacement.request(request)).toEqual(closed.info);
    expect(f.calls).toHaveLength(1);
    vi.setSystemTime(now + 660_000);
    const next = replacement.requestAndWait(request);
    expect(f.calls).toHaveLength(2);
    f.calls[1]!.resolve({ decision: "deny" });
    const settled = await next;
    expect(settled.info!.acquisitionId).not.toBe(closed.info!.acquisitionId);
    expect(
      f.grants.acquisitions.get(closed.info!.acquisitionId, {
        ownerRuntimeId: request.caller.runtime.id,
        sessionId: request.snapshot.sessionId,
      })?.state
    ).toBe("closed");
  });

  it("keeps composed host test-policy preauthorization atomic when a later grant fails", () => {
    const f = fixture();
    const first = input();
    first.snapshot = {
      ...first.snapshot,
      executionMode: "test",
      testPolicyId: "test:atomic-policy",
    };
    first.snapshotDigest = invocationSnapshotDigest(first.snapshot);
    const second = {
      ...first,
      snapshot: { ...first.snapshot, capability: "service:gateway.other" },
    };
    second.snapshotDigest = invocationSnapshotDigest(second.snapshot);
    first.caller = {
      ...first.caller,
      testPolicy: {
        policyId: "test:atomic-policy",
        kind: "case",
        orchestratorPolicyId: "test:orchestrator",
        case: {
          testId: "atomic-policy",
          agent: { model: "openai-codex:gpt-6-luna", approvalLevel: 2, fallback: "disabled" },
          unexpectedPrompts: "fail",
          authority: [first, second].map((request, index) => ({
            ruleId: `facet-${index}`,
            capability: { kind: "exact" as const, key: request.snapshot.capability },
            resource: request.resource,
            tier: "gated" as const,
            decision: "once" as const,
          })),
        },
      },
    };
    second.caller = first.caller;
    const issue = f.grants.issue.bind(f.grants);
    const failure = new Error("second policy grant failed");
    vi.spyOn(f.grants, "issue")
      .mockImplementationOnce(issue)
      .mockImplementationOnce(() => {
        throw failure;
      });
    expect(() => f.coordinator().requestMany([first, second])).toThrow(failure);
    expect(f.grants.listAuthorityGrants()).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });

  it("refuses to compose authority leaves from different runtime owners before admitting or presenting", () => {
    const f = fixture();
    const first = input();
    const second = { ...first, caller: createVerifiedCaller("do:foreign", "do") };
    expect(second.snapshot.sessionId).toBe(first.snapshot.sessionId);
    expect(() => f.coordinator().requestMany([first, second])).toThrow("one exact invocation");
    expect(f.grants.acquisitions.scan()).toEqual([]);
    expect(f.grants.listAuthorityGrants()).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it("delivers the first canonical decision when a replaced presentation answers late with a conflicting verdict", async () => {
    const f = fixture();
    const request = input();
    const original = f.coordinator();
    const info = original.request(request);
    const originalWait = original.awaitDecision({
      sessionId: "chat-1",
      acquisitionId: info.acquisitionId,
      ownerRuntimeId: request.caller.runtime.id,
    });
    const replacement = f.coordinator();
    expect(replacement.request(request)).toEqual(info);
    const replacementWait = replacement.awaitDecision({
      sessionId: "chat-1",
      acquisitionId: info.acquisitionId,
      ownerRuntimeId: request.caller.runtime.id,
    });
    f.calls[1]!.resolve({ decision: "once" });
    await expect(replacementWait).resolves.toEqual({ state: "decided", decision: "once" });
    f.calls[0]!.resolve({ decision: "deny" });
    await expect(originalWait).resolves.toEqual({ state: "decided", decision: "once" });
    expect(f.grants.listAuthorityGrants()).toEqual([
      expect.objectContaining({
        effect: "allow",
        constraints: expect.objectContaining({ invocationDigest: request.snapshotDigest }),
      }),
    ]);
  });
});
