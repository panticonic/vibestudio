import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import {
  childEvalContinuationDecision,
  createDevHostService,
  DevHostSourceWatcher,
  type DevHostProvider,
} from "./devHostService.js";
import type {
  DevHostProviderLaunchInput,
  DevLaunchStatus,
} from "@vibestudio/service-schemas/devHost";

function context(id = "panel:owner"): ServiceContext {
  return {
    caller: createVerifiedCaller(id, "panel", {
      callerId: id,
      callerKind: "panel",
      repoPath: "panels/agent",
      executionDigest: "a".repeat(64),
      delegations: [],
      requested: [
        { capability: "service:devHost.launch", resource: { kind: "prefix", prefix: "" } },
        { capability: "service:devHost.status", resource: { kind: "prefix", prefix: "" } },
        { capability: "service:devHost.eval.start", resource: { kind: "prefix", prefix: "" } },
        { capability: "service:devHost.eval.get", resource: { kind: "prefix", prefix: "" } },
        { capability: "service:devHost.eval.events", resource: { kind: "prefix", prefix: "" } },
        { capability: "service:devHost.eval.cancel", resource: { kind: "prefix", prefix: "" } },
      ],
    }),
  };
}

describe("childEvalContinuationDecision", () => {
  it("preserves an explicit run-scoped approval", () => {
    expect(
      childEvalContinuationDecision({ allowed: true, decision: "run" }, [
        "once",
        "run",
        "deny",
        "dismiss",
      ])
    ).toBe("run");
  });

  it("uses run scope for a reusable parent grant and preserves an explicit once", () => {
    expect(
      childEvalContinuationDecision({ allowed: true, decision: "session" }, ["once", "run"])
    ).toBe("run");
    expect(
      childEvalContinuationDecision({ allowed: true, decision: "once" }, ["once", "run"])
    ).toBe("once");
  });
});

function devHostExtensionContext(): ServiceContext {
  return {
    caller: createVerifiedCaller("@workspace-extensions/dev-host", "extension", {
      callerId: "@workspace-extensions/dev-host",
      callerKind: "extension",
      repoPath: "extensions/dev-host",
      executionDigest: "d".repeat(64),
      requested: [],
      delegations: [],
    }),
  };
}

function fixture() {
  const recipientKey = generateKeyPairSync("x25519")
    .publicKey.export({ type: "spki", format: "der" })
    .toString("base64url");
  const records: DevLaunchStatus[] = [];
  const launch = vi.fn(async (input: DevHostProviderLaunchInput) => {
    const existing = records.find((item) => item.launchId === input.launchId);
    if (existing) return existing;
    const record: DevLaunchStatus = {
      launchId: input.launchId,
      owner: input.owner,
      sourceRepoPath: "projects/vibestudio",
      sourceStateHash: input.sourceStateHash,
      dirtyCount: input.dirtyCount,
      executionInputHash: input.snapshot.executionInputHash,
      recipeDigest: input.snapshot.recipeDigest,
      activeSnapshotId: input.snapshot.snapshotId,
      candidateSourceStateHash: null,
      candidateDirtyCount: null,
      candidateExecutionInputHash: null,
      candidateRecipeDigest: null,
      candidateSnapshotId: null,
      target: input.target,
      state: "ready" as const,
      activeHostBuildId: "host-build-1",
      candidateHostBuildId: null,
      readinessIdentity: {
        launchId: input.launchId,
        hostBuildId: "host-build-1",
        serverId: "child-1",
        endpoint: "http://127.0.0.1:9999",
        evalAuthorityRecipientKey: recipientKey,
      },
      childWorkspaceId: "child-workspace",
      childContextId: "child-context",
      clientReadinessIdentity: null,
      processIdentity: "123:boot",
      restartCount: 0,
      startedAt: 1,
      updatedAt: 1,
      lastError: null,
    };
    records.push(record);
    return record;
  });
  const prepare = vi.fn(async (input: Parameters<DevHostProvider["prepare"]>[0]) => {
    const existing = records.find((item) => item.launchId === input.request.launchId);
    if (existing) return { proceed: false as const, status: existing };
    return {
      proceed: true as const,
      request: input.request,
      status: {
        launchId: input.request.launchId,
        owner: input.request.owner,
        sourceRepoPath: "projects/vibestudio" as const,
        sourceStateHash: input.request.sourceStateHash,
        dirtyCount: input.request.dirtyCount,
        executionInputHash: input.request.snapshot.executionInputHash,
        recipeDigest: input.request.snapshot.recipeDigest,
        activeSnapshotId: null,
        candidateSourceStateHash: null,
        candidateDirtyCount: null,
        candidateExecutionInputHash: null,
        candidateRecipeDigest: null,
        candidateSnapshotId: null,
        target: input.request.target,
        state: "awaiting-approval" as const,
        activeHostBuildId: null,
        candidateHostBuildId: null,
        readinessIdentity: null,
        childWorkspaceId: null,
        childContextId: null,
        clientReadinessIdentity: null,
        processIdentity: null,
        restartCount: 0,
        startedAt: 1,
        updatedAt: 1,
        lastError: null,
      },
    };
  });
  const failPreparation = vi.fn(
    async (input: Parameters<DevHostProvider["failPreparation"]>[0]) =>
      (await prepare(input)).status
  );
  const evalStart = vi.fn(
    async (
      _launchId: string,
      _input: import("@vibestudio/service-schemas/eval").EvalStartInput,
      _authority: import("@vibestudio/service-schemas/eval").EvalParentAuthorityEnvelope
    ) => ({
      runId: "run-1",
      status: "accepted" as const,
      acceptedAt: 1,
      startIntentDigest: "a".repeat(64),
    })
  );
  const provider: DevHostProvider = {
    prepare,
    failPreparation,
    launch,
    status: vi.fn(async () => records),
    rebuild: vi.fn(async (input) => ({
      launchId: input.launchId,
      executionInputHash: input.snapshot.executionInputHash,
      hostBuildId: "host-build-2",
      active: true,
      state: "ready" as const,
    })),
    stop: vi.fn(async (launchId) => ({ launchId, stopped: true })),
    evalStart,
    evalGet: vi.fn(async () => ({
      runId: "run-1",
      status: "running" as const,
      acceptedAt: 1,
      startedAt: 2,
      endedAt: null,
      deadlineAt: null,
      startIntentDigest: "a".repeat(64),
      sourceDigest: "b".repeat(64),
      executionProvenanceDigest: "c".repeat(64),
      scopeInputRevision: "scope-1",
      runDigest: "d".repeat(64),
      sourceBundleDigest: "e".repeat(64),
      manifestDigest: "f".repeat(64),
      terminalReason: null,
    })),
    evalEvents: vi.fn(async () => ({ events: [], next: 0 })),
    evalCancel: vi.fn(async () => ({ status: "requested" as const })),
    logs: vi.fn(async () => new Response("logs")),
    watch: vi.fn(async () => new Response("watch")),
  };
  const authorize = vi.fn(async () => undefined);
  const createSnapshot = vi.fn(async ({ stateHash }: { stateHash: string }) => ({
    snapshotId: "snapshot-1",
    executionInputHash: "b".repeat(64) as never,
    source: {
      repoPath: "projects/vibestudio",
      stateHash: stateHash as never,
      sourceEv: "c".repeat(64) as never,
    },
    recipeDigest: "d".repeat(64) as never,
    sourceRoot: "/private/source",
    scratchRoot: "/private/scratch",
    manifestPath: "/private/snapshot.json",
    createdAt: 1,
  }));
  const releaseSnapshot = vi.fn(async () => undefined);
  const prepareCurrentHostClient = vi.fn(async () => ({
    invite: { deepLink: "vibestudio://connect?test" } as never,
    expectedHost: { serverId: "current-server", workspaceId: "ws-1" },
    rpcContractVersion: 1,
  }));
  const resolveChildChallenge = vi.fn(async () => "once" as const);
  const definition = createDevHostService({
    workspaceId: "ws-1",
    parentHostId: "parent-server:boot-1",
    resolveCallerContext: (id) => (id === "panel:owner" ? "ctx-owner" : "ctx-other"),
    resolveSource: vi.fn(async () => ({ stateHash: "e".repeat(64), dirtyCount: 3 })),
    createSnapshot,
    releaseSnapshot,
    prepareCurrentHostClient,
    authorize,
    resolveChildChallenge,
    provider: () => provider,
    now: () => 10,
  });
  return {
    definition,
    provider,
    records,
    authorize,
    launch,
    createSnapshot,
    releaseSnapshot,
    prepare,
    failPreparation,
    prepareCurrentHostClient,
    resolveChildChallenge,
    evalStart,
  };
}

describe("devHost service", () => {
  it("mints owner, state, snapshot, execution grant, and stable idempotency identity", async () => {
    const f = fixture();
    const input = {
      target: {
        kind: "isolated-host" as const,
        client: "none" as const,
        persistence: "ephemeral" as const,
      },
      idempotencyKey: "same",
    };
    const first = await f.definition.handler(context(), "launch", [input]);
    const second = await f.definition.handler(context(), "launch", [input]);
    expect(second).toEqual(first);
    expect(f.launch.mock.calls[0]![0]).toMatchObject({
      owner: {
        principal: `code:panels/agent@${"a".repeat(64)}`,
        workspaceId: "ws-1",
        contextId: "ctx-owner",
      },
      sourceRepoPath: "projects/vibestudio",
      dirtyCount: 3,
      executionGrant: { authorizedAt: 10 },
    });
    expect(f.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ executionInputHash: "b".repeat(64) })
    );
  });

  it("rejects caller-supplied foreign contexts before resolving source or snapshot", async () => {
    const f = fixture();
    await expect(
      f.definition.handler(context(), "launch", [
        {
          contextId: "ctx-other",
          target: { kind: "current-host-client", client: "electron" },
          idempotencyKey: "x",
        },
      ])
    ).rejects.toMatchObject({ code: "EACCES" });
    expect(f.createSnapshot).not.toHaveBeenCalled();
  });

  it("mints current-host pairing only after resolving and authorizing the exact snapshot", async () => {
    const f = fixture();
    await f.definition.handler(context(), "launch", [
      {
        target: { kind: "current-host-client", client: "electron" },
        idempotencyKey: "current",
      },
    ]);

    expect(f.prepareCurrentHostClient).toHaveBeenCalledTimes(1);
    expect(f.launch.mock.calls[0]![0]).toMatchObject({
      currentHostPairing: {
        expectedHost: { serverId: "current-server", workspaceId: "ws-1" },
        rpcContractVersion: 1,
      },
    });
    expect(f.authorize.mock.invocationCallOrder.at(-1)).toBeLessThan(
      f.prepareCurrentHostClient.mock.invocationCallOrder[0]!
    );
  });

  it("releases a snapshot when exact-input authorization fails before provider handoff", async () => {
    const f = fixture();
    f.authorize
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
    await expect(
      f.definition.handler(context(), "launch", [
        {
          target: { kind: "isolated-host", client: "none", persistence: "ephemeral" },
          idempotencyKey: "denied",
        },
      ])
    ).rejects.toMatchObject({ code: "EACCES" });
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.failPreparation).toHaveBeenCalledTimes(1);
    expect(f.releaseSnapshot).not.toHaveBeenCalled();
  });

  it("filters status by exact owner and re-authorizes every selected launch", async () => {
    const f = fixture();
    await f.definition.handler(context(), "launch", [
      {
        target: { kind: "isolated-host", client: "none", persistence: "ephemeral" },
        idempotencyKey: "mine",
      },
    ]);
    f.records.push({
      ...f.records[0]!,
      launchId: "other",
      owner: { ...f.records[0]!.owner, principal: "user:other" },
    });
    const result = (await f.definition.handler(context(), "status", [
      undefined,
    ])) as DevLaunchStatus[];
    expect(result).toHaveLength(1);
    expect(result[0]!.launchId).not.toBe("other");
    expect(f.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "service:devHost.status" })
    );
  });

  it("child eval start addresses only the verified active generation", async () => {
    const f = fixture();
    const launch = (await f.definition.handler(context(), "launch", [
      {
        target: { kind: "isolated-host", client: "none", persistence: "retained" },
        idempotencyKey: "eval",
      },
    ])) as DevLaunchStatus;
    await expect(
      f.definition.handler(context(), "eval.start", [
        {
          launchId: launch.launchId,
          input: { source: { kind: "inline", code: "return 42" } },
        },
      ])
    ).resolves.toEqual({
      launchId: launch.launchId,
      hostBuildId: "host-build-1",
      sourceStateHash: "e".repeat(64),
      handle: {
        runId: "run-1",
        status: "accepted",
        acceptedAt: 1,
        startIntentDigest: "a".repeat(64),
      },
    });
    expect(f.evalStart).toHaveBeenCalledWith(
      launch.launchId,
      { source: { kind: "inline", code: "return 42" } },
      {
        payload: expect.any(String),
        signature: expect.any(String),
      }
    );
  });

  it("relays a child challenge only for its signed live run and active generation", async () => {
    const f = fixture();
    const launch = (await f.definition.handler(context(), "launch", [
      {
        target: { kind: "isolated-host", client: "none", persistence: "retained" },
        idempotencyKey: "eval-bridge",
      },
    ])) as DevLaunchStatus;
    await f.definition.handler(context(), "eval.start", [
      {
        launchId: launch.launchId,
        input: { source: { kind: "inline", code: "return 42" } },
      },
    ]);
    const authority = f.evalStart.mock.calls[0]![2];
    await expect(
      f.definition.handler(devHostExtensionContext(), "eval.confirmChildRoute", [
        {
          launchId: launch.launchId,
          hostBuildId: "host-build-1",
          processIdentity: "123:boot",
          authority,
        },
      ])
    ).resolves.toEqual({
      proof: { payload: expect.any(String), signature: expect.any(String) },
    });
    const challenge = {
      launchId: launch.launchId,
      hostBuildId: "host-build-1",
      processIdentity: "123:boot",
      runId: "run-1",
      challengeId: "approval-1",
      capability: "service:externalOpen.open",
      resource: {
        type: "url",
        label: "URL",
        value: "https://example.com",
        key: "https://example.com",
      },
      allowedDecisions: ["once", "run", "deny", "dismiss"],
      authority,
    } as const;
    await expect(
      f.definition.handler(devHostExtensionContext(), "eval.resolveChildChallenge", [challenge])
    ).resolves.toEqual({ decision: "once" });
    expect(f.resolveChildChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        challengeId: "approval-1",
        launch: expect.objectContaining({ activeHostBuildId: "host-build-1" }),
      })
    );

    await expect(
      f.definition.handler(devHostExtensionContext(), "eval.resolveChildChallenge", [
        { ...challenge, processIdentity: "999:stale" },
      ])
    ).rejects.toMatchObject({ code: "EVAL_INVOCATION_INVALID" });

    await expect(
      f.definition.handler(devHostExtensionContext(), "eval.completeChildRun", [
        {
          launchId: challenge.launchId,
          hostBuildId: challenge.hostBuildId,
          processIdentity: challenge.processIdentity,
          runId: challenge.runId,
          authority,
        },
      ])
    ).resolves.toEqual({ released: true });
    await expect(
      f.definition.handler(devHostExtensionContext(), "eval.resolveChildChallenge", [challenge])
    ).rejects.toMatchObject({ code: "EVAL_INVOCATION_INVALID" });
  });

  it("coalesces canonical context advances into an approval-pending exact candidate", async () => {
    const f = fixture();
    await f.definition.handler(context(), "launch", [
      {
        target: { kind: "isolated-host", client: "none", persistence: "ephemeral" },
        idempotencyKey: "watch",
      },
    ]);
    const createSnapshot = vi.fn(async ({ stateHash }: { stateHash: string }) => ({
      snapshotId: "candidate-snapshot",
      executionInputHash: "9".repeat(64) as never,
      source: {
        repoPath: "projects/vibestudio",
        stateHash: stateHash as never,
        sourceEv: "8".repeat(64) as never,
      },
      recipeDigest: "7".repeat(64) as never,
      sourceRoot: "/candidate/source",
      scratchRoot: "/candidate/scratch",
      manifestPath: "/candidate/snapshot.json",
      createdAt: 2,
    }));
    const watcher = new DevHostSourceWatcher({
      provider: f.provider,
      resolveSource: vi.fn(async () => ({ stateHash: "6".repeat(64), dirtyCount: 4 })),
      createSnapshot,
      releaseSnapshot: f.releaseSnapshot,
    });

    watcher.notify("ctx-owner");
    watcher.notify("ctx-owner");
    watcher.notify("ctx-owner");
    await watcher.settled();

    expect(createSnapshot).toHaveBeenCalledTimes(1);
    expect(f.prepare).toHaveBeenLastCalledWith({
      operation: "rebuild",
      request: expect.objectContaining({
        sourceStateHash: "6".repeat(64),
        dirtyCount: 4,
        snapshot: expect.objectContaining({ executionInputHash: "9".repeat(64) }),
      }),
    });
    expect(f.authorize).toHaveBeenCalledTimes(2);
  });
});
