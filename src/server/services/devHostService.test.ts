import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import {
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
      requested: [
        { capability: "service:devHost.launch", resource: { kind: "prefix", prefix: "" } },
        { capability: "service:devHost.status", resource: { kind: "prefix", prefix: "" } },
        { capability: "service:devHost.eval", resource: { kind: "prefix", prefix: "" } },
      ],
    }),
  };
}

function fixture() {
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
    eval: vi.fn(async (_launchId, code) => ({ observed: code })),
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
  const definition = createDevHostService({
    workspaceId: "ws-1",
    resolveCallerContext: (id) => (id === "panel:owner" ? "ctx-owner" : "ctx-other"),
    resolveSource: vi.fn(async () => ({ stateHash: "e".repeat(64), dirtyCount: 3 })),
    createSnapshot,
    releaseSnapshot,
    prepareCurrentHostClient,
    authorize,
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

  it("direct eval addresses only the verified active generation", async () => {
    const f = fixture();
    const launch = (await f.definition.handler(context(), "launch", [
      {
        target: { kind: "isolated-host", client: "none", persistence: "retained" },
        idempotencyKey: "eval",
      },
    ])) as DevLaunchStatus;
    await expect(
      f.definition.handler(context(), "eval", [{ launchId: launch.launchId, code: "return 42" }])
    ).resolves.toEqual({
      launchId: launch.launchId,
      hostBuildId: "host-build-1",
      sourceStateHash: "e".repeat(64),
      result: { observed: "return 42" },
    });
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
