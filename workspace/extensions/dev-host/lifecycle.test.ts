import { describe, expect, it, vi } from "vitest";
import type {
  DevHostProviderLaunchInput,
  DevHostProviderPreparationInput,
  DevLaunchStatus,
} from "@vibestudio/service-schemas/devHost";
import type {
  EvalParentAuthorityEnvelope,
  EvalStartInput,
} from "@vibestudio/service-schemas/eval";
import { DevHostLifecycle, type DevGeneration, type DevHostExecutor } from "./lifecycle.js";

const EVAL_AUTHORITY: EvalParentAuthorityEnvelope = {
  payload: "p".repeat(32),
  signature: "s".repeat(64),
};

function evalInput(code: string): EvalStartInput {
  return { source: { kind: "inline", code } };
}

const input = (state = "a".repeat(64)): DevHostProviderLaunchInput => ({
  launchId: "dev_launch",
  idempotencyKey: "stable",
  owner: { principal: "code:panels/agent@digest", workspaceId: "ws", contextId: "ctx" },
  sourceRepoPath: "projects/vibestudio",
  sourceStateHash: state,
  dirtyCount: 1,
  target: { kind: "isolated-host", client: "none", persistence: "ephemeral" },
  snapshot: {
    snapshotId: `snapshot-${state.slice(0, 4)}`,
    executionInputHash: state,
    recipeDigest: "b".repeat(64),
    sourceRoot: "/source",
    scratchRoot: "/scratch",
    manifestPath: "/snapshot.json",
    createdAt: 1,
  },
  executionGrant: { resource: `repo/execution:${state}`, authorizedAt: 1 },
  evalAuthorityBridge: { parentHostId: "parent-host", publicKeySpki: "public-key" },
});

function generation(launchId: string, build: string): DevGeneration {
  return {
    hostBuildId: build,
    readinessIdentity: {
      launchId,
      hostBuildId: build,
      serverId: `server-${build}`,
      endpoint: "http://127.0.0.1:1",
      evalAuthorityRecipientKey: null,
    },
    childWorkspaceId: "child-ws",
    childContextId: null,
    clientReadinessIdentity: null,
    processIdentity: `process-${build}`,
  };
}

function launchPreparation(candidate = input()): DevHostProviderPreparationInput {
  const { executionGrant: _grant, currentHostPairing: _pairing, ...request } = candidate;
  return { operation: "launch", request };
}

function rebuildPreparation(candidate: DevHostProviderLaunchInput): DevHostProviderPreparationInput {
  const {
    idempotencyKey: _key,
    executionGrant: _grant,
    currentHostPairing: _pairing,
    ...request
  } = candidate;
  return { operation: "rebuild", request };
}

function fixture() {
  let persisted: DevLaunchStatus[] = [];
  let preparations: import("@vibestudio/service-schemas/devHost").DevHostProviderPreparationInput[] = [];
  let build = 0;
  let restart = 0;
  let exitListener: ((exit: import("./lifecycle.js").DevGenerationExit) => void) | null = null;
  const logListeners = new Set<
    (launchId: string, entry: { seq: number; at: number; level: string; message: string }) => void
  >();
  let failSave: ((records: DevLaunchStatus[]) => boolean) | null = null;
  const executor: DevHostExecutor = {
    build: vi.fn(async () => ({ hostBuildId: `build-${++build}` })),
    validate: vi.fn(async () => undefined),
    start: vi.fn(async (candidate, hostBuildId) => generation(candidate.launchId, hostBuildId)),
    restart: vi.fn(async (active) => ({
      ...generation(active.readinessIdentity.launchId, active.hostBuildId),
      processIdentity: `process-${active.hostBuildId}-restart-${++restart}`,
    })),
    onUnexpectedExit: vi.fn((listener) => {
      exitListener = listener;
      return () => {
        if (exitListener === listener) exitListener = null;
      };
    }),
    stop: vi.fn(async () => undefined),
    rollbackCandidate: vi.fn(async (_candidate, previous) => previous),
    commitPromotion: vi.fn(async () => undefined),
    discard: vi.fn(async () => undefined),
    evalStart: vi.fn(async (active) => ({
      runId: `run-${active.hostBuildId}`,
      status: "accepted" as const,
      acceptedAt: 1,
      startIntentDigest: "d".repeat(64),
    })),
    evalGet: vi.fn(async () => {
      throw new Error("evalGet is not used by this fixture");
    }),
    evalEvents: vi.fn(async () => ({ events: [], next: 0 })),
    evalCancel: vi.fn(async () => ({ status: "terminal" as const })),
    logs: vi.fn(() => []),
    onLog: vi.fn((listener) => {
      logListeners.add(listener);
      return () => logListeners.delete(listener);
    }),
    appendLog: vi.fn(),
    reconcilePersisted: vi.fn(async () => ({ status: "not-running" as const })),
  };
  const lifecycle = new DevHostLifecycle(
    {
      load: async () => structuredClone(persisted),
      save: async (records) => {
        if (failSave?.(records)) {
          failSave = null;
          throw Object.assign(new Error("durable promotion write failed"), {
            code: "STORE_WRITE_FAILED",
          });
        }
        persisted = structuredClone(records);
      },
      loadPreparations: async () => structuredClone(preparations),
      savePreparations: async (records) => {
        preparations = structuredClone(records);
      },
    },
    executor,
    (() => {
      let now = 0;
      return () => ++now;
    })(),
    { maximumCrashes: 5, windowMs: 60_000, delay: async () => undefined }
  );
  return {
    lifecycle,
    executor,
    persisted: () => persisted,
    preparations: () => preparations,
    failNextSaveWhen(predicate: (records: DevLaunchStatus[]) => boolean) {
      failSave = predicate;
    },
    emitExit(active: DevGeneration) {
      if (!exitListener) throw new Error("Unexpected-exit listener is not registered");
      exitListener({
        launchId: active.readinessIdentity.launchId,
        hostBuildId: active.hostBuildId,
        processIdentity: active.processIdentity,
        code: 1,
        signal: null,
      });
    },
    emitLog(launchId: string, entry: { seq: number; at: number; level: string; message: string }) {
      for (const listener of logListeners) listener(launchId, entry);
    },
  };
}

describe("DevHostLifecycle", () => {
  it("publishes awaiting approval before execution and releases a denied snapshot", async () => {
    const f = fixture();
    await f.lifecycle.start();
    const preparation = launchPreparation();
    await expect(f.lifecycle.prepare(preparation)).resolves.toMatchObject({
      proceed: true,
      status: { state: "awaiting-approval", activeHostBuildId: null },
    });
    expect(f.executor.build).not.toHaveBeenCalled();
    await expect(
      f.lifecycle.failPreparation(preparation, {
        phase: "approval",
        code: "EACCES",
        message: "denied",
      })
    ).resolves.toMatchObject({ state: "failed", lastError: { code: "EACCES" } });
    expect(f.executor.discard).toHaveBeenCalledWith(preparation.request);
    expect(f.preparations()).toEqual([]);
  });

  it("keeps the active generation available while a rebuild awaits approval", async () => {
    const f = fixture();
    await f.lifecycle.start();
    const active = await f.lifecycle.launch(input());
    const preparation = rebuildPreparation(input("c".repeat(64)));
    await expect(f.lifecycle.prepare(preparation)).resolves.toMatchObject({
      proceed: true,
      status: {
        state: "awaiting-candidate-approval",
        activeHostBuildId: active.activeHostBuildId,
        sourceStateHash: active.sourceStateHash,
        candidateSourceStateHash: "c".repeat(64),
      },
    });
    await expect(
      f.lifecycle.evalStart(active.launchId, evalInput("return old"), EVAL_AUTHORITY)
    ).resolves.toMatchObject({ runId: "run-build-1" });
    await f.lifecycle.failPreparation(preparation, {
      phase: "approval",
      code: "EACCES",
      message: "denied",
    });
    await expect(
      f.lifecycle.evalStart(active.launchId, evalInput("return old"), EVAL_AUTHORITY)
    ).resolves.toMatchObject({ runId: "run-build-1" });
  });

  it("supersedes a pending candidate with the latest state and resumes its exact snapshot", async () => {
    const f = fixture();
    await f.lifecycle.start();
    await f.lifecycle.launch(input());
    const first = rebuildPreparation(input("c".repeat(64)));
    const latest = rebuildPreparation(input("d".repeat(64)));
    await f.lifecycle.prepare(first);
    const prepared = await f.lifecycle.prepare(latest);
    expect(prepared).toMatchObject({
      proceed: true,
      request: { sourceStateHash: "d".repeat(64) },
      status: {
        state: "awaiting-candidate-approval",
        candidateSourceStateHash: "d".repeat(64),
      },
    });
    expect(f.executor.discard).toHaveBeenCalledWith(first.request);

    const retry = structuredClone(latest);
    retry.request.snapshot.snapshotId = "later-materialization-of-the-same-state";
    const resumed = await f.lifecycle.prepare(retry);
    expect(resumed).toMatchObject({
      proceed: true,
      request: { snapshot: { snapshotId: latest.request.snapshot.snapshotId } },
    });
    expect(f.executor.discard).toHaveBeenCalledWith(retry.request);
  });

  it("cleans an interrupted pending approval during restart recovery", async () => {
    const f = fixture();
    await f.lifecycle.start();
    const preparation = launchPreparation();
    await f.lifecycle.prepare(preparation);
    const restarted = new DevHostLifecycle(
      {
        load: async () => f.persisted(),
        save: async () => undefined,
        loadPreparations: async () => f.preparations(),
        savePreparations: async () => undefined,
      },
      f.executor,
      () => 50
    );
    await restarted.start();
    expect(restarted.status()[0]).toMatchObject({
      state: "failed",
      lastError: { code: "APPROVAL_INTERRUPTED" },
    });
    expect(f.executor.discard).toHaveBeenCalledWith(preparation.request);
  });

  it("serializes an idempotent launch through exact candidate promotion", async () => {
    const f = fixture();
    await f.lifecycle.start();
    const [first, second] = await Promise.all([
      f.lifecycle.launch(input()),
      f.lifecycle.launch(input()),
    ]);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ state: "ready", activeHostBuildId: "build-1" });
    expect(f.executor.build).toHaveBeenCalledTimes(1);
    expect(f.executor.discard).toHaveBeenCalledTimes(1);
    expect(f.persisted()[0]?.state).toBe("ready");
  });

  it("rejects reuse of a launch id for a different exact snapshot", async () => {
    const f = fixture();
    await f.lifecycle.start();
    await f.lifecycle.launch(input());
    await expect(f.lifecycle.launch(input("c".repeat(64)))).rejects.toMatchObject({
      code: "EIDEMPOTENCY",
    });
    expect(f.executor.build).toHaveBeenCalledTimes(1);
    expect(f.executor.discard).toHaveBeenCalledWith(
      expect.objectContaining({ sourceStateHash: "c".repeat(64) })
    );
  });

  it("coalesces a rebuild that already matches the active exact input", async () => {
    const f = fixture();
    await f.lifecycle.start();
    await f.lifecycle.launch(input());
    await expect(
      f.lifecycle.rebuild({ ...input(), idempotencyKey: undefined } as never)
    ).resolves.toMatchObject({ active: true, state: "ready", hostBuildId: "build-1" });
    expect(f.executor.build).toHaveBeenCalledTimes(1);
    expect(f.executor.discard).toHaveBeenCalledTimes(1);
  });

  it("keeps every last-good label and process when a rebuild candidate fails", async () => {
    const f = fixture();
    await f.lifecycle.start();
    const active = await f.lifecycle.launch(input());
    vi.mocked(f.executor.validate).mockRejectedValueOnce(
      Object.assign(new Error("artifact probe failed"), { code: "PROBE_FAILED" })
    );
    const next = input("c".repeat(64));
    const result = await f.lifecycle.rebuild({ ...next, idempotencyKey: undefined } as never);
    const status = f.lifecycle.status()[0]!;
    expect(result).toMatchObject({
      state: "candidate-failed",
      active: false,
      hostBuildId: "build-1",
    });
    expect(status).toMatchObject({
      sourceStateHash: active.sourceStateHash,
      executionInputHash: active.executionInputHash,
      activeHostBuildId: "build-1",
      candidateHostBuildId: null,
      lastError: { code: "PROBE_FAILED" },
    });
    await expect(
      f.lifecycle.evalStart(status.launchId, evalInput("return 42"), EVAL_AUTHORITY)
    ).resolves.toMatchObject({ runId: "run-build-1" });
    expect(f.executor.stop).not.toHaveBeenCalled();
    expect(f.executor.discard).toHaveBeenCalledWith(
      expect.objectContaining({ sourceStateHash: "c".repeat(64) }),
      "build-2"
    );
  });

  it("retires an uncommitted candidate and restores last-good after promotion persistence fails", async () => {
    const f = fixture();
    await f.lifecycle.start();
    const active = await f.lifecycle.launch(input());
    f.failNextSaveWhen(
      (records) => records[0]?.state === "ready" && records[0]?.activeHostBuildId === "build-2"
    );

    const result = await f.lifecycle.rebuild({
      ...input("c".repeat(64)),
      idempotencyKey: undefined,
    } as never);

    expect(result).toMatchObject({
      state: "candidate-failed",
      hostBuildId: active.activeHostBuildId,
      active: false,
    });
    expect(f.executor.rollbackCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ hostBuildId: "build-2" })
      ,
      expect.objectContaining({ hostBuildId: "build-1" })
    );
    await expect(
      f.lifecycle.evalStart(active.launchId, evalInput("return old"), EVAL_AUTHORITY)
    ).resolves.toMatchObject({ runId: "run-build-1" });
  });

  it("records actionable recovery state when candidate rollback itself fails", async () => {
    const f = fixture();
    await f.lifecycle.start();
    await f.lifecycle.launch(input());
    vi.mocked(f.executor.validate).mockRejectedValueOnce(new Error("candidate invalid"));
    vi.mocked(f.executor.rollbackCandidate).mockRejectedValueOnce(
      Object.assign(new Error("retained backup corrupted"), {
        code: "RETAINED_ROLLBACK_INTEGRITY",
      })
    );
    const result = await f.lifecycle.rebuild({
      ...input("c".repeat(64)),
      idempotencyKey: undefined,
    } as never);
    expect(result).toMatchObject({
      state: "failed",
    });
    expect(f.lifecycle.status()[0]).toMatchObject({
      lastError: {
        phase: "rollback",
        code: "RETAINED_ROLLBACK_INTEGRITY",
        message: expect.stringContaining("could not be restored"),
      },
    });
  });

  it("fails closed on restart when a persisted live process cannot be re-verified", async () => {
    const f = fixture();
    await f.lifecycle.start();
    await f.lifecycle.launch(input());
    const restarted = new DevHostLifecycle(
      {
        load: async () => f.persisted(),
        save: async () => undefined,
        loadPreparations: async () => [],
        savePreparations: async () => undefined,
      },
      f.executor,
      () => 20
    );
    await restarted.start();
    expect(restarted.status()[0]).toMatchObject({
      state: "failed",
      lastError: { phase: "recovery", code: "PROCESS_NOT_RUNNING" },
    });
  });

  it("reattaches a recovered retained generation as the active last-good process", async () => {
    const f = fixture();
    await f.lifecycle.start();
    const active = await f.lifecycle.launch(input());
    const recovered = generation(active.launchId, active.activeHostBuildId!);
    vi.mocked(f.executor.reconcilePersisted).mockResolvedValueOnce({
      status: "recovered",
      generation: recovered,
    });
    const restarted = new DevHostLifecycle(
      {
        load: async () => f.persisted(),
        save: async () => undefined,
        loadPreparations: async () => [],
        savePreparations: async () => undefined,
      },
      f.executor,
      () => 20
    );
    await restarted.start();
    expect(restarted.status()[0]).toMatchObject({
      state: "ready",
      activeHostBuildId: "build-1",
      processIdentity: recovered.processIdentity,
      lastError: null,
    });
    await expect(
      restarted.evalStart(active.launchId, evalInput("return 1"), EVAL_AUTHORITY)
    ).resolves.toMatchObject({ runId: "run-build-1" });
  });

  it("restarts the exact active build after an unexpected managed-process exit", async () => {
    const f = fixture();
    await f.lifecycle.start();
    const launched = await f.lifecycle.launch(input());
    f.emitExit(generation(launched.launchId, launched.activeHostBuildId!));

    await vi.waitFor(() => {
      expect(f.lifecycle.status()[0]).toMatchObject({
        state: "ready",
        activeHostBuildId: "build-1",
        sourceStateHash: input().sourceStateHash,
        restartCount: 1,
        processIdentity: "process-build-1-restart-1",
        lastError: null,
      });
    });
    expect(f.executor.restart).toHaveBeenCalledWith(
      expect.objectContaining({ hostBuildId: "build-1", processIdentity: "process-build-1" })
    );
  });

  it("fails visibly when an exact-generation restart cannot become ready", async () => {
    const f = fixture();
    await f.lifecycle.start();
    const launched = await f.lifecycle.launch(input());
    vi.mocked(f.executor.restart).mockRejectedValueOnce(
      Object.assign(new Error("ready probe timed out"), { code: "READY_TIMEOUT" })
    );
    f.emitExit(generation(launched.launchId, launched.activeHostBuildId!));

    await vi.waitFor(() => {
      expect(f.lifecycle.status()[0]).toMatchObject({
        state: "failed",
        activeHostBuildId: "build-1",
        processIdentity: null,
        restartCount: 1,
        lastError: { phase: "restart", code: "READY_TIMEOUT" },
      });
    });
  });

  it("streams resumable NDJSON lifecycle events and redacted executor logs", async () => {
    const f = fixture();
    await f.lifecycle.start();
    const launched = await f.lifecycle.launch(input());
    const decoder = new TextDecoder();

    const events = f.lifecycle.watch(launched.launchId, 0);
    expect(events.headers.get("content-type")).toContain("application/x-ndjson");
    const eventReader = events.body!.getReader();
    const firstEvent = await eventReader.read();
    expect(JSON.parse(decoder.decode(firstEvent.value))).toMatchObject({
      seq: 1,
      state: "snapshotting",
    });
    await eventReader.cancel();

    const logs = f.lifecycle.logs(launched.launchId, 0);
    const logReader = logs.body!.getReader();
    f.emitLog(launched.launchId, {
      seq: 1,
      at: 10,
      level: "stdout",
      message: "candidate ready",
    });
    const firstLog = await logReader.read();
    expect(JSON.parse(decoder.decode(firstLog.value))).toEqual({
      seq: 1,
      at: 10,
      level: "stdout",
      message: "candidate ready",
    });
    await logReader.cancel();
  });
});
