/**
 * Eval cancellation + forced recovery.
 *
 * Covers the run-chain hardening:
 *  - `cancel(runId)`: an in-flight run wedged on an outbound rpc.call unwinds once cancelled (its
 *    abort signal — threaded into `runLocked` — fires and the run rejects), and the CAS to
 *    `cancelled` makes a late finish lose so it can never resurrect itself `done`.
 *  - `forceReset()`: a WEDGED run holding `runChain` does NOT block a subsequently-enqueued run
 *    (the chain is REPLACED, not `.then()`'d off), and user tables + scope are cleared immediately.
 *
 * The EvalDO's heavy engine (a workerd build of `@workspace/eval`) is NOT instantiated here — we
 * override `runLocked` to simulate a run that blocks until its threaded abort signal fires, which is
 * EXACTLY what a real outbound `rpc.call` does on abort (rpc client.ts rejects the pending request
 * when `options.signal` aborts). So this faithfully exercises `runEval`'s controller wiring, the CAS
 * persist, and the `cancel`/`forceReset`/run-chain machinery — the code under change.
 *
 * Recovery tests use abort/forced-reset directly; one expired-deadline regression
 * verifies cleanup failures still reach a durable terminal result.
 */
import { describe, expect, it, vi } from "vitest";
import { createTestDO } from "@vibestudio/durable/test-utils";
import type { RpcCallOptions } from "@vibestudio/rpc";
import { executionSessionNonceFor } from "@vibestudio/rpc/internal";
import { EVAL_ENGINE_HOST_CONTRACT_VERSION } from "@vibestudio/service-schemas/evalEngine";
import type { Sha256 } from "@vibestudio/shared/execution/identity";
import {
  executionArtifactDigest,
  executionSourceClosureDigest,
  type ExecutionArtifactRefV1,
} from "@vibestudio/shared/execution/retention";
import { EvalDO } from "./EvalDO.js";

type RunResult = {
  success: boolean;
  console: string;
  returnValue?: unknown;
  error?: string;
  failureCode?: string;
};
type RunLockedFn = (args: unknown, signal?: AbortSignal, runId?: string) => Promise<RunResult>;

/** Access a private method/field on the instance without TS visibility friction (test-only). */
function priv<T = unknown>(instance: object, key: string): T {
  return (instance as unknown as Record<string, unknown>)[key] as T;
}
function setPriv(instance: object, key: string, value: unknown): void {
  (instance as unknown as Record<string, unknown>)[key] = value;
}

function executionArtifact(seed = "e"): ExecutionArtifactRefV1 {
  const effectiveVersion = seed.repeat(64) as Sha256;
  const buildKey = (seed === "e" ? "b" : seed).repeat(64) as Sha256;
  const artifactDigest = (seed === "e" ? "a" : seed).repeat(64) as Sha256;
  const contentRoots = [
    {
      repoPath: "packages/example",
      stateHash: `state:${(seed === "e" ? "c" : seed).repeat(64)}`,
    },
  ];
  return {
    version: 1,
    sourceState: {
      kind: "workspace",
      workspaceId: "workspace:test",
      effectiveVersion,
      state: { kind: "event", eventId: `event:test:${seed}` },
      contentRoots,
      sourceClosureDigest: executionSourceClosureDigest(contentRoots),
    },
    recipeDigest: buildKey,
    buildKey,
    artifactDigest,
    executionDigest: executionArtifactDigest({
      version: 1,
      sourceState: {
        kind: "workspace",
        workspaceId: "workspace:test",
        effectiveVersion,
        state: { kind: "event", eventId: `event:test:${seed}` },
        contentRoots,
        sourceClosureDigest: executionSourceClosureDigest(contentRoots),
      },
      recipeDigest: buildKey,
      buildKey,
      artifactDigest,
    }),
  };
}

/**
 * A run that BLOCKS until its threaded abort signal fires, then rejects — mirroring a real outbound
 * rpc.call wedged on a never-returning peer (the rpc client rejects the pending request on abort).
 * Resolves the returned `started` promise once the run is actually executing so tests can sequence.
 */
function blockUntilAborted(): {
  runLocked: RunLockedFn;
  started: Promise<{ signal: AbortSignal | undefined; runId: string | undefined }>;
} {
  let resolveStarted!: (v: { signal: AbortSignal | undefined; runId: string | undefined }) => void;
  const started = new Promise<{ signal: AbortSignal | undefined; runId: string | undefined }>(
    (r) => (resolveStarted = r)
  );
  const runLocked: RunLockedFn = (_args, signal, runId) =>
    new Promise<RunResult>((_resolve, reject) => {
      resolveStarted({ signal, runId });
      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  return { runLocked, started };
}

/** Insert a pending run row directly (bypasses the schema-validated service so the DO is exercised). */
function seedPendingRun(
  sql: { exec: (q: string, ...b: unknown[]) => unknown },
  runId: string,
  args: Record<string, unknown> = { code: "return 1;", contextId: "ctx" }
): void {
  const normalizedArgs = {
    intentDigest: "i".repeat(64),
    scopeInputRevision: "scope:initial",
    runDigest: "r".repeat(64),
    ...args,
  };
  sql.exec(
    `INSERT INTO runs (run_id, args, agent_ref, channel_id, status, started_at, deadline_at)
     VALUES (?, ?, NULL, NULL, 'pending', ?, NULL)`,
    runId,
    JSON.stringify(normalizedArgs),
    Date.now()
  );
}

function redeliveryState(sql: {
  exec: (query: string, ...bindings: unknown[]) => { toArray(): Record<string, unknown>[] };
}): Record<string, number> {
  return Object.fromEntries(
    sql
      .exec(`SELECT run_id, attempt FROM eval_result_redeliveries ORDER BY run_id`)
      .toArray()
      .map((row) => [String(row["run_id"]), Number(row["attempt"])])
  );
}

describe("EvalDO cancellation + forced recovery", () => {
  it("rejects an incompatible workspace eval engine before executing a cell", async () => {
    const { instance } = await createTestDO(EvalDO);
    (instance as unknown as { env: Record<string, unknown> }).env["EVAL_ENGINE_SOURCE"] =
      "@workspace/eval";
    const ensureEngine = priv<(execution: unknown) => Promise<unknown>>(instance, "ensureEngine");

    setPriv(instance, "loadLibraryModule", vi.fn(async () => ({})));
    await expect(ensureEngine.call(instance, {})).rejects.toThrow(
      /uses host contract undefined; this runtime requires 1/
    );

    setPriv(
      instance,
      "loadLibraryModule",
      vi.fn(async () => ({ EVAL_ENGINE_HOST_CONTRACT_VERSION: 2 }))
    );
    await expect(ensureEngine.call(instance, {})).rejects.toThrow(
      /uses host contract 2; this runtime requires 1/
    );

    const compatible = { EVAL_ENGINE_HOST_CONTRACT_VERSION };
    setPriv(instance, "loadLibraryModule", vi.fn(async () => compatible));
    await expect(ensureEngine.call(instance, {})).resolves.toBe(compatible);
  });

  it("injects resident delivery registration from the exact EvalDO activation", async () => {
    const { instance } = await createTestDO(EvalDO);
    const activeExecution = priv<{
      run<T>(store: unknown, callback: () => T): T;
    }>(instance, "activeEvalExecution");
    const runtimeRpc = priv<
      () => {
        registerResidentSession(
          channelId: string,
          receiver: (payload: unknown) => void | Promise<void>,
          relationship: { targetId: string }
        ): {
          transport: {
            call<T = unknown>(targetId: string, method: string, args: unknown[]): Promise<T>;
          };
          close(): void | Promise<void>;
        };
      }
    >(instance, "createActiveRuntimeRpc").call(instance);
    const received: unknown[] = [];
    const contextualCall = vi.fn(
      (target: string, method: string, _args: unknown[], _options?: unknown) => {
        if (target === "main" && method === "workers.resolveService") {
          return Promise.resolve({ kind: "durable-object", targetId: "channel-target" });
        }
        if (target === "channel-target" && method === "detach") return Promise.resolve(undefined);
        return Promise.resolve("context-restored");
      }
    );
    const residentSessionCleanups = new Set<() => Promise<void>>();
    const execution = {
      rpc: { call: contextualCall },
      residentSessionCleanups,
    };
    let registration!: ReturnType<typeof runtimeRpc.registerResidentSession>;
    registration = activeExecution.run(execution, () =>
      runtimeRpc.registerResidentSession(
        "channel-eval",
        async (payload) => {
          received.push(payload);
          await registration.transport.call("target", "method", []);
        },
        { targetId: "channel-target" }
      )
    );

    await expect(
      instance.acceptChannelDelivery({
        deliveryId: "delivery-eval",
        channelId: "channel-eval",
        channelRef: {
          source: "workers/pubsub-channel",
          className: "PubSubChannel",
          objectKey: "channel-eval",
        },
        participantId: "do:test:EvalDO:test-key",
        subscriptionRevision: 1,
        eventSequence: 1,
        envelope: { kind: "message.completed" },
        agenticContext: null,
      })
    ).resolves.toEqual({
      processed: true,
      recipientExecutionStartedAt: expect.any(Number),
    });
    expect(received).toEqual([
      {
        channelId: "channel-eval",
        message: { kind: "message.completed" },
      },
    ]);
    expect(contextualCall).toHaveBeenCalledWith("target", "method", []);

    await priv<(execution: unknown) => Promise<void>>(instance, "settleResidentSessions").call(
      instance,
      execution
    );
    expect(residentSessionCleanups.size).toBe(0);
    expect(contextualCall).toHaveBeenCalledWith("channel-target", "detach", [
      { participantId: "do:test:TestDO:test-key" },
    ]);
    await expect(
      instance.acceptChannelDelivery({
        deliveryId: "delivery-eval-after-terminal",
        channelId: "channel-eval",
        channelRef: {
          source: "workers/pubsub-channel",
          className: "PubSubChannel",
          objectKey: "channel-eval",
        },
        participantId: "do:test:EvalDO:test-key",
        subscriptionRevision: 1,
        eventSequence: 2,
        envelope: { kind: "message.completed" },
        agenticContext: null,
      })
    ).rejects.toMatchObject({ code: "ResidentSessionUnavailable" });
  });

  it("records kernel incarnations and emits one exact recovery event after reconstruction", async () => {
    const first = await createTestDO(EvalDO);
    setPriv(first.instance, "scopeRecovery", {
      restored: [],
      lost: [],
    });
    const firstStatus = priv<
      () => {
        incarnationId: string;
        event?: { kind: string };
      }
    >(first.instance, "kernelStatusForRun").call(first.instance);
    expect(firstStatus.event?.kind).toBe("started");

    const second = await createTestDO(EvalDO, undefined, { db: first.db });
    setPriv(second.instance, "scopeRecovery", {
      restored: ["panelId"],
      lost: ["panelHandle"],
    });
    const restarted = priv<
      () => {
        incarnationId: string;
        event?: {
          kind: string;
          recovery: { status: string; restored?: string[]; lost?: string[] };
        };
      }
    >(second.instance, "kernelStatusForRun").call(second.instance);

    expect(restarted.incarnationId).not.toBe(firstStatus.incarnationId);
    expect(restarted.event).toEqual({
      kind: "restarted",
      recovery: {
        status: "complete",
        restored: ["panelId"],
        lost: ["panelHandle"],
      },
    });
    expect(
      priv<() => { event?: unknown }>(second.instance, "kernelStatusForRun").call(second.instance)
    ).not.toHaveProperty("event");
  });

  it("holds one notebook kernel across cells until its refreshed idle lease expires", async () => {
    vi.useFakeTimers();
    try {
      const { instance } = await createTestDO(EvalDO);
      const lifecycleCall = vi.fn(() => Promise.resolve(undefined));
      Object.defineProperty(instance, "rpc", {
        value: { call: lifecycleCall },
        configurable: true,
      });
      const first = instance.acquireKernelLease({ leaseId: "kernel-1", idleMs: 1_000 });
      await instance.attachKernelLeaseHolder("kernel-1");
      const held = instance.holdKernelLease("kernel-1");

      await vi.advanceTimersByTimeAsync(750);
      const refreshed = instance.acquireKernelLease({ leaseId: "kernel-1", idleMs: 1_000 });
      expect(refreshed.expiresAt).toBeGreaterThan(first.expiresAt);

      await vi.advanceTimersByTimeAsync(750);
      let settled = false;
      void held.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(250);
      await expect(held).resolves.toEqual({ leaseId: "kernel-1", reason: "expired" });
      expect(lifecycleCall).toHaveBeenNthCalledWith(
        1,
        "main",
        "workspace-state.lifecycleLeaseUpsert",
        [
          expect.objectContaining({
            detail: {
              kind: "eval-kernel",
              leaseId: "kernel-1",
            },
          }),
        ]
      );
      expect(lifecycleCall).toHaveBeenNthCalledWith(
        2,
        "main",
        "workspace-state.lifecycleLeaseClear",
        [expect.any(Object)]
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the inter-cell kernel hold during planned lifecycle shutdown", async () => {
    const { instance } = await createTestDO(EvalDO);
    const lifecycleCall = vi.fn(() => Promise.resolve(undefined));
    Object.defineProperty(instance, "rpc", {
      value: { call: lifecycleCall },
      configurable: true,
    });
    instance.acquireKernelLease({ leaseId: "kernel-1", idleMs: 60_000 });
    await instance.attachKernelLeaseHolder("kernel-1");
    const held = instance.holdKernelLease("kernel-1");

    await expect(
      instance.releaseForLifecycle({
        epoch: "e1",
        mode: "suspend",
        reason: "test",
        deadlineMs: 1_000,
      })
    ).resolves.toEqual({ status: "ready" });
    await expect(held).resolves.toEqual({ leaseId: "kernel-1", reason: "released" });
    expect(lifecycleCall).toHaveBeenLastCalledWith("main", "workspace-state.lifecycleLeaseClear", [
      expect.any(Object),
    ]);
  });

  it("retires resident channels through their recorded target without contextual rediscovery", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    sql.exec(
      `INSERT INTO resident_channel_memberships (channel_id, target_id, registered_at)
       VALUES ('channel-retire', 'channel-target', 1),
              ('channel-gone', 'retired-target', 1)`
    );
    const lifecycleCall = vi.fn((targetId: string, method: string) => {
      if (targetId === "retired-target" && method === "relationshipState") {
        return Promise.reject(
          Object.assign(new Error("retired"), { code: "DURABLE_OBJECT_RETIRED" })
        );
      }
      if (targetId === "channel-target" && method === "relationshipState") {
        return Promise.resolve({ revision: 4, active: true });
      }
      if (targetId === "channel-target" && method === "leave") {
        return Promise.resolve({ revision: 5 });
      }
      return Promise.resolve(undefined);
    });
    Object.defineProperty(instance, "rpc", {
      value: { selfId: "do:test:EvalDO:test-key", call: lifecycleCall },
      configurable: true,
    });

    await expect(
      instance.releaseForLifecycle({
        epoch: "e-resident",
        mode: "retire",
        reason: "test",
        deadlineMs: 1_000,
      })
    ).resolves.toEqual({ status: "ready" });

    expect(lifecycleCall).not.toHaveBeenCalledWith(
      "main",
      "workers.resolveService",
      expect.anything()
    );
    expect(lifecycleCall).toHaveBeenCalledWith("channel-target", "relationshipState", [
      "do:test:EvalDO:test-key",
    ]);
    expect(lifecycleCall).toHaveBeenCalledWith("channel-target", "leave", [
      { participantId: "do:test:EvalDO:test-key", revision: 5 },
    ]);
    expect(sql.exec(`SELECT * FROM resident_channel_memberships`).toArray()).toEqual([]);
  });

  it("cancels active durable runs before claiming lifecycle release", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    const lifecycleCall = vi.fn(() => Promise.resolve(undefined));
    Object.defineProperty(instance, "rpc", {
      value: { call: lifecycleCall },
      configurable: true,
    });
    const { runLocked, started } = blockUntilAborted();
    setPriv(instance, "runLocked", runLocked);

    instance.acquireKernelLease({ leaseId: "kernel-active", idleMs: 60_000 });
    await instance.attachKernelLeaseHolder("kernel-active");
    const held = instance.holdKernelLease("kernel-active");
    seedPendingRun(sql, "lifecycle-active-run");
    const run = priv<(id: string) => Promise<RunResult>>(instance, "executeRun").call(
      instance,
      "lifecycle-active-run"
    );
    await started;

    await expect(
      instance.releaseForLifecycle({
        epoch: "e-active",
        mode: "suspend",
        reason: "test",
        deadlineMs: 1_000,
      })
    ).resolves.toEqual({ status: "ready" });
    await expect(run).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/runtime generation was retired/i),
      failureKind: "infrastructure",
      failureCode: "runtime_generation_lost",
    });
    expect(instance.getRun("lifecycle-active-run")).toMatchObject({ status: "cancelled" });
    await expect(held).resolves.toEqual({
      leaseId: "kernel-active",
      reason: "released",
    });
  });

  it("serializes live event delivery and permits only cleanup/diagnostic tails after terminal", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    seedPendingRun(sql, "event-order", {
      executionSessionNonce: "session-order-123456",
      eventSinkNonce: "sink-order-123456",
    });
    let releaseFirst!: () => void;
    const firstDelivery = new Promise<{ delivered: boolean }>(
      (resolve) => (releaseFirst = () => resolve({ delivered: false }))
    );
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => (firstStarted = resolve));
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const rpcCall = vi.fn((_target: string, method: string, args: unknown[]) => {
      calls.push({ method, args });
      if (calls.length === 1) {
        firstStarted();
        return firstDelivery;
      }
      return Promise.resolve({ delivered: false });
    });
    Object.defineProperty(instance, "rpc", {
      value: { call: rpcCall },
      configurable: true,
    });
    const append = priv<(runId: string, kind: string, payload: unknown) => void>(
      instance,
      "appendRunEvent"
    );
    const drain = priv<(runId: string) => Promise<void>>(instance, "drainLiveEventDelivery");

    append.call(instance, "event-order", "state", { status: "running" });
    append.call(instance, "event-order", "progress", { step: 1 });
    await firstStartedPromise;
    expect(calls).toHaveLength(1);

    releaseFirst();
    await drain.call(instance, "event-order");
    expect(calls).toHaveLength(2);

    append.call(instance, "event-order", "state", { status: "succeeded" });
    await drain.call(instance, "event-order");
    append.call(instance, "event-order", "progress", { step: 2 });
    append.call(instance, "event-order", "state", { status: "running" });
    append.call(instance, "event-order", "cleanup", { status: "settled" });
    await Promise.resolve();
    expect(calls).toHaveLength(3);
    expect(
      sql
        .exec(`SELECT kind, payload FROM run_events WHERE run_id = 'event-order' ORDER BY sequence`)
        .toArray()
        .map((row) => ({ kind: row["kind"], payload: JSON.parse(String(row["payload"])) }))
    ).toEqual([
      { kind: "state", payload: { status: "running" } },
      { kind: "progress", payload: { step: 1 } },
      { kind: "state", payload: { status: "succeeded" } },
      { kind: "cleanup", payload: { status: "settled" } },
    ]);
  });

  it("does not execute or emit running for a run already owned by another incarnation", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    seedPendingRun(sql, "already-running");
    sql.exec(`UPDATE runs SET status = 'running' WHERE run_id = 'already-running'`);
    const runLocked = vi.fn();
    setPriv(instance, "runLocked", runLocked);

    await expect(instance.executeRun("already-running")).resolves.toMatchObject({
      success: false,
      failureCode: "eval_invalid_run_state",
    });
    expect(runLocked).not.toHaveBeenCalled();
    expect(
      sql.exec(`SELECT * FROM run_events WHERE run_id = 'already-running'`).toArray()
    ).toHaveLength(0);
  });

  it("runs startRun in the DO lifetime and delivers its terminal result directly to its agent", async () => {
    const { instance } = await createTestDO(EvalDO);
    const call = vi.fn(() => Promise.resolve(undefined));
    Object.defineProperty(instance, "rpc", { value: { call }, configurable: true });
    setPriv(instance, "runLocked", () =>
      Promise.resolve({ success: true, console: "ok", returnValue: 7 })
    );

    await instance.startRun({
      runId: "background-run",
      code: "return 7",
      agentRef: "do:workers/agent-worker:AiChatWorker:agent-1",
      resultReceiverRef: "do:workers/agent-worker:AiChatWorker:agent-1",
      agentInvocationId: "invocation-1",
      channelId: "channel-1",
      executionSessionNonce: "session-background-123456",
    });

    await vi.waitFor(() => {
      expect(instance.getRun("background-run")).toMatchObject({
        status: "done",
        result: { success: true, returnValue: 7 },
      });
    });
    expect(call).toHaveBeenCalledWith(
      "do:workers/agent-worker:AiChatWorker:agent-1",
      "onEvalComplete",
      [
        expect.objectContaining({
          runId: "background-run",
          agentInvocationId: "invocation-1",
          channelId: "channel-1",
          result: expect.objectContaining({ success: true, returnValue: 7 }),
        }),
      ],
      expect.any(Object)
    );
    const deliveryCalls = call.mock.calls as unknown as Array<
      [string, string, unknown[], RpcCallOptions]
    >;
    expect(executionSessionNonceFor(deliveryCalls[0]?.[3])).toBe("session-background-123456");
  });

  it("durably retains verified workspace import executions until disposal", async () => {
    const { instance } = await createTestDO(EvalDO);
    setPriv(instance, "runLocked", () =>
      Promise.resolve({ success: true, console: "", returnValue: 1 })
    );
    await instance.startRun({ runId: "root-run", code: "return 1" });
    const artifact = executionArtifact();

    instance.retainExecutionRoot("root-run", "@workspace/example", artifact);
    instance.retainExecutionRoot("root-run", "@workspace/example", artifact);
    await instance.startRun({ runId: "conflicting-run", code: "return 1" });
    expect(() =>
      instance.retainExecutionRoot(
        "conflicting-run",
        "@workspace/example",
        executionArtifact("d")
      )
    ).toThrow(
      expect.objectContaining({
        code: "eval_module_execution_conflict",
        errorKind: "application",
        errorData: expect.objectContaining({
          code: "eval_module_execution_conflict",
          moduleSpecifier: "@workspace/example",
          failureKind: "user-code",
        }),
      })
    );
    expect(instance.listRetainedExecutionRoots()).toEqual([
      {
        runId: "root-run",
        moduleSpecifier: "@workspace/example",
        artifact,
      },
    ]);

    await instance.dispose();
    expect(instance.listRetainedExecutionRoots()).toEqual([]);
  });

  it("releases an import root when its deadline-aborted run did not retain the module", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    const firstArtifact = executionArtifact();
    const secondArtifact = executionArtifact("d");
    setPriv(instance, "runLocked", async (_args: unknown, signal?: AbortSignal, runId?: string) => {
      instance.retainExecutionRoot(runId!, "@workspace/example", firstArtifact);
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return { success: true, console: "" };
    });
    seedPendingRun(sql, "deadline-root", { code: "await never()", timeoutMs: 5 });
    sql.exec(`UPDATE runs SET deadline_at = ? WHERE run_id = ?`, Date.now() + 5, "deadline-root");

    await expect(
      priv<(id: string) => Promise<RunResult>>(instance, "executeRun").call(
        instance,
        "deadline-root"
      )
    ).resolves.toMatchObject({ failureCode: "eval_deadline_exceeded" });
    expect(instance.listRetainedExecutionRoots()).toEqual([]);

    seedPendingRun(sql, "next-head");
    expect(() =>
      instance.retainExecutionRoot("next-head", "@workspace/example", secondArtifact)
    ).not.toThrow();
    expect(instance.listRetainedExecutionRoots()).toEqual([
      {
        runId: "next-head",
        moduleSpecifier: "@workspace/example",
        artifact: secondArtifact,
      },
    ]);
  });

  it("drops retained module roots when a new kernel incarnation has no module heap", async () => {
    const first = await createTestDO(EvalDO);
    seedPendingRun(first.sql, "prior-incarnation");
    first.instance.retainExecutionRoot(
      "prior-incarnation",
      "@workspace/example",
      executionArtifact()
    );
    expect(first.instance.listRetainedExecutionRoots()).toHaveLength(1);

    const restarted = await createTestDO(EvalDO, undefined, { db: first.db });
    expect(restarted.instance.listRetainedExecutionRoots()).toEqual([]);
  });

  it("refreshes pending host credentials without changing the semantic run identity", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    seedPendingRun(sql, "credential-redrive", {
      runId: "credential-redrive",
      code: "return 7",
      intentDigest: "i".repeat(64),
      gatewayToken: "gateway-old",
      executionSessionNonce: "session-old",
    });
    const enqueue = priv<
      (
        args: Record<string, unknown> & { runId: string },
        schedule: boolean
      ) => Promise<{ runId: string; status: string }>
    >(instance, "enqueueRun").bind(instance);

    await expect(
      enqueue(
        {
          runId: "credential-redrive",
          code: "return 7",
          intentDigest: "i".repeat(64),
          gatewayToken: "gateway-new",
          executionSessionNonce: "session-new",
        },
        false
      )
    ).resolves.toEqual({
      runId: "credential-redrive",
      runDigest: "r".repeat(64),
      scopeInputRevision: "scope:initial",
      status: "pending",
      existing: true,
    });
    const stored = JSON.parse(
      String(
        sql.exec(`SELECT args FROM runs WHERE run_id = 'credential-redrive'`).toArray()[0]?.["args"]
      )
    ) as Record<string, unknown>;
    expect(stored).toMatchObject({
      code: "return 7",
      gatewayToken: "gateway-new",
      executionSessionNonce: "session-new",
    });

    await expect(
      enqueue(
        {
          runId: "credential-redrive",
          code: "return 8",
          intentDigest: "different-intent",
          gatewayToken: "gateway-newer",
          executionSessionNonce: "session-newer",
        },
        false
      )
    ).rejects.toThrow(/reused with different input/);
  });

  it("binds exact source and the EvalDO-owned scope input revision across replay", async () => {
    const { instance } = await createTestDO(EvalDO);
    const enqueue = priv<
      (
        args: Record<string, unknown> & { runId: string },
        schedule: boolean
      ) => Promise<{
        runId: string;
        runDigest: string;
        scopeInputRevision: string;
        status: string;
        existing: boolean;
      }>
    >(instance, "enqueueRun").bind(instance);
    const accepted = await enqueue(
      {
        runId: "exact-source-replay",
        code: "return 1",
        sourcePath: "scripts/check.ts",
        sourceDigest: "a".repeat(64),
        sourceState: { kind: "event", eventId: "event:one" },
        contentStateHash: `state:${"b".repeat(64)}`,
        intentDigest: "c".repeat(64),
      },
      false
    );
    expect(accepted).toMatchObject({
      scopeInputRevision: "scope:initial",
      existing: false,
      runDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    await expect(
      enqueue(
        {
          runId: "exact-source-replay",
          code: "return 1",
          sourcePath: "scripts/check.ts",
          sourceDigest: "a".repeat(64),
          sourceState: { kind: "event", eventId: "event:one" },
          contentStateHash: `state:${"b".repeat(64)}`,
          intentDigest: "c".repeat(64),
        },
        false
      )
    ).resolves.toMatchObject({
      scopeInputRevision: accepted.scopeInputRevision,
      runDigest: accepted.runDigest,
      existing: true,
    });

    await expect(
      enqueue(
        {
          runId: "exact-source-replay",
          code: "return 2",
          sourcePath: "scripts/check.ts",
          sourceDigest: "d".repeat(64),
          sourceState: { kind: "event", eventId: "event:two" },
          contentStateHash: `state:${"e".repeat(64)}`,
          intentDigest: "f".repeat(64),
        },
        false
      )
    ).rejects.toThrow(/reused with different input/);
  });

  it("pages large scope text losslessly without creating eval runs and persists cleanup", async () => {
    const { instance } = await createTestDO(EvalDO);
    const value = `before-${"😀\u0000".repeat(60_000)}-after`;
    const current: Record<string, unknown> = { temporary: value };
    const enterEval = vi.fn();
    const exitEval = vi.fn(() => Promise.resolve());
    const persist = vi.fn(() => Promise.resolve());
    setPriv(instance, "ensureEngine", () =>
      Promise.resolve({ SqlScopePersistence: class SqlScopePersistence {} })
    );
    setPriv(instance, "scopeManager", {
      current,
      apiFrom: () => ({}),
      hydrate: () => Promise.resolve(),
      persist,
      enterEval,
      exitEval,
    });

    const first = await instance.readScopeTextPage("temporary", 0, 131_072);
    const second = await instance.readScopeTextPage("temporary", 131_072, 131_072);
    const decode = (chunk: string) => Buffer.from(chunk, "base64").toString("utf16le");
    expect(decode(first.chunk) + decode(second.chunk)).toBe(value);
    expect(first.length).toBe(value.length);

    await expect(instance.deleteScopeValue("temporary")).resolves.toEqual({
      ok: true,
      existed: true,
    });
    expect(Object.prototype.hasOwnProperty.call(current, "temporary")).toBe(false);
    expect(enterEval).toHaveBeenCalledOnce();
    expect(exitEval).toHaveBeenCalledOnce();
  });

  it("persists bounded run progress without queueing another eval", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    seedPendingRun(sql, "run-progress", { code: "return 1", syntax: "typescript" });

    priv<(runId: string, progress: unknown) => void>(instance, "persistRunProgress").call(
      instance,
      "run-progress",
      { active: ["fs-write-read"], completed: 2 }
    );

    expect(instance.getRun("run-progress")).toMatchObject({
      status: "pending",
      progress: { active: ["fs-write-read"], completed: 2 },
    });
    expect(() =>
      priv<(runId: string, progress: unknown) => void>(instance, "persistRunProgress").call(
        instance,
        "run-progress",
        "x".repeat(256 * 1024 + 1)
      )
    ).toThrow(/256 KiB/);
  });

  it("deduplicates checkpoint events while persisting exact current RPC state", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    seedPendingRun(sql, "run-checkpoint");

    const record = priv<(runId: string, checkpoint: Record<string, unknown>) => void>(
      instance,
      "recordRunCheckpoint"
    );
    const complete = priv<(runId: string, checkpoint: Record<string, unknown>) => void>(
      instance,
      "completeRunCheckpoint"
    );
    record.call(instance, "run-checkpoint", {
      stage: "outbound-rpc",
      state: "waiting",
      targetId: "main",
      method: "panel.observe",
    });
    complete.call(instance, "run-checkpoint", {
      stage: "outbound-rpc",
      state: "completed",
      targetId: "main",
      method: "panel.observe",
    });
    // Repeating the same polling operation updates current diagnostics without
    // manufacturing another durable checkpoint event.
    record.call(instance, "run-checkpoint", {
      stage: "outbound-rpc",
      state: "waiting",
      targetId: "main",
      method: "panel.observe",
    });
    expect(instance.getRun("run-checkpoint")).toMatchObject({
      checkpoint: {
        stage: "outbound-rpc",
        state: "waiting",
        targetId: "main",
        method: "panel.observe",
      },
    });

    const checkpointEvents = instance
      .getRunEvents("run-checkpoint", 0, 100)
      .events.filter((event) => event.kind === "checkpoint");
    expect(checkpointEvents).toHaveLength(1);
  });

  it("records exact RPC state while an outbound service owns the awaited work", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    seedPendingRun(sql, "rpc-over-lease");
    sql.exec(`UPDATE runs SET status = 'running' WHERE run_id = 'rpc-over-lease'`);
    let release!: () => void;
    vi.spyOn(
      priv<{ call: (...args: unknown[]) => Promise<unknown> }>(instance, "rpc"),
      "call"
    ).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const execution = priv<
      (input: { runId: string; contextId: string }) => {
        rpc: { call: (...args: unknown[]) => Promise<unknown> };
      }
    >(instance, "createExecutionContext").call(instance, {
      runId: "rpc-over-lease",
      contextId: "ctx",
    });

    const pending = execution.rpc.call("main", "panel.observe", []);
    expect(instance.getRun("rpc-over-lease")).toMatchObject({
      checkpoint: {
        stage: "outbound-rpc",
        state: "waiting",
        targetId: "main",
        method: "panel.observe",
      },
    });

    release();
    await pending;
    expect(instance.getRun("rpc-over-lease")).toMatchObject({
      checkpoint: { stage: "outbound-rpc", state: "completed" },
    });
  });

  it("surfaces contract-declared panel boot waits as external activity", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    seedPendingRun(sql, "panel-boot-wait");
    sql.exec(`UPDATE runs SET status = 'running' WHERE run_id = 'panel-boot-wait'`);
    let release!: () => void;
    vi.spyOn(
      priv<{ call: (...args: unknown[]) => Promise<unknown> }>(instance, "rpc"),
      "call"
    ).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const execution = priv<
      (input: { runId: string; contextId: string }) => {
        rpc: { call: (...args: unknown[]) => Promise<unknown> };
      }
    >(instance, "createExecutionContext").call(instance, {
      runId: "panel-boot-wait",
      contextId: "ctx",
    });

    const ref = { epoch: "epoch-a", attemptId: "attempt-a" };
    const pending = execution.rpc.call("main", "panelRuntime.awaitAttempt", [ref, 2]);
    expect(instance.getRun("panel-boot-wait")).toMatchObject({
      checkpoint: {
        stage: "external-wait",
        state: "waiting",
        operation: "panel.boot",
        resource: { kind: "panel-attempt", value: ref },
        targetId: "main",
        method: "panelRuntime.awaitAttempt",
      },
      activity: {
        kind: "external-wait",
        operation: "panel.boot",
        resource: { kind: "panel-attempt", value: ref },
      },
    });

    release();
    await pending;
    expect(instance.getRun("panel-boot-wait")).toMatchObject({
      checkpoint: { stage: "external-wait", state: "completed" },
      activity: { kind: "executing" },
    });
  });

  it("reports authority waiting as lifecycle state and clears it on decision", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    const call = vi.fn(() => Promise.resolve(undefined));
    Object.defineProperty(instance, "rpc", { value: { call }, configurable: true });
    seedPendingRun(sql, "authority-lifecycle", {
      code: "return 1",
      contextId: "ctx",
      agentRef: "do:workers/agent-worker:AiChatWorker:agent-1",
      agentInvocationId: "inv-authority",
      channelId: "channel-1",
      executionSessionNonce: "session-authority-123456",
    });
    sql.exec(`UPDATE runs SET status = 'running' WHERE run_id = 'authority-lifecycle'`);

    instance.appendAuthorityEvent("authority-lifecycle", "authority-requested", {
      acquisitionId: "acq-1",
      capability: "context.boundary",
    });
    expect(instance.getRun("authority-lifecycle")).toMatchObject({
      status: "running",
      activity: {
        kind: "authority-pending",
        request: { acquisitionId: "acq-1", capability: "context.boundary" },
      },
    });
    await vi.waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        "do:workers/agent-worker:AiChatWorker:agent-1",
        "onEvalProgress",
        [
          expect.objectContaining({
            runId: "authority-lifecycle",
            agentInvocationId: "inv-authority",
            channelId: "channel-1",
            activity: expect.objectContaining({ kind: "authority-requested" }),
          }),
        ],
        expect.any(Object)
      )
    );
    const progressCall = call.mock.calls[0] as unknown as
      | [string, string, unknown[], RpcCallOptions]
      | undefined;
    const progressOptions = progressCall?.[3];
    expect(executionSessionNonceFor(progressOptions)).toBe("session-authority-123456");

    instance.appendAuthorityEvent("authority-lifecycle", "authority-decided", {
      acquisitionId: "acq-1",
      decision: "allow",
    });
    expect(instance.getRun("authority-lifecycle")).toMatchObject({
      status: "running",
      activity: { kind: "executing" },
    });
  });

  it("keeps reporting authority pending until every concurrent request is decided", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    seedPendingRun(sql, "authority-concurrent");
    sql.exec(`UPDATE runs SET status = 'running' WHERE run_id = 'authority-concurrent'`);

    instance.appendAuthorityEvent("authority-concurrent", "authority-requested", {
      snapshotDigest: "snapshot-a",
      capability: "context.boundary",
    });
    instance.appendAuthorityEvent("authority-concurrent", "authority-requested", {
      snapshotDigest: "snapshot-b",
      capability: "service:models.generate",
    });
    instance.appendAuthorityEvent("authority-concurrent", "authority-requested", {
      snapshotDigest: "snapshot-b",
      capability: "service:models.generate",
    });
    instance.appendAuthorityEvent("authority-concurrent", "authority-decided", {
      snapshotDigest: "already-granted-snapshot",
      decision: "allow",
    });
    instance.appendAuthorityEvent("authority-concurrent", "authority-decided", {
      snapshotDigest: "snapshot-b",
      decision: "allow",
    });

    expect(instance.getRun("authority-concurrent")).toMatchObject({
      status: "running",
      activity: {
        kind: "authority-pending",
        request: { snapshotDigest: "snapshot-a", capability: "context.boundary" },
      },
    });

    instance.appendAuthorityEvent("authority-concurrent", "authority-decided", {
      snapshotDigest: "snapshot-a",
      decision: "allow",
    });
    expect(instance.getRun("authority-concurrent")).toMatchObject({
      status: "running",
      activity: { kind: "executing" },
    });
  });

  it("leaves a run without an explicit deadline unbounded", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    try {
      const { instance, sql } = await createTestDO(EvalDO);
      seedPendingRun(sql, "unbounded-run");
      let observedSignal: AbortSignal | undefined;
      const started = new Promise<void>((resolveStarted) => {
        setPriv(instance, "runLocked", async (_args: unknown, signal?: AbortSignal) => {
          observedSignal = signal;
          resolveStarted();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { success: true, console: "", returnValue: 1 };
        });
      });
      const execution = instance.executeRun("unbounded-run");
      await started;
      await vi.advanceTimersByTimeAsync(60 * 60 * 1_000);
      expect(observedSignal?.aborted).toBe(false);
      expect(instance.getRun("unbounded-run")).toMatchObject({ status: "running" });
      expect(
        sql.exec(`SELECT deadline_at FROM runs WHERE run_id = 'unbounded-run'`).toArray()[0]
      ).toMatchObject({ deadline_at: null });
      release();
      await expect(execution).resolves.toMatchObject({ success: true, returnValue: 1 });
    } finally {
      release?.();
      vi.useRealTimers();
    }
  });

  it("serves getRun through a concurrent fetch while executeRun is held", async () => {
    const { instance, sql, call } = await createTestDO(EvalDO);
    let releaseRun!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    setPriv(instance, "runLocked", async () => {
      markStarted();
      await released;
      return { success: true, console: "", returnValue: "done" };
    });
    vi.spyOn(
      instance as unknown as { setAlarmAt: (timeMs: number, opts?: unknown) => void },
      "setAlarmAt"
    ).mockImplementation(() => undefined);
    seedPendingRun(sql, "held-run");

    const held = call<RunResult>("executeRun", "held-run");
    await started;

    await expect(call("getRun", "held-run")).resolves.toMatchObject({ status: "running" });

    releaseRun();
    await expect(held).resolves.toMatchObject({ success: true, returnValue: "done" });
  });

  it("executeRun persists a bounded terminal result for huge console and return payloads", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    const hugeConsole = `console-start\n${"c".repeat(220_000)}\nconsole-end`;
    const hugeReturn = { value: `return-start\n${"r".repeat(220_000)}\nreturn-end` };
    setPriv(instance, "runLocked", () =>
      Promise.resolve({ success: true, console: hugeConsole, returnValue: hugeReturn })
    );
    seedPendingRun(sql, "huge-run");

    const result = await priv<(id: string) => Promise<RunResult>>(instance, "executeRun").call(
      instance,
      "huge-run"
    );

    expect(result.success).toBe(true);
    expect(result.console.length).toBeLessThan(100_000);
    expect(result.console).toContain("scope.$lastLargeConsole");
    expect(result.console).toContain("slice(0, 1500)");
    expect(result.returnValue).toMatchObject({
      truncated: true,
      scopeKey: "$lastLargeReturn",
    });

    const persisted = priv<(id: string) => { status: string; result?: RunResult }>(
      instance,
      "getRun"
    ).call(instance, "huge-run");
    expect(persisted.status).toBe("done");
    expect(persisted.result).toEqual(result);
    expect(JSON.stringify(persisted.result).length).toBeLessThan(250_000);
  });

  it("persists approval route loss as a distinct restartable terminal condition", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    setPriv(instance, "runLocked", () =>
      Promise.reject(
        Object.assign(new Error("parent callback disconnected"), {
          code: "EAPPROVALROUTELOST",
        })
      )
    );
    seedPendingRun(sql, "route-lost-run");

    await expect(
      priv<(id: string) => Promise<RunResult>>(instance, "executeRun").call(
        instance,
        "route-lost-run"
      )
    ).resolves.toMatchObject({
      success: false,
      failureCode: "approval-route-lost",
      error: expect.stringContaining("restart"),
    });
    expect(
      priv<(id: string) => { status: string; result?: RunResult }>(instance, "getRun").call(
        instance,
        "route-lost-run"
      )
    ).toMatchObject({
      status: "approval-route-lost",
      result: { failureCode: "approval-route-lost" },
    });
  });

  it("retains a small structured return for REPL-style follow-up inspection", async () => {
    const { instance } = await createTestDO(EvalDO);
    const scope: Record<string, unknown> = {};

    priv<
      (
        scope: Record<string, unknown>,
        console: string,
        error: string | undefined,
        value: unknown
      ) => void
    >(instance, "spillLargeOutput").call(instance, scope, "", undefined, {
      methods: { inspect: true },
    });

    expect(scope["$lastReturn"]).toEqual({ methods: { inspect: true } });
  });

  it("keeps large recovery slots stable across small follow-up inspectors", async () => {
    const { instance } = await createTestDO(EvalDO);
    const scope: Record<string, unknown> = {};
    const spill = priv<
      (
        scope: Record<string, unknown>,
        console: string,
        error: string | undefined,
        value: unknown
      ) => void
    >(instance, "spillLargeOutput");
    const largeConsole = "c".repeat(90_000);
    const largeError = "e".repeat(60_000);
    const largeReturn = { body: "r".repeat(60_000) };

    spill.call(instance, scope, largeConsole, largeError, largeReturn);
    const savedReturn = scope["$lastLargeReturn"];
    expect(scope).toMatchObject({
      $lastLargeConsole: largeConsole,
      $lastLargeError: largeError,
      $lastReturn: savedReturn,
    });

    spill.call(instance, scope, "", undefined, { pageLength: 40_000 });

    expect(scope["$lastReturn"]).toEqual({ pageLength: 40_000 });
    expect(scope["$lastLargeConsole"]).toBe(largeConsole);
    expect(scope["$lastLargeError"]).toBe(largeError);
    expect(scope["$lastLargeReturn"]).toBe(savedReturn);
  });

  it("retains oversized structured failure data in its advertised recovery slot", async () => {
    const { instance } = await createTestDO(EvalDO);
    const scope: Record<string, unknown> = {};
    const errorData = { diagnostics: "d".repeat(60_000) };

    priv<
      (
        scope: Record<string, unknown>,
        console: string,
        error: string | undefined,
        value: unknown,
        errorData?: unknown
      ) => void
    >(instance, "spillLargeOutput").call(instance, scope, "", undefined, undefined, errorData);

    expect(scope["$lastLargeErrorData"]).toBe(JSON.stringify(errorData, null, 2));
  });

  it("cancel(runId): an in-flight run wedged on an outbound call unwinds once cancelled", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { instance, sql } = await createTestDO(EvalDO);
    const { runLocked, started } = blockUntilAborted();
    setPriv(instance, "runLocked", runLocked);

    seedPendingRun(sql, "run-A");
    // Kick the held execution; do NOT await — it wedges until cancelled.
    const runP = priv<(id: string) => Promise<RunResult>>(instance, "executeRun").call(
      instance,
      "run-A"
    );
    runP.catch(() => undefined); // avoid an unhandled-rejection warning before the assertion awaits

    // The run is now executing (blocked on the simulated outbound call).
    const { signal } = await started;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);
    expect(sql.exec(`SELECT status FROM runs WHERE run_id = 'run-A'`).toArray()[0]).toMatchObject({
      status: "running",
    });
    const cleanup = vi.fn(async () => {
      if (!signal!.aborted) {
        await new Promise<void>((resolve) =>
          signal!.addEventListener("abort", () => resolve(), { once: true })
        );
      }
      expect(signal!.aborted).toBe(true);
    });
    priv<Map<string, Set<() => Promise<void>>>>(instance, "runCancelHandlers").set(
      "run-A",
      new Set([cleanup])
    );

    // Cancel: CAS row → cancelled, then abort the controller threaded into the run.
    const cancelRet = await priv<(id: string) => Promise<{ ok: boolean; forcedReset: boolean }>>(
      instance,
      "cancel"
    ).call(instance, "run-A");
    expect(cancelRet).toEqual({ ok: true, forcedReset: false });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(signal!.aborted).toBe(true);

    // The wedged run unwinds (rejects), and `runEval` maps the cancelled status to a failure result —
    // it can NEVER resurrect itself `done` (the CAS persist requires status='running').
    const result = await runP;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cancelled/i);
    expect(sql.exec(`SELECT status FROM runs WHERE run_id = 'run-A'`).toArray()[0]).toMatchObject({
      status: "cancelled",
    });
    expect(errorLog).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it("cancel runs cleanup and abort as one phase so cleanup may wait for run unwind", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    const { runLocked, started } = blockUntilAborted();
    setPriv(instance, "runLocked", runLocked);
    seedPendingRun(sql, "run-cleanup-waits");

    const runP = priv<(id: string) => Promise<RunResult>>(instance, "executeRun").call(
      instance,
      "run-cleanup-waits"
    );
    const { signal } = await started;
    priv<Map<string, Set<() => Promise<void>>>>(instance, "runCancelHandlers").set(
      "run-cleanup-waits",
      new Set([
        async () => {
          if (!signal?.aborted) {
            await new Promise<void>((resolve) =>
              signal?.addEventListener("abort", () => resolve(), { once: true })
            );
          }
          await runP;
        },
      ])
    );

    await expect(
      priv<(id: string) => Promise<{ ok: boolean }>>(instance, "cancel").call(
        instance,
        "run-cleanup-waits"
      )
    ).resolves.toEqual({ ok: true, forcedReset: false });
    await expect(runP).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/cancelled/i),
    });
  });

  it("starts cancellation cleanup before aborting ordinary guest execution", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    const { runLocked, started } = blockUntilAborted();
    setPriv(instance, "runLocked", runLocked);
    seedPendingRun(sql, "run-cleanup-first");

    const runP = priv<(id: string) => Promise<RunResult>>(instance, "executeRun").call(
      instance,
      "run-cleanup-first"
    );
    const { signal } = await started;
    let cleanupStartedBeforeAbort = false;
    priv<Map<string, Set<() => Promise<void>>>>(instance, "runCancelHandlers").set(
      "run-cleanup-first",
      new Set([
        async () => {
          cleanupStartedBeforeAbort = !signal?.aborted;
        },
      ])
    );

    await expect(
      priv<(id: string) => Promise<{ ok: boolean }>>(instance, "cancel").call(
        instance,
        "run-cleanup-first"
      )
    ).resolves.toEqual({ ok: true, forcedReset: false });
    expect(cleanupStartedBeforeAbort).toBe(true);
    await expect(runP).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/cancelled/i),
    });
  });

  it("runs explicit cancellation cleanup in its registering execution context", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    const { runLocked, started } = blockUntilAborted();
    setPriv(instance, "runLocked", runLocked);
    seedPendingRun(sql, "run-context-owner");

    const runP = priv<(id: string) => Promise<RunResult>>(instance, "executeRun").call(
      instance,
      "run-context-owner"
    );
    await started;
    const ownerExecution = { contextId: "owner-cell" };
    const foreignExecution = { contextId: "foreign-cell" };
    const seen: unknown[] = [];
    const handler = priv<
      (execution: unknown, callback: () => Promise<void>) => () => Promise<void>
    >(instance, "bindRunCancelHandler").call(instance, ownerExecution, async () => {
      seen.push(priv<() => unknown>(instance, "requireActiveEvalExecution").call(instance));
    });
    priv<Map<string, Set<() => Promise<void>>>>(instance, "runCancelHandlers").set(
      "run-context-owner",
      new Set([handler])
    );

    const activeExecution = priv<{
      run<T>(store: unknown, callback: () => T): T;
    }>(instance, "activeEvalExecution");
    await expect(
      activeExecution.run(foreignExecution, () =>
        priv<(id: string) => Promise<{ ok: boolean; forcedReset: boolean }>>(
          instance,
          "cancel"
        ).call(instance, "run-context-owner")
      )
    ).resolves.toEqual({ ok: true, forcedReset: false });

    expect(seen).toEqual([ownerExecution]);
    expect(() =>
      priv<() => unknown>(instance, "requireActiveEvalExecution").call(instance)
    ).toThrow(/actively executing/);
    await runP;
  });

  it("runs deadline cleanup in its registering execution context", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    const { runLocked } = blockUntilAborted();
    setPriv(instance, "runLocked", runLocked);
    seedPendingRun(sql, "deadline-context-owner", {
      code: "await never();",
      timeoutMs: 5,
    });
    sql.exec(
      `UPDATE runs SET deadline_at = ? WHERE run_id = ?`,
      Date.now() + 5,
      "deadline-context-owner"
    );
    const ownerExecution = { contextId: "deadline-owner-cell" };
    const seen: unknown[] = [];
    const handler = priv<
      (execution: unknown, callback: () => Promise<void>) => () => Promise<void>
    >(instance, "bindRunCancelHandler").call(instance, ownerExecution, async () => {
      seen.push(priv<() => unknown>(instance, "requireActiveEvalExecution").call(instance));
    });
    priv<Map<string, Set<() => Promise<void>>>>(instance, "runCancelHandlers").set(
      "deadline-context-owner",
      new Set([handler])
    );

    await expect(
      priv<(id: string) => Promise<RunResult>>(instance, "executeRun").call(
        instance,
        "deadline-context-owner"
      )
    ).resolves.toMatchObject({ failureCode: "eval_deadline_exceeded" });
    expect(seen).toEqual([ownerExecution]);
    expect(() =>
      priv<() => unknown>(instance, "requireActiveEvalExecution").call(instance)
    ).toThrow(/actively executing/);
  });

  it("keeps the durable run non-terminal while gated cleanup is still running", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    const { runLocked, started } = blockUntilAborted();
    setPriv(instance, "runLocked", runLocked);
    seedPendingRun(sql, "run-cancelling-state");

    const runP = priv<(id: string) => Promise<RunResult>>(instance, "executeRun").call(
      instance,
      "run-cancelling-state"
    );
    await started;
    let announceCleanup!: () => void;
    let releaseCleanup!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => (announceCleanup = resolve));
    const cleanupGate = new Promise<void>((resolve) => (releaseCleanup = resolve));
    priv<Map<string, Set<() => Promise<void>>>>(instance, "runCancelHandlers").set(
      "run-cancelling-state",
      new Set([
        async () => {
          announceCleanup();
          await cleanupGate;
        },
      ])
    );

    const cancellation = priv<(id: string) => Promise<{ ok: boolean; forcedReset: boolean }>>(
      instance,
      "cancel"
    ).call(instance, "run-cancelling-state");
    await cleanupStarted;
    await expect(runP).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/cancelled/i),
    });
    expect(
      sql.exec(`SELECT status FROM runs WHERE run_id = 'run-cancelling-state'`).toArray()[0]
    ).toMatchObject({ status: "cancelling" });

    releaseCleanup();
    await expect(cancellation).resolves.toEqual({ ok: true, forcedReset: false });
    expect(
      sql.exec(`SELECT status FROM runs WHERE run_id = 'run-cancelling-state'`).toArray()[0]
    ).toMatchObject({ status: "cancelled" });
  });

  it("does not revoke owned cleanup when it outlives the unowned recovery grace", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    const { runLocked, started } = blockUntilAborted();
    setPriv(instance, "runLocked", runLocked);
    setPriv(instance, "cancellationGraceMs", 1);
    seedPendingRun(sql, "run-owned-cleanup");

    const runP = priv<(id: string) => Promise<RunResult>>(instance, "executeRun").call(
      instance,
      "run-owned-cleanup"
    );
    await started;
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => (releaseCleanup = resolve));
    priv<Map<string, Set<() => Promise<void>>>>(instance, "runCancelHandlers").set(
      "run-owned-cleanup",
      new Set([async () => cleanupGate])
    );
    const reset = vi.spyOn(
      instance as unknown as { forceReset: () => Promise<{ ok: boolean }> },
      "forceReset"
    );

    const cancellation = priv<(id: string) => Promise<{ ok: boolean; forcedReset: boolean }>>(
      instance,
      "cancel"
    ).call(instance, "run-owned-cleanup");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(reset).not.toHaveBeenCalled();
    expect(
      sql.exec(`SELECT status FROM runs WHERE run_id = 'run-owned-cleanup'`).toArray()[0]
    ).toMatchObject({ status: "cancelling" });

    releaseCleanup();
    await expect(cancellation).resolves.toEqual({ ok: true, forcedReset: false });
    await runP;
  });

  it("joins concurrent cancel callers to one cleanup phase", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    const { runLocked, started } = blockUntilAborted();
    setPriv(instance, "runLocked", runLocked);
    seedPendingRun(sql, "run-concurrent-cancel");

    const runP = priv<(id: string) => Promise<RunResult>>(instance, "executeRun").call(
      instance,
      "run-concurrent-cancel"
    );
    await started;
    let announceCleanup!: () => void;
    let releaseCleanup!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => (announceCleanup = resolve));
    const cleanupGate = new Promise<void>((resolve) => (releaseCleanup = resolve));
    const cleanup = vi.fn(async () => {
      announceCleanup();
      await cleanupGate;
    });
    priv<Map<string, Set<() => Promise<void>>>>(instance, "runCancelHandlers").set(
      "run-concurrent-cancel",
      new Set([cleanup])
    );

    const cancel = priv<(id: string) => Promise<{ ok: boolean; forcedReset: boolean }>>(
      instance,
      "cancel"
    ).bind(instance);
    const first = cancel("run-concurrent-cancel");
    await cleanupStarted;
    const second = cancel("run-concurrent-cancel");
    expect(cleanup).toHaveBeenCalledOnce();
    expect(priv<Map<string, Promise<unknown>>>(instance, "inFlightCancellations").size).toBe(1);
    expect(
      sql.exec(`SELECT status FROM runs WHERE run_id = 'run-concurrent-cancel'`).toArray()[0]
    ).toMatchObject({ status: "cancelling" });

    releaseCleanup();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, forcedReset: false },
      { ok: true, forcedReset: false },
    ]);
    await runP;
    expect(cleanup).toHaveBeenCalledOnce();
    expect(priv<Map<string, Promise<unknown>>>(instance, "inFlightCancellations").size).toBe(0);
    expect(
      sql.exec(`SELECT status FROM runs WHERE run_id = 'run-concurrent-cancel'`).toArray()[0]
    ).toMatchObject({ status: "cancelled" });
  });

  it("terminalizes a run after cleanup rejection while preserving the failure", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    const { runLocked, started } = blockUntilAborted();
    setPriv(instance, "runLocked", runLocked);
    seedPendingRun(sql, "run-cleanup-rejects");
    const runP = priv<(id: string) => Promise<RunResult>>(instance, "executeRun").call(
      instance,
      "run-cleanup-rejects"
    );
    await started;
    const scope: Record<string, unknown> = {};
    const persisted: Array<Record<string, unknown>> = [];
    setPriv(instance, "scopeManager", {
      current: scope,
      apiFrom: () => ({}),
      hydrate: () => Promise.resolve(),
      persist: async () => {
        persisted.push(structuredClone(scope));
      },
      enterEval: () => undefined,
      exitEval: () => Promise.resolve(),
    });
    setPriv(instance, "engine", { SqlScopePersistence: class SqlScopePersistence {} });
    priv<Map<string, Set<() => Promise<void>>>>(instance, "runCancelHandlers").set(
      "run-cleanup-rejects",
      new Set([
        async () => {
          scope["terminalRecord"] = { status: "cancelled", cleanupFailed: true };
          throw new Error("cleanup rejected visibly");
        },
      ])
    );

    await expect(
      priv<(id: string) => Promise<{ ok: boolean }>>(instance, "cancel").call(
        instance,
        "run-cleanup-rejects"
      )
    ).rejects.toThrow(/cleanup rejected visibly/);
    await runP;
    expect(
      sql.exec(`SELECT status FROM runs WHERE run_id = 'run-cleanup-rejects'`).toArray()[0]
    ).toMatchObject({ status: "cancelled" });
    expect(persisted.at(-1)).toEqual({
      terminalRecord: { status: "cancelled", cleanupFailed: true },
    });
    expect(priv<Map<string, Promise<unknown>>>(instance, "inFlightCancellations").size).toBe(0);
  });

  it("persists scope mutations made by cancellation cleanup after the run unwinds", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    const { runLocked, started } = blockUntilAborted();
    setPriv(instance, "runLocked", runLocked);
    seedPendingRun(sql, "run-cleanup-scope");

    const scope: Record<string, unknown> = {};
    const persistedSnapshots: Array<Record<string, unknown>> = [];
    setPriv(instance, "scopeManager", {
      current: scope,
      apiFrom: () => ({}),
      hydrate: () => Promise.resolve(),
      persist: async () => {
        persistedSnapshots.push(structuredClone(scope));
      },
      enterEval: () => undefined,
      exitEval: () => Promise.resolve(),
    });
    setPriv(instance, "engine", { SqlScopePersistence: class SqlScopePersistence {} });

    const runP = priv<(id: string) => Promise<RunResult>>(instance, "executeRun").call(
      instance,
      "run-cleanup-scope"
    );
    await started;
    priv<Map<string, Set<() => Promise<void>>>>(instance, "runCancelHandlers").set(
      "run-cleanup-scope",
      new Set([
        async () => {
          scope["terminalRecord"] = { status: "cancelled" };
        },
      ])
    );

    await expect(
      priv<(id: string) => Promise<{ ok: boolean }>>(instance, "cancel").call(
        instance,
        "run-cleanup-scope"
      )
    ).resolves.toEqual({ ok: true, forcedReset: false });
    await runP;
    expect(persistedSnapshots.at(-1)).toEqual({
      terminalRecord: { status: "cancelled" },
    });
  });

  it("starts the cleanup owner that is required to settle the eval body", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    let releaseRun!: () => void;
    const released = new Promise<void>((resolve) => (releaseRun = resolve));
    let runStarted!: () => void;
    const started = new Promise<void>((resolve) => (runStarted = resolve));
    setPriv(instance, "runLocked", async () => {
      runStarted();
      await released;
      return { success: true, console: "" };
    });
    seedPendingRun(sql, "cleanup-owns-terminal");
    const runP = priv<(id: string) => Promise<RunResult>>(instance, "executeRun").call(
      instance,
      "cleanup-owns-terminal"
    );
    await started;
    const cleanup = vi.fn(async () => releaseRun());
    priv<Map<string, Set<() => Promise<void>>>>(instance, "runCancelHandlers").set(
      "cleanup-owns-terminal",
      new Set([cleanup])
    );

    await expect(
      priv<(id: string) => Promise<{ ok: boolean }>>(instance, "cancel").call(
        instance,
        "cleanup-owns-terminal"
      )
    ).resolves.toEqual({ ok: true, forcedReset: false });
    expect(cleanup).toHaveBeenCalledOnce();
    await expect(runP).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/cancelled/i),
    });
  });

  it("cancel(runId): a no-op for an already-terminal run, and leaves other runs untouched", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    // A done run + a pending run that is NOT the cancel target.
    sql.exec(
      `INSERT INTO runs (run_id, args, status, started_at) VALUES ('done-1', '{}', 'done', ?)`,
      Date.now()
    );
    seedPendingRun(sql, "other");

    const ret = await priv<(id: string) => Promise<{ ok: boolean }>>(instance, "cancel").call(
      instance,
      "done-1"
    );
    expect(ret).toEqual({ ok: true, forcedReset: false });
    // The done run is NOT flipped to cancelled (CAS only touches pending/running), and `other` is untouched.
    expect(sql.exec(`SELECT status FROM runs WHERE run_id = 'done-1'`).toArray()[0]).toMatchObject({
      status: "done",
    });
    expect(sql.exec(`SELECT status FROM runs WHERE run_id = 'other'`).toArray()[0]).toMatchObject({
      status: "pending",
    });
    expect(sql.exec(`SELECT * FROM run_events WHERE run_id = 'done-1'`).toArray()).toHaveLength(0);
  });

  it("bounds non-cooperative cancellation and reports the resulting scope reset", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => (announceStarted = resolve));
    setPriv(instance, "runLocked", async () => {
      announceStarted();
      return new Promise<RunResult>(() => undefined);
    });
    setPriv(instance, "cancellationGraceMs", 1);
    seedPendingRun(sql, "wedged-target");
    seedPendingRun(sql, "queued-peer");
    sql.exec(`CREATE TABLE user_before_forced_cancel (value TEXT)`);

    const runP = priv<(id: string) => Promise<RunResult>>(instance, "executeRun").call(
      instance,
      "wedged-target"
    );
    runP.catch(() => undefined);
    await started;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      priv<(id: string) => Promise<{ ok: boolean; forcedReset: boolean }>>(instance, "cancel").call(
        instance,
        "wedged-target"
      )
    ).resolves.toEqual({ ok: true, forcedReset: true });

    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/did not settle.*resetting/i));
    warning.mockRestore();
    expect(
      sql.exec(`SELECT status FROM runs WHERE run_id = 'queued-peer'`).toArray()[0]
    ).toMatchObject({ status: "cancelled" });
    expect(
      sql.exec(`SELECT name FROM sqlite_master WHERE name = 'user_before_forced_cancel'`).toArray()
    ).toEqual([]);
    expect(priv<number>(instance, "scopeGeneration")).toBe(1);
    expect(
      priv<Map<string, { active: boolean; revoked: boolean }>>(instance, "runCleanupPhases").get(
        "wedged-target"
      )
    ).toEqual({ active: false, revoked: true });
  });

  it("an already-expired run reports cleanup failure and still releases its lifecycle state", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    sql.exec(
      `INSERT INTO runs (run_id, args, status, started_at, deadline_at)
       VALUES (?, ?, 'pending', ?, ?)`,
      "expired",
      JSON.stringify({ code: "return 1", contextId: "ctx", timeoutMs: 1 }),
      Date.now() - 10,
      Date.now() - 1
    );
    const runLocked = vi.fn(async () => ({ success: true, console: "unexpected" }));
    setPriv(instance, "runLocked", runLocked);
    priv<Map<string, Set<() => Promise<void>>>>(instance, "runCancelHandlers").set(
      "expired",
      new Set([async () => Promise.reject(new Error("cleanup exploded"))])
    );

    const result = await priv<(id: string) => Promise<RunResult>>(instance, "executeRun").call(
      instance,
      "expired"
    );

    expect(result).toMatchObject({ success: false });
    expect(result.error).toMatch(/cancellation cleanup failed/i);
    expect(runLocked).not.toHaveBeenCalled();
    expect(sql.exec(`SELECT status FROM runs WHERE run_id = 'expired'`).toArray()[0]).toMatchObject(
      {
        status: "done",
      }
    );
    expect(priv<Map<string, unknown>>(instance, "runAborts").has("expired")).toBe(false);
  });

  it("normalizes a guest abort caused by the deadline as a timeout", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    const { runLocked } = blockUntilAborted();
    setPriv(instance, "runLocked", runLocked);
    seedPendingRun(sql, "deadline-abort", { code: "await never();", timeoutMs: 5 });
    sql.exec(`UPDATE runs SET deadline_at = ? WHERE run_id = ?`, Date.now() + 5, "deadline-abort");

    const result = await priv<(id: string) => Promise<RunResult>>(instance, "executeRun").call(
      instance,
      "deadline-abort"
    );

    expect(result).toMatchObject({
      success: false,
      error: "eval timed out after 5ms",
      failureKind: "cancelled",
      failureCode: "eval_deadline_exceeded",
    });
    expect(
      sql.exec(`SELECT status FROM runs WHERE run_id = 'deadline-abort'`).toArray()[0]
    ).toMatchObject({ status: "done" });
  });

  it("forceReset(): a wedged run on runChain does not block a later run, and tables/scope are cleared", async () => {
    const { instance, sql } = await createTestDO(EvalDO);

    // 1) A wedged run that holds `runChain` forever (never aborts on its own).
    const { runLocked: wedge, started: wedgeStarted } = blockUntilAborted();
    setPriv(instance, "runLocked", wedge);
    seedPendingRun(sql, "wedged");
    seedPendingRun(sql, "already-cancelling");
    sql.exec(`UPDATE runs SET status = 'cancelling' WHERE run_id = 'already-cancelling'`);
    const wedgedP = priv<(id: string) => Promise<RunResult>>(instance, "executeRun").call(
      instance,
      "wedged"
    );
    wedgedP.catch(() => undefined);
    const { signal } = await wedgeStarted; // the wedged run now occupies runChain
    let releaseCleanup!: () => void;
    let announceCleanup!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => (announceCleanup = resolve));
    const cleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          announceCleanup();
          releaseCleanup = resolve;
        })
    );
    priv<Map<string, Set<() => Promise<void>>>>(instance, "runCancelHandlers").set(
      "wedged",
      new Set([cleanup])
    );

    // Seed user table + a fake scope table so we can assert resetLocked wiped them.
    sql.exec(`CREATE TABLE IF NOT EXISTS user_data (k TEXT)`);
    sql.exec(`INSERT INTO user_data (k) VALUES ('x')`);
    sql.exec(`CREATE TABLE IF NOT EXISTS repl_scopes (id TEXT)`);
    setPriv(instance, "scopeManager", { marker: "stale" });

    // 2) forceReset: cancel non-terminal runs, abort in-flight, REPLACE runChain, resetLocked NOW.
    const chainBefore = priv<Promise<unknown>>(instance, "runChain");
    const forcePromise = priv<() => Promise<{ ok: boolean }>>(instance, "forceReset").call(
      instance
    );
    await cleanupStarted;
    expect(cleanup).toHaveBeenCalledOnce();
    expect(signal?.aborted).toBe(true);
    releaseCleanup();
    const forceRet = await forcePromise;
    expect(forceRet).toEqual({ ok: true });

    // The wedged run was CAS'd to cancelled and aborted (so it unwinds rather than leaking forever).
    expect(sql.exec(`SELECT status FROM runs WHERE run_id = 'wedged'`).toArray()[0]).toMatchObject({
      status: "cancelled",
    });
    expect(
      sql.exec(`SELECT status FROM runs WHERE run_id = 'already-cancelling'`).toArray()[0]
    ).toMatchObject({ status: "cancelled" });
    const wedgedResult = await wedgedP;
    expect(wedgedResult.success).toBe(false);

    // runChain was REPLACED (orphaned), not chained off the stuck one.
    const chainAfter = priv<Promise<unknown>>(instance, "runChain");
    expect(chainAfter).not.toBe(chainBefore);
    await expect(chainAfter).resolves.toBeUndefined();

    // resetLocked ran directly (not queued behind the wedged run): user tables + scope cleared.
    const tables = sql
      .exec(`SELECT name FROM sqlite_master WHERE type='table'`)
      .toArray()
      .map((r) => (r as { name: string }).name);
    expect(tables).not.toContain("user_data");
    expect(tables).not.toContain("repl_scopes");
    expect(tables).toContain("state");
    expect(tables).toContain("eval_result_redeliveries");
    expect(tables).toContain("resident_channel_memberships");
    expect(priv(instance, "scopeManager")).toBeNull();

    // 3) A NEW run enqueued AFTER forceReset proceeds at once — the chain was not wedged.
    const { runLocked: fresh, started: freshStarted } = (() => {
      let resolveStarted!: () => void;
      const startedP = new Promise<void>((r) => (resolveStarted = r));
      const fn: RunLockedFn = () => {
        resolveStarted();
        return Promise.resolve({ success: true, console: "ok" });
      };
      return { runLocked: fn, started: startedP };
    })();
    setPriv(instance, "runLocked", fresh);
    seedPendingRun(sql, "after");
    const afterP = priv<(id: string) => Promise<RunResult>>(instance, "executeRun").call(
      instance,
      "after"
    );
    await freshStarted; // proves the new run actually ran (did not hang behind the wedged chain)
    const afterResult = await afterP;
    expect(afterResult).toMatchObject({ success: true, console: "ok" });
    expect(sql.exec(`SELECT status FROM runs WHERE run_id = 'after'`).toArray()[0]).toMatchObject({
      status: "done",
    });
  });

  it("reconciles a stale cancelling row as terminal cancellation after restart", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    seedPendingRun(sql, "stale-cancelling");
    sql.exec(`UPDATE runs SET status = 'cancelling' WHERE run_id = 'stale-cancelling'`);

    priv<() => void>(instance, "reconcileOrphanedRuns").call(instance);

    expect(
      sql.exec(`SELECT status FROM runs WHERE run_id = 'stale-cancelling'`).toArray()[0]
    ).toMatchObject({ status: "cancelled" });
  });

  it("dispose erases terminal jobs and releases every loaded kernel reference", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    const lifecycleCall = vi.fn(() => Promise.resolve(undefined));
    Object.defineProperty(instance, "rpc", {
      value: { call: lifecycleCall },
      configurable: true,
    });
    instance.acquireKernelLease({ leaseId: "finite-kernel", idleMs: 60_000 });
    await instance.attachKernelLeaseHolder("finite-kernel");
    const held = instance.holdKernelLease("finite-kernel");
    seedPendingRun(sql, "finite");
    sql.exec(
      `INSERT INTO run_progress (run_id, progress, updated_at) VALUES (?, ?, ?)`,
      "finite",
      JSON.stringify({ running: true }),
      Date.now()
    );
    setPriv(instance, "engine", { loaded: true });
    setPriv(instance, "runtimeSupport", { loaded: true });
    setPriv(instance, "portableHelpers", { loaded: true });
    setPriv(instance, "hostedRuntimeIdentity", {
      contextId: "ctx",
      gatewayToken: "secret",
    });
    setPriv(instance, "moduleMap", { package: { loaded: true } });
    priv<Record<string, unknown>>(instance, "isolateModuleMap")["package"] = { loaded: true };

    await expect(instance.dispose()).resolves.toEqual({ ok: true });
    await expect(held).resolves.toEqual({ leaseId: "finite-kernel", reason: "released" });

    expect(sql.exec(`SELECT COUNT(*) AS count FROM runs`).toArray()[0]).toMatchObject({ count: 0 });
    expect(sql.exec(`SELECT COUNT(*) AS count FROM run_progress`).toArray()[0]).toMatchObject({
      count: 0,
    });
    expect(priv(instance, "engine")).toBeNull();
    expect(priv(instance, "runtimeSupport")).toBeNull();
    expect(priv(instance, "portableHelpers")).toBeNull();
    expect(priv(instance, "hostedRuntimeIdentity")).toBeNull();
    expect(priv(instance, "moduleMap")).toEqual({});
    expect(Object.keys(priv(instance, "isolateModuleMap"))).toEqual(["node:async_hooks"]);
    expect(lifecycleCall).toHaveBeenLastCalledWith("main", "workspace-state.lifecycleLeaseClear", [
      expect.any(Object),
    ]);
  });

  it("keeps orphaned and replacement runs in distinct immutable execution contexts", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    const calls: Array<{
      method: string;
      options: RpcCallOptions | undefined;
    }> = [];
    const fakeRpc = {
      selfId: "do:test:EvalDO:test-key",
      call: vi.fn((_target: string, method: string, _args: unknown[], options?: RpcCallOptions) => {
        calls.push({ method, options });
        return Promise.resolve("ok");
      }),
      stream: vi.fn(),
      streamReadable: vi.fn(),
      emit: vi.fn((_target: string, event: string, _payload: unknown, options?: RpcCallOptions) => {
        calls.push({ method: event, options });
        return Promise.resolve();
      }),
      on: vi.fn(() => vi.fn()),
      expose: vi.fn(),
      exposeAll: vi.fn(),
      exposeStreaming: vi.fn(),
      peer: vi.fn((targetId: string) => ({
        id: targetId,
        call: {},
        on: vi.fn(() => vi.fn()),
        emit: vi.fn(),
        withContract: vi.fn(),
      })),
      status: vi.fn(() => "connected"),
      ready: vi.fn(() => Promise.resolve()),
      onStatusChange: vi.fn(() => vi.fn()),
    };
    Object.defineProperty(instance, "rpc", { get: () => fakeRpc, configurable: true });
    (instance as unknown as { env: Record<string, unknown> }).env["EVAL_RUNTIME_SOURCE"] =
      "@workspace/runtime";
    setPriv(instance, "ensureRuntimeSupport", () =>
      Promise.resolve({
        createHostedRuntime: (host: Record<string, unknown>) => ({
          rpc: host["rpc"],
          fs: host["fs"],
        }),
        createPanelRuntime: () => ({ getPanelHandle: () => null }),
        createRuntimeSelfHandle: () => ({}),
        createGatewayFetch: () => () => {},
        createRpcFs: () => ({}),
        createRuntimeParentHandle: () => null,
        createServicesProxy: () => ({}),
        createAttachedHostsApi: () => ({}),
        createWorkerdClient: () => ({}),
      })
    );
    const fakeScope = {
      current: {},
      apiFrom: () => ({}),
      enterEval: () => {},
      exitEval: () => Promise.resolve(),
    };
    setPriv(instance, "ensureScopeManager", () => Promise.resolve(fakeScope));

    let startA!: () => void;
    let resumeA!: () => void;
    let calledA!: () => void;
    let startB!: () => void;
    let resumeB!: () => void;
    const aStarted = new Promise<void>((resolve) => (startA = resolve));
    const aResumed = new Promise<void>((resolve) => (resumeA = resolve));
    const aCalled = new Promise<void>((resolve) => (calledA = resolve));
    const bStarted = new Promise<void>((resolve) => (startB = resolve));
    const bResumed = new Promise<void>((resolve) => (resumeB = resolve));
    const runSignals = new Map<string, AbortSignal | undefined>();
    setPriv(instance, "ensureEngine", () =>
      Promise.resolve({
        SqlScopePersistence: class SqlScopePersistence {},
        executeSandbox: async (
          code: string,
          options: { bindings: Record<string, unknown>; signal?: AbortSignal }
        ) => {
          const rpc = options.bindings["rpc"] as {
            call(target: string, method: string, args: unknown[]): Promise<unknown>;
            peer(target: string): {
              call: Record<string, (...args: unknown[]) => Promise<unknown>>;
              emit(event: string, payload: unknown): Promise<void>;
            };
          };
          runSignals.set(code, options.signal);
          if (code === "A") {
            startA();
            await aResumed;
            await rpc.peer("main").call["run-a-after-b-started"]!();
            calledA();
          } else {
            await rpc.call("main", "run-b-before-a-resumes", []);
            startB();
            await bResumed;
            await rpc.peer("main").emit("run-b-after-a-finished", {});
          }
          return { success: true, consoleOutput: "", returnValue: code };
        },
      })
    );

    const causeA = {
      kind: "trajectory-invocation" as const,
      logId: "trajectory:a",
      head: "main",
      invocationId: "invocation:a",
    };
    const causeB = {
      kind: "trajectory-invocation" as const,
      logId: "trajectory:b",
      head: "main",
      invocationId: "invocation:b",
    };
    seedPendingRun(sql, "run-a", {
      code: "A",
      contextId: "ctx",
      gatewayToken: "gateway-test",
      causalParent: causeA,
      readOnly: true,
    });
    const runA = instance.executeRun("run-a");
    await aStarted;

    // A ignores its abort and remains suspended. forceReset therefore orphans
    // its chain, allowing B to begin with a different immutable context.
    await priv<() => Promise<{ ok: boolean }>>(instance, "forceReset").call(instance);
    await instance.startRun({
      runId: "run-b",
      code: "B",
      contextId: "ctx",
      gatewayToken: "gateway-test",
      causalParent: causeB,
      readOnly: false,
    });
    const runB = instance.executeRun("run-b");
    await bStarted;

    resumeA();
    await aCalled;
    await runA;
    resumeB();
    await expect(runB).resolves.toMatchObject({ success: true, returnValue: "B" });

    const aSignal = runSignals.get("A");
    const bSignal = runSignals.get("B");
    expect(aSignal).toBeInstanceOf(AbortSignal);
    expect(bSignal).toBeInstanceOf(AbortSignal);
    expect(aSignal).not.toBe(bSignal);
    expect(aSignal?.aborted).toBe(true);
    expect(bSignal?.aborted).toBe(false);

    const byMethod = new Map(calls.map((call) => [call.method, call.options]));
    expect(byMethod.get("run-a-after-b-started")).toMatchObject({
      causalParent: causeA,
      readOnly: true,
      signal: aSignal,
    });
    for (const method of ["run-b-before-a-resumes", "run-b-after-a-finished"]) {
      const options = byMethod.get(method);
      expect(options).toMatchObject({ causalParent: causeB, signal: bSignal });
      expect(options?.readOnly).toBeUndefined();
    }
  });

  it("borrows the current admission for cached scope persistence without guest effect context", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    const scopeOperations: Array<{ method: string; options: RpcCallOptions | undefined }> = [];
    const fakeRpc = {
      selfId: "do:test:EvalDO:test-key",
      call: vi.fn((_target: string, method: string, _args: unknown[], options?: RpcCallOptions) => {
        if (method === "blobstore.getText") {
          scopeOperations.push({ method, options });
          return Promise.resolve("{}");
        }
        if (method === "blobstore.putText") {
          scopeOperations.push({ method, options });
          return Promise.resolve({ digest: "a".repeat(64), size: 2 });
        }
        return Promise.resolve(null);
      }),
      stream: vi.fn(),
      streamReadable: vi.fn(),
      emit: vi.fn(() => Promise.resolve()),
      on: vi.fn(() => vi.fn()),
      expose: vi.fn(),
      exposeAll: vi.fn(),
      exposeStreaming: vi.fn(),
      peer: vi.fn((targetId: string) => ({
        id: targetId,
        call: {},
        on: vi.fn(() => vi.fn()),
        emit: vi.fn(),
        withContract: vi.fn(),
      })),
      status: vi.fn(() => "connected"),
      ready: vi.fn(() => Promise.resolve()),
      onStatusChange: vi.fn(() => vi.fn()),
    };
    Object.defineProperty(instance, "rpc", { get: () => fakeRpc, configurable: true });
    (instance as unknown as { env: Record<string, unknown> }).env["EVAL_RUNTIME_SOURCE"] =
      "@workspace/runtime";
    setPriv(instance, "ensureRuntimeSupport", () =>
      Promise.resolve({
        createHostedRuntime: (host: Record<string, unknown>) => ({
          rpc: host["rpc"],
          fs: host["fs"],
        }),
        createPanelRuntime: () => ({ getPanelHandle: () => null }),
        createRuntimeSelfHandle: () => ({}),
        createGatewayFetch: () => () => {},
        createRpcFs: () => ({}),
        createRuntimeParentHandle: () => null,
        createServicesProxy: () => ({}),
        createAttachedHostsApi: () => ({}),
        createWorkerdClient: () => ({}),
      })
    );

    let persistenceBackend:
      | { putText(value: string): Promise<unknown>; getText(digest: string): Promise<unknown> }
      | undefined;
    let managerConstructions = 0;
    let retainedScopes: { save(): Promise<void> } | undefined;
    const engine = {
      SqlScopePersistence: class {
        readonly backend: {
          putText(value: string): Promise<unknown>;
          getText(digest: string): Promise<unknown>;
        };
        constructor(
          _sql: unknown,
          backend: {
            putText(value: string): Promise<unknown>;
            getText(digest: string): Promise<unknown>;
          }
        ) {
          this.backend = backend;
          persistenceBackend = backend;
        }
        async putBlob(value: string): Promise<void> {
          await this.backend.putText(value);
        }
      },
      ScopeManager: class {
        readonly current: Record<string, unknown> = {};
        apiFrom(resolvePersistence: () => { putBlob(value: string): Promise<void> }): {
          save(): Promise<void>;
        } {
          return { save: () => resolvePersistence().putBlob("{}") };
        }
        constructor() {
          managerConstructions += 1;
        }
        async hydrate(): Promise<void> {
          await persistenceBackend!.getText("a".repeat(64));
        }
        enterEval(): void {}
        async exitEval(): Promise<void> {
          await persistenceBackend!.putText("{}");
        }
        async persist(persistence: { putBlob(value: string): Promise<void> }): Promise<void> {
          await persistence.putBlob("{}");
        }
      },
      executeSandbox: async (_code: string, options: { bindings: Record<string, unknown> }) => {
        const scopes = options.bindings["scopes"] as { save(): Promise<void> };
        if (retainedScopes) await retainedScopes.save();
        else retainedScopes = scopes;
        return { success: true, consoleOutput: "", returnValue: undefined };
      },
    };
    setPriv(instance, "ensureEngine", () => Promise.resolve(engine));
    const runLocked = priv<RunLockedFn>(instance, "runLocked").bind(instance);
    const controllerA = new AbortController();
    await runLocked(
      {
        code: "A",
        contextId: "ctx",
        gatewayToken: "gateway-test",
        executionSessionNonce: "session-scope-a-123456",
        causalParent: {
          kind: "trajectory-invocation",
          logId: "trajectory:a",
          head: "main",
          invocationId: "invocation:a",
        },
        readOnly: true,
      },
      controllerA.signal,
      "run-a"
    );
    controllerA.abort();

    const controllerB = new AbortController();
    await runLocked(
      {
        code: "B",
        contextId: "ctx",
        gatewayToken: "gateway-test",
        executionSessionNonce: "session-scope-b-123456",
      },
      controllerB.signal,
      "run-b"
    );

    seedPendingRun(sql, "run-cleanup-persist", {
      executionSessionNonce: "session-scope-cleanup-123456",
      causalParent: {
        kind: "trajectory-invocation",
        logId: "trajectory:cleanup",
        head: "main",
        invocationId: "invocation:cleanup",
      },
      readOnly: true,
    });
    setPriv(instance, "engine", engine);
    await priv<(runId: string) => Promise<void>>(instance, "persistRunScope").call(
      instance,
      "run-cleanup-persist"
    );

    expect(managerConstructions).toBe(1);
    expect(scopeOperations.map(({ method }) => method)).toEqual([
      "blobstore.getText",
      "blobstore.putText",
      "blobstore.putText",
      "blobstore.putText",
      "blobstore.putText",
    ]);
    expect(scopeOperations.map(({ options }) => executionSessionNonceFor(options))).toEqual([
      "session-scope-a-123456",
      "session-scope-a-123456",
      "session-scope-b-123456",
      "session-scope-b-123456",
      "session-scope-cleanup-123456",
    ]);
    for (const { options } of scopeOperations) {
      expect(options?.causalParent).toBeUndefined();
      expect(options?.readOnly).toBeUndefined();
      expect(options?.signal).toBeUndefined();
    }
  });

  it("forceReset reports cleanup failures after completing the reset", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    seedPendingRun(sql, "cleanup-failure");
    sql.exec(`CREATE TABLE IF NOT EXISTS user_cleanup_probe (value TEXT)`);
    priv<Map<string, Set<() => Promise<void>>>>(instance, "runCancelHandlers").set(
      "cleanup-failure",
      new Set([async () => Promise.reject(new Error("cleanup failed"))])
    );

    await expect(
      priv<() => Promise<{ ok: boolean }>>(instance, "forceReset").call(instance)
    ).rejects.toThrow(/cancellation cleanup failed during force reset/i);

    expect(
      sql.exec(`SELECT name FROM sqlite_master WHERE name = 'user_cleanup_probe'`).toArray()
    ).toEqual([]);
    expect(
      sql.exec(`SELECT status FROM runs WHERE run_id = 'cleanup-failure'`).toArray()[0]
    ).toMatchObject({ status: "cancelled" });
  });

  it("startRun reset is atomic and idempotent on the run id", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    sql.exec(`CREATE TABLE IF NOT EXISTS user_reset_probe (value TEXT)`);
    sql.exec(`INSERT INTO user_reset_probe (value) VALUES ('before')`);
    sql.exec(`CREATE TABLE IF NOT EXISTS repl_scopes (id TEXT)`);
    setPriv(instance, "scopeManager", { marker: "stale" });

    const first = await priv<
      (args: { runId: string; code: string; reset: boolean }) => Promise<{
        runId: string;
        status: string;
        existing: boolean;
        runDigest: string;
        scopeInputRevision: string;
      }>
    >(instance, "startRun").call(instance, {
      runId: "reset-run",
      code: "return Object.keys(scope)",
      reset: true,
    });

    expect(first).toMatchObject({
      runId: "reset-run",
      status: "pending",
      existing: false,
      scopeInputRevision: "reset:reset-run",
      runDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const tablesAfterFirst = sql
      .exec(`SELECT name FROM sqlite_master WHERE type='table'`)
      .toArray()
      .map((row) => String(row["name"]));
    expect(tablesAfterFirst).not.toContain("user_reset_probe");
    expect(tablesAfterFirst).not.toContain("repl_scopes");

    sql.exec(`CREATE TABLE user_after_insert (value TEXT)`);
    const replay = await priv<
      (args: { runId: string; code: string; reset: boolean }) => Promise<{
        runId: string;
        status: string;
        existing: boolean;
        runDigest: string;
        scopeInputRevision: string;
      }>
    >(instance, "startRun").call(instance, {
      runId: "reset-run",
      code: "return Object.keys(scope)",
      reset: true,
    });

    expect(replay).toMatchObject({
      runId: "reset-run",
      status: "pending",
      existing: true,
      scopeInputRevision: first.scopeInputRevision,
      runDigest: first.runDigest,
    });
    expect(
      sql.exec(`SELECT name FROM sqlite_master WHERE name='user_after_insert'`).toArray()
    ).toHaveLength(1);
  });

  it("routes a retained cell-A panel handle through cell B's active execution", async () => {
    const { instance } = await createTestDO(EvalDO);
    const env = (instance as unknown as { env: Record<string, unknown> }).env;
    env["EVAL_CDP_CLIENT_SOURCE"] = "@workspace/cdp-client";
    const rpcA = { call: vi.fn(async () => "cell-a") };
    const rpcB = { call: vi.fn(async () => "cell-b") };
    const executionA = { contextId: "ctx", marker: "cell-a", rpc: rpcA };
    const executionB = { contextId: "ctx", marker: "cell-b", rpc: rpcB };
    let retainedLoadModule!: (id: string) => Promise<unknown>;
    const support = {
      createPanelRuntime: (options: Record<string, unknown>) => {
        retainedLoadModule = options["loadModule"] as (id: string) => Promise<unknown>;
        const retainedRpc = options["rpc"] as {
          call(targetId: string, method: string, args: unknown[]): Promise<unknown>;
        };
        return {
          getPanelHandle: () => ({
            cdp: { page: () => retainedLoadModule("@workspace/cdp-client") },
            rebuild: () => retainedRpc.call("main", "panel.rebuild", []),
          }),
        };
      },
      createHostedRuntime: (host: Record<string, unknown>) => ({
        getPanelHandle: (id: string) =>
          (host["panelRuntime"] as { getPanelHandle(id: string): unknown }).getPanelHandle(id),
      }),
      createRuntimeSelfHandle: () => ({}),
      createGatewayFetch: () => () => undefined,
      createRpcFs: () => ({}),
      createRuntimeParentHandle: () => null,
      createWorkerdClient: () => ({}),
    };
    const loaded = { BrowserImpl: { connect: vi.fn() } };
    const loadLibraryModule = vi.fn(async (_id: string, execution: unknown) => {
      expect(execution).toBe(executionB);
      return loaded;
    });
    setPriv(instance, "loadLibraryModule", loadLibraryModule);

    const runtime = priv<
      (
        support: unknown,
        execution: unknown,
        gatewayToken: string,
        parent: null
      ) => {
        getPanelHandle(id: string): {
          cdp: { page(): Promise<unknown> };
          rebuild(): Promise<unknown>;
        };
      }
    >(instance, "createRunHostedRuntime").call(
      instance,
      support,
      executionA,
      "gateway-token",
      null
    );
    const retainedHandle = runtime.getPanelHandle("panel:tree/retained");

    await expect(retainedHandle.cdp.page()).rejects.toThrow(/actively executing/);
    expect(() => retainedHandle.rebuild()).toThrow(/actively executing/);
    const activeExecution = priv<{
      run<T>(store: unknown, callback: () => T): T;
    }>(instance, "activeEvalExecution");
    await expect(activeExecution.run(executionB, () => retainedHandle.cdp.page())).resolves.toBe(
      loaded
    );
    await expect(activeExecution.run(executionB, () => retainedHandle.rebuild())).resolves.toBe(
      "cell-b"
    );
    expect(rpcA.call).not.toHaveBeenCalled();
    expect(rpcB.call).toHaveBeenCalledWith("main", "panel.rebuild", [], undefined);
    expect(loadLibraryModule).toHaveBeenCalledOnce();
  });

  it("routes runtime clients retained by a cell-A module through cell B's execution", async () => {
    const { instance } = await createTestDO(EvalDO);
    const rpcA = { call: vi.fn(async () => "cell-a") };
    const rpcB = { call: vi.fn(async () => "cell-b") };
    const openA = vi.fn(async () => ({ openedBy: "cell-a" }));
    const openB = vi.fn(async () => ({ openedBy: "cell-b" }));
    const executionA = {
      contextId: "ctx",
      rpc: rpcA,
      externalOpen: { openExternal: openA },
    };
    const executionB = {
      contextId: "ctx",
      rpc: rpcB,
      externalOpen: { openExternal: openB },
    };
    const support = {
      createPanelRuntime: () => ({}),
      createHostedRuntime: (host: Record<string, unknown>) => ({
        rpc: host["rpc"],
        fs: host["fs"],
        openExternal: host["openExternal"],
      }),
      createRuntimeSelfHandle: () => ({}),
      createGatewayFetch: () => () => undefined,
      createRpcFs: (rpc: { call: (...args: unknown[]) => Promise<unknown> }) => ({
        exists: () => rpc.call("main", "fs.exists", ["workers/vibe-board-agent"]),
      }),
      createRuntimeParentHandle: () => null,
      createWorkerdClient: () => ({}),
    };
    const runtime = priv<
      (
        support: unknown,
        execution: unknown,
        gatewayToken: string,
        parent: null
      ) => {
        fs: { exists(): Promise<unknown> };
        openExternal(url: string): Promise<unknown>;
      }
    >(instance, "createRunHostedRuntime").call(
      instance,
      support,
      executionA,
      "gateway-token",
      null
    );

    expect(() => runtime.fs.exists()).toThrow(/actively executing/);
    const activeExecution = priv<{
      run<T>(store: unknown, callback: () => T): T;
    }>(instance, "activeEvalExecution");
    await expect(activeExecution.run(executionB, () => runtime.fs.exists())).resolves.toBe(
      "cell-b"
    );
    await expect(
      activeExecution.run(executionB, () => runtime.openExternal("https://example.test"))
    ).resolves.toEqual({ openedBy: "cell-b" });

    expect(rpcA.call).not.toHaveBeenCalled();
    expect(openA).not.toHaveBeenCalled();
    expect(rpcB.call).toHaveBeenCalledWith(
      "main",
      "fs.exists",
      ["workers/vibe-board-agent"],
      undefined
    );
    expect(openB).toHaveBeenCalledWith("https://example.test", undefined);
  });

  it("runLocked endows isolate modules and threads abort into eval outbound rpc.call", async () => {
    // Verifies task 2a end-to-end through the REAL runLocked: the `rpc` binding handed to the sandbox
    // forwards the current run's signal as the rpc call's `options.signal`, so abort can unwind it.
    const { instance } = await createTestDO(EvalDO);

    // Capture the options every outbound rpc.call receives.
    const seenOptions: Array<{ method: string; options: unknown }> = [];
    const fakeRpc = {
      selfId: "do:test:EvalDO:test-key",
      call: vi.fn((_target: string, method: string, _args: unknown[], options?: unknown) => {
        seenOptions.push({ method, options });
        return Promise.resolve("ok");
      }),
      stream: vi.fn(),
      streamReadable: vi.fn(),
      emit: vi.fn(),
      on: vi.fn(() => vi.fn()),
      expose: vi.fn(),
      exposeAll: vi.fn(),
      exposeStreaming: vi.fn(),
      peer: vi.fn(() => ({})),
      status: vi.fn(() => "connected"),
      ready: vi.fn(() => Promise.resolve()),
      onStatusChange: vi.fn(() => vi.fn()),
    };
    // `runLocked` reads `this.rpc` for the binding closures — stub it.
    Object.defineProperty(instance, "rpc", { get: () => fakeRpc, configurable: true });

    // The runtime factories are loaded dynamically from the manifest-declared
    // runtime unit (providers.evalRuntime → EVAL_RUNTIME_SOURCE binding); the
    // host bundle carries no static workspace imports. Declare the provider on
    // the env and stub the loaded module with minimal factories — the rt's
    // `rpc` is the host's option-threading proxy, which is what this test pins.
    (instance as unknown as { env: Record<string, unknown> }).env["EVAL_RUNTIME_SOURCE"] =
      "@workspace/runtime";
    setPriv(instance, "ensureRuntimeSupport", () =>
      Promise.resolve({
        createHostedRuntime: (host: Record<string, unknown>) => ({
          rpc: host["rpc"],
          fs: host["fs"],
        }),
        createPanelRuntime: () => ({ getPanelHandle: () => null }),
        createRuntimeSelfHandle: () => ({}),
        createGatewayFetch: () => () => {},
        createRpcFs: () => ({}),
        createRuntimeParentHandle: () => null,
        createServicesProxy: () => ({}),
        createAttachedHostsApi: () => ({}),
        createWorkerdClient: () => ({}),
      })
    );

    // Stub the heavy engine path: capture the bindings, then invoke the eval's rpc binding ourselves.
    const fakeScope = {
      current: {},
      apiFrom: () => ({}),
      enterEval: () => {},
      exitEval: () => Promise.resolve(),
    };
    setPriv(instance, "ensureEngine", () =>
      Promise.resolve({
        SqlScopePersistence: class SqlScopePersistence {},
        executeSandbox: async (
          _code: string,
          opts: {
            bindings: Record<string, unknown>;
            moduleMap: Record<string, unknown>;
            require: (id: string) => unknown;
          }
        ) => {
          expect(opts.moduleMap["node:async_hooks"]).toBeUndefined();
          expect(() => opts.require("node:async_hooks")).toThrow(/not available in EvalDO/);
          const rpcBinding = opts.bindings["rpc"] as {
            call: (
              t: string,
              m: string,
              a: unknown[],
              options?: Record<string, unknown>
            ) => Promise<unknown>;
          };
          // Eval uses the same portable RpcClient call shape as panels/workers.
          await rpcBinding.call("main", "svc.method", [], {
            causalParent: {
              kind: "trajectory-invocation",
              logId: "trajectory:forged",
              head: "main",
              invocationId: "invocation:forged",
            },
          });
          await rpcBinding.call("do:peer", "ping", []);
          return { success: true, consoleOutput: "", returnValue: undefined };
        },
      })
    );
    setPriv(instance, "ensureScopeManager", () => Promise.resolve(fakeScope));

    const controller = new AbortController();
    const runLocked = priv<RunLockedFn>(instance, "runLocked").bind(instance);
    await runLocked(
      {
        code: "x",
        contextId: "ctx",
        gatewayToken: "gateway-test",
        causalParent: {
          kind: "trajectory-invocation",
          logId: "trajectory:bound",
          head: "main",
          invocationId: "invocation:parent",
        },
      },
      controller.signal,
      "run-sig"
    );

    // Both outbound calls carried the SAME run signal in their options.
    expect(seenOptions).toHaveLength(2);
    for (const { options } of seenOptions) {
      expect((options as { signal?: AbortSignal }).signal).toBe(controller.signal);
      expect((options as RpcCallOptions).causalParent).toEqual({
        kind: "trajectory-invocation",
        logId: "trajectory:bound",
        head: "main",
        invocationId: "invocation:parent",
      });
    }
    // And aborting the run's controller would unwind those calls (rpc client honors options.signal).
    expect(controller.signal.aborted).toBe(false);
  });

  it("detaches only post-settlement cleanup calls from the aborted run signal", async () => {
    const { instance } = await createTestDO(EvalDO);
    const calls: Array<RpcCallOptions | undefined> = [];
    const fakeRpc = {
      selfId: "do:test:EvalDO:test-key",
      call: vi.fn(
        (_target: string, _method: string, _args: unknown[], options?: RpcCallOptions) => {
          calls.push(options);
          return Promise.resolve(null);
        }
      ),
      stream: vi.fn(),
      streamReadable: vi.fn(),
      emit: vi.fn(() => Promise.resolve()),
      on: vi.fn(() => vi.fn()),
      expose: vi.fn(),
      exposeAll: vi.fn(),
      exposeStreaming: vi.fn(),
      peer: vi.fn(() => ({})),
      status: vi.fn(() => "connected"),
      ready: vi.fn(() => Promise.resolve()),
      onStatusChange: vi.fn(() => vi.fn()),
    };
    Object.defineProperty(instance, "rpc", { get: () => fakeRpc, configurable: true });
    const controller = new AbortController();
    const cleanupPhase = { active: false };
    const execution = priv<
      (
        input: { contextId: string; causalParent: null; readOnly: boolean },
        signal: AbortSignal,
        cleanup: { active: boolean }
      ) => { rpc: { call(target: string, method: string, args: unknown[]): Promise<unknown> } }
    >(instance, "createExecutionContext").call(
      instance,
      { contextId: "ctx", causalParent: null, readOnly: false },
      controller.signal,
      cleanupPhase
    );

    await execution.rpc.call("main", "before", []);
    controller.abort();
    cleanupPhase.active = true;
    await execution.rpc.call("main", "cleanup", []);

    expect(calls[0]?.signal).toBe(controller.signal);
    expect(calls[1]?.signal).toBeUndefined();
  });

  it("terminal settlement completes despite a wedged live event publisher", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { instance, sql } = await createTestDO(EvalDO);
    const call = vi.fn((_target: string, method: string) => {
      if (method === "evalEventIngress.publish") return new Promise<never>(() => {});
      return Promise.resolve(undefined);
    });
    Object.defineProperty(instance, "rpc", { value: { call }, configurable: true });
    setPriv(instance, "runLocked", () => Promise.resolve({ success: true, console: "" }));
    seedPendingRun(sql, "hung-publisher", {
      code: "return 1;",
      contextId: "ctx",
      executionSessionNonce: "session-hung-123456",
      eventSinkNonce: "sink-hung-123456",
    });

    const result = await priv<(id: string) => Promise<RunResult>>(instance, "executeRun").call(
      instance,
      "hung-publisher"
    );

    expect(result).toMatchObject({ success: true });
    expect(instance.getRun("hung-publisher")).toMatchObject({ status: "done" });
    expect(call).toHaveBeenCalledWith(
      "main",
      "evalEventIngress.publish",
      expect.anything(),
      expect.anything()
    );
    warn.mockRestore();
  });

  it("retains a post-terminal authority decision and reports no activity for a terminal run", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    seedPendingRun(sql, "authority-terminal");
    sql.exec(`UPDATE runs SET status = 'running' WHERE run_id = 'authority-terminal'`);
    instance.appendAuthorityEvent("authority-terminal", "authority-requested", {
      acquisitionId: "acq-9",
    });
    const append = priv<(runId: string, kind: string, payload: unknown) => boolean>(
      instance,
      "appendRunEvent"
    );
    append.call(instance, "authority-terminal", "state", { status: "failed" });
    sql.exec(
      `UPDATE runs SET status = 'done', result = '{"success":false,"console":""}'
        WHERE run_id = 'authority-terminal'`
    );

    // A terminal run whose LAST authority event is a request must not report a
    // permanently pending authority ask.
    expect(instance.getRun("authority-terminal").activity).toBeUndefined();

    // The late decision is audit and must be retained after terminal…
    instance.appendAuthorityEvent("authority-terminal", "authority-decided", {
      acquisitionId: "acq-9",
      decision: "deny",
    });
    // …while ordinary post-terminal events stay absorbed.
    expect(append.call(instance, "authority-terminal", "progress", { step: 1 })).toBe(false);
    expect(append.call(instance, "authority-terminal", "state", { status: "running" })).toBe(false);
    const kinds = sql
      .exec(`SELECT kind FROM run_events WHERE run_id = 'authority-terminal' ORDER BY sequence`)
      .toArray()
      .map((row) => String(row["kind"]));
    expect(kinds.at(-1)).toBe("authority-decided");
    expect(kinds.filter((kind) => kind === "progress")).toHaveLength(0);
  });

  it("stamps planned lifecycle cancellation as runtime_generation_lost, distinct from user cancel", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    const lifecycleCall = vi.fn(() => Promise.resolve(undefined));
    Object.defineProperty(instance, "rpc", { value: { call: lifecycleCall }, configurable: true });
    seedPendingRun(sql, "lifecycle-pending");
    seedPendingRun(sql, "user-cancelled");
    await priv<(id: string) => Promise<unknown>>(instance, "cancel").call(
      instance,
      "user-cancelled"
    );

    await expect(
      instance.releaseForLifecycle({
        epoch: "e-codes",
        mode: "suspend",
        reason: "test",
        deadlineMs: 1_000,
      })
    ).resolves.toEqual({ status: "ready" });

    expect(instance.getRun("lifecycle-pending")).toMatchObject({
      status: "cancelled",
      result: {
        success: false,
        failureKind: "infrastructure",
        failureCode: "runtime_generation_lost",
      },
    });
    // User cancellation stays untyped-by-lifecycle: no infrastructure stamp.
    const userRun = instance.getRun("user-cancelled");
    expect(userRun.status).toBe("cancelled");
    expect(userRun.result).toBeUndefined();
  });

  it("retries a failed terminal push through a bounded alarm and stops after success", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { instance, sql } = await createTestDO(EvalDO);
    let failures = 1;
    const receiver = "do:workers/agent-worker:AiChatWorker:agent-1";
    const call = vi.fn((_target: string, method: string) => {
      if (method === "onEvalComplete") {
        if (failures > 0) {
          failures -= 1;
          return Promise.reject(new Error("receiver unavailable"));
        }
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });
    Object.defineProperty(instance, "rpc", { value: { call }, configurable: true });
    setPriv(instance, "runLocked", () =>
      Promise.resolve({ success: true, console: "", returnValue: 3 })
    );

    await instance.startRun({
      runId: "redeliver-run",
      code: "return 3",
      agentRef: receiver,
      resultReceiverRef: receiver,
      agentInvocationId: "invocation-redeliver",
      channelId: "channel-1",
      executionSessionNonce: "session-redeliver-123456",
    });
    await vi.waitFor(() => {
      expect(instance.getRun("redeliver-run")).toMatchObject({ status: "done" });
      expect(call.mock.calls.filter(([, method]) => method === "onEvalComplete")).toHaveLength(1);
    });
    const deliveryCalls = call.mock.calls as unknown as Array<
      [string, string, unknown[], RpcCallOptions]
    >;
    const firstDelivery = deliveryCalls.find(([, method]) => method === "onEvalComplete");
    expect(executionSessionNonceFor(firstDelivery?.[3])).toBe("session-redeliver-123456");
    // The failed push durably queued one redelivery entry.
    await vi.waitFor(() => {
      expect(redeliveryState(sql)).toEqual({ "redeliver-run": 1 });
    });

    // The alarm redelivers idempotently and clears its slot on success.
    await expect(instance.alarm()).resolves.toBeNull();
    expect(call.mock.calls.filter(([, method]) => method === "onEvalComplete")).toHaveLength(2);
    expect(redeliveryState(sql)).toEqual({});
    warn.mockRestore();
  });

  it("stops terminal-push redelivery after its bounded attempt budget", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { instance, sql } = await createTestDO(EvalDO);
    const receiver = "do:workers/agent-worker:AiChatWorker:agent-1";
    const call = vi.fn((_target: string, method: string) => {
      if (method === "onEvalComplete") return Promise.reject(new Error("receiver gone"));
      return Promise.resolve(undefined);
    });
    Object.defineProperty(instance, "rpc", { value: { call }, configurable: true });
    setPriv(instance, "runLocked", () => Promise.resolve({ success: true, console: "" }));

    await instance.startRun({
      runId: "redeliver-exhaust",
      code: "return 1",
      agentRef: receiver,
      resultReceiverRef: receiver,
      agentInvocationId: "invocation-exhaust",
      channelId: "channel-1",
      executionSessionNonce: "session-exhaust-123456",
    });
    await vi.waitFor(() => expect(redeliveryState(sql)).toEqual({ "redeliver-exhaust": 1 }));

    // attempt 1 → 2, 2 → 3 keep an alarm scheduled; attempt 3 exhausts the budget.
    await expect(instance.alarm()).resolves.toMatchObject({ wakeAt: expect.any(Number) });
    expect(redeliveryState(sql)).toEqual({ "redeliver-exhaust": 2 });
    await expect(instance.alarm()).resolves.toMatchObject({ wakeAt: expect.any(Number) });
    expect(redeliveryState(sql)).toEqual({ "redeliver-exhaust": 3 });
    await expect(instance.alarm()).resolves.toBeNull();
    expect(redeliveryState(sql)).toEqual({});
    warn.mockRestore();
  });

  it("retains a terminal push queued while an alarm is awaiting another receiver", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    const receiver = "do:workers/agent-worker:AiChatWorker:agent-1";
    for (const runId of ["redeliver-in-flight", "redeliver-concurrent"]) {
      seedPendingRun(sql, runId, {
        runId,
        code: "return 1",
        resultReceiverRef: receiver,
        agentInvocationId: `invocation-${runId}`,
        channelId: "channel-1",
        executionSessionNonce: `session-${runId}-123456`,
      });
      sql.exec(
        `UPDATE runs SET status = 'done', result = ? WHERE run_id = ?`,
        JSON.stringify({ success: true, console: "", returnValue: 1 }),
        runId
      );
    }

    let releaseFirst!: () => void;
    const firstDelivery = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstDeliveryStarted!: () => void;
    const firstDeliveryIsWaiting = new Promise<void>((resolve) => {
      firstDeliveryStarted = resolve;
    });
    const call = vi.fn((_target: string, method: string, args: unknown[]) => {
      if (method !== "onEvalComplete") return Promise.resolve(undefined);
      const runId = (args[0] as { runId: string }).runId;
      if (runId === "redeliver-in-flight") {
        firstDeliveryStarted();
        return firstDelivery;
      }
      return Promise.resolve(undefined);
    });
    Object.defineProperty(instance, "rpc", { value: { call }, configurable: true });

    priv<(runId: string, attempt: number) => void>(instance, "scheduleResultRedelivery").call(
      instance,
      "redeliver-in-flight",
      1
    );
    const alarm = instance.alarm();
    await firstDeliveryIsWaiting;

    // An external RPC await opens the DO input gate. A second run can fail its
    // terminal push and enqueue itself while this alarm is waiting.
    priv<(runId: string, attempt: number) => void>(instance, "scheduleResultRedelivery").call(
      instance,
      "redeliver-concurrent",
      1
    );
    releaseFirst();
    await expect(alarm).resolves.toMatchObject({ wakeAt: expect.any(Number) });

    expect(redeliveryState(sql)).toEqual({ "redeliver-concurrent": 1 });
  });

  it("keeps a non-abort failure after a fired deadline out of the timeout classification", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { instance, sql } = await createTestDO(EvalDO);
    setPriv(
      instance,
      "runLocked",
      (_args: unknown, signal?: AbortSignal) =>
        new Promise<RunResult>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(new TypeError("cleanup dereferenced a torn-down handle"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => reject(new TypeError("cleanup dereferenced a torn-down handle")),
            { once: true }
          );
        })
    );
    seedPendingRun(sql, "deadline-nonabort", { code: "await never();", timeoutMs: 5 });
    sql.exec(
      `UPDATE runs SET deadline_at = ? WHERE run_id = ?`,
      Date.now() + 5,
      "deadline-nonabort"
    );

    const result = await priv<(id: string) => Promise<RunResult>>(instance, "executeRun").call(
      instance,
      "deadline-nonabort"
    );

    // Not the deadline: the error is unrelated to the abort, so it keeps its
    // own classification and is logged at warn instead of being suppressed.
    expect(result).toMatchObject({
      success: false,
      failureKind: "infrastructure",
      failureCode: "eval_host_failed",
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("deadline-nonabort"),
      expect.stringContaining("cleanup dereferenced a torn-down handle")
    );
    expect(errorLog).not.toHaveBeenCalled();
    warn.mockRestore();
    errorLog.mockRestore();
  });

  it("surfaces execution-admission loss as recoverable without blindly replaying the cell", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { instance, sql } = await createTestDO(EvalDO);
    setPriv(instance, "runLocked", () =>
      Promise.reject(
        Object.assign(new Error("Evaluated execution session is not active"), {
          code: "EVALUATED_EXECUTION_SESSION_NOT_ACTIVE",
        })
      )
    );
    seedPendingRun(sql, "admission-lost", { code: "await performEffect()" });

    const result = await priv<(id: string) => Promise<RunResult>>(instance, "executeRun").call(
      instance,
      "admission-lost"
    );

    expect(result).toMatchObject({
      success: false,
      failureKind: "infrastructure",
      failureCode: "eval_execution_admission_lost",
      errorData: {
        retry: { policy: "reobserve", commandIdPolicy: "use-new-after-reobserve" },
        recovery: { action: "reobserve", instruction: expect.stringContaining("unfinished work") },
      },
    });
    errorLog.mockRestore();
  });

  it("refreshes host credentials when a start replay lands on a cancelling run", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    seedPendingRun(sql, "cancelling-redrive", {
      runId: "cancelling-redrive",
      code: "return 7",
      intentDigest: "i".repeat(64),
      gatewayToken: "gateway-old",
      executionSessionNonce: "session-old",
      eventSinkNonce: "sink-old",
    });
    sql.exec(`UPDATE runs SET status = 'cancelling' WHERE run_id = 'cancelling-redrive'`);
    const runLocked = vi.fn();
    setPriv(instance, "runLocked", runLocked);

    await expect(
      instance.startRun({
        runId: "cancelling-redrive",
        code: "return 7",
        intentDigest: "i".repeat(64),
        gatewayToken: "gateway-new",
        executionSessionNonce: "session-new",
        eventSinkNonce: "sink-new",
      })
    ).resolves.toMatchObject({ status: "cancelling", existing: true });

    const stored = JSON.parse(
      String(
        sql.exec(`SELECT args FROM runs WHERE run_id = 'cancelling-redrive'`).toArray()[0]?.["args"]
      )
    ) as Record<string, unknown>;
    // The freshly prepared admission owns the event route, so the tail of the
    // cancellation (its terminal event) reaches the NEW sink.
    expect(stored).toMatchObject({
      gatewayToken: "gateway-new",
      executionSessionNonce: "session-new",
      eventSinkNonce: "sink-new",
    });
    // A cancelling run is never (re)attached to execution.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(runLocked).not.toHaveBeenCalled();
  });
});
