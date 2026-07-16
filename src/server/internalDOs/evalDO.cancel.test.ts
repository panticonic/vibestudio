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
import { EvalDO } from "./evalDO.js";

type RunResult = { success: boolean; console: string; returnValue?: unknown; error?: string };
type RunLockedFn = (args: unknown, signal?: AbortSignal, runId?: string) => Promise<RunResult>;

/** Access a private method/field on the instance without TS visibility friction (test-only). */
function priv<T = unknown>(instance: object, key: string): T {
  return (instance as unknown as Record<string, unknown>)[key] as T;
}
function setPriv(instance: object, key: string, value: unknown): void {
  (instance as unknown as Record<string, unknown>)[key] = value;
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
  sql.exec(
    `INSERT INTO runs (run_id, args, agent_ref, channel_id, status, started_at, deadline_at)
     VALUES (?, ?, NULL, NULL, 'pending', ?, NULL)`,
    runId,
    JSON.stringify(args),
    Date.now()
  );
}

describe("EvalDO cancellation + forced recovery", () => {
  it("pages large scope text losslessly without creating eval runs and persists cleanup", async () => {
    const { instance } = await createTestDO(EvalDO);
    const value = `before-${"😀\u0000".repeat(60_000)}-after`;
    const current: Record<string, unknown> = { temporary: value };
    const enterEval = vi.fn();
    const exitEval = vi.fn(() => Promise.resolve());
    setPriv(instance, "ensureEngine", () => Promise.resolve({}));
    setPriv(instance, "scopeManager", {
      current,
      api: {},
      hydrate: () => Promise.resolve(),
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
    const { instance } = await createTestDO(EvalDO);
    await instance.startRun({
      runId: "run-progress",
      code: "return 1",
      syntax: "typescript",
    });

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
    expect(result.console).toContain("scope.$lastConsole");
    expect(result.returnValue).toMatchObject({
      truncated: true,
      scopeKey: "$lastReturn",
    });

    const persisted = priv<(id: string) => { status: string; result?: RunResult }>(
      instance,
      "getRun"
    ).call(instance, "huge-run");
    expect(persisted.status).toBe("done");
    expect(persisted.result).toEqual(result);
    expect(JSON.stringify(persisted.result).length).toBeLessThan(250_000);
  });

  it("retains a small structured return for REPL-style follow-up inspection", async () => {
    const { instance } = await createTestDO(EvalDO);
    const scope: Record<string, unknown> = {};

    priv<(scope: Record<string, unknown>, console: string, value: unknown) => void>(
      instance,
      "spillLargeOutput"
    ).call(instance, scope, "", { methods: { inspect: true } });

    expect(scope["$lastReturn"]).toEqual({ methods: { inspect: true } });
  });

  it("cancel(runId): an in-flight run wedged on an outbound call unwinds once cancelled", async () => {
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
      expect(signal!.aborted).toBe(false);
    });
    priv<Map<string, Set<() => Promise<void>>>>(instance, "runCancelHandlers").set(
      "run-A",
      new Set([cleanup])
    );

    // Cancel: CAS row → cancelled, then abort the controller threaded into the run.
    const cancelRet = await priv<(id: string) => Promise<{ ok: boolean }>>(instance, "cancel").call(
      instance,
      "run-A"
    );
    expect(cancelRet).toEqual({ ok: true });
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
    expect(ret).toEqual({ ok: true });
    // The done run is NOT flipped to cancelled (CAS only touches pending/running), and `other` is untouched.
    expect(sql.exec(`SELECT status FROM runs WHERE run_id = 'done-1'`).toArray()[0]).toMatchObject({
      status: "done",
    });
    expect(sql.exec(`SELECT status FROM runs WHERE run_id = 'other'`).toArray()[0]).toMatchObject({
      status: "pending",
    });
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

  it("forceReset(): a wedged run on runChain does not block a later run, and tables/scope are cleared", async () => {
    const { instance, sql } = await createTestDO(EvalDO);

    // 1) A wedged run that holds `runChain` forever (never aborts on its own).
    const { runLocked: wedge, started: wedgeStarted } = blockUntilAborted();
    setPriv(instance, "runLocked", wedge);
    seedPendingRun(sql, "wedged");
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
    expect(signal?.aborted).toBe(false);
    releaseCleanup();
    const forceRet = await forcePromise;
    expect(forceRet).toEqual({ ok: true });

    // The wedged run was CAS'd to cancelled and aborted (so it unwinds rather than leaking forever).
    expect(sql.exec(`SELECT status FROM runs WHERE run_id = 'wedged'`).toArray()[0]).toMatchObject({
      status: "cancelled",
    });
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
        createWorkerdClient: () => ({}),
      })
    );
    const fakeScope = {
      current: {},
      api: {},
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

  it("keeps cached scope persistence outside every run execution context", async () => {
    const { instance } = await createTestDO(EvalDO);
    const scopeWrites: Array<RpcCallOptions | undefined> = [];
    const fakeRpc = {
      selfId: "do:test:EvalDO:test-key",
      call: vi.fn((_target: string, method: string, _args: unknown[], options?: RpcCallOptions) => {
        if (method === "blobstore.putText") {
          scopeWrites.push(options);
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
        createWorkerdClient: () => ({}),
      })
    );

    let persistenceBackend:
      | { putText(value: string): Promise<unknown>; getText(digest: string): Promise<unknown> }
      | undefined;
    let managerConstructions = 0;
    const engine = {
      SqlScopePersistence: class {
        constructor(
          _sql: unknown,
          backend: {
            putText(value: string): Promise<unknown>;
            getText(digest: string): Promise<unknown>;
          }
        ) {
          persistenceBackend = backend;
        }
      },
      ScopeManager: class {
        readonly current: Record<string, unknown> = {};
        readonly api = {};
        constructor() {
          managerConstructions += 1;
        }
        hydrate(): Promise<void> {
          return Promise.resolve();
        }
        enterEval(): void {}
        async exitEval(): Promise<void> {
          await persistenceBackend!.putText("{}");
        }
      },
      executeSandbox: () =>
        Promise.resolve({ success: true, consoleOutput: "", returnValue: undefined }),
    };
    setPriv(instance, "ensureEngine", () => Promise.resolve(engine));
    const runLocked = priv<RunLockedFn>(instance, "runLocked").bind(instance);
    const controllerA = new AbortController();
    await runLocked(
      {
        code: "A",
        contextId: "ctx",
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
    await runLocked({ code: "B", contextId: "ctx" }, controllerB.signal, "run-b");

    expect(managerConstructions).toBe(1);
    expect(scopeWrites).toHaveLength(2);
    for (const options of scopeWrites) {
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
      }>
    >(instance, "startRun").call(instance, {
      runId: "reset-run",
      code: "return Object.keys(scope)",
      reset: true,
    });

    expect(first).toEqual({ runId: "reset-run", status: "pending" });
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
      }>
    >(instance, "startRun").call(instance, {
      runId: "reset-run",
      code: "return Object.keys(scope)",
      reset: true,
    });

    expect(replay).toEqual({ runId: "reset-run", status: "pending" });
    expect(
      sql.exec(`SELECT name FROM sqlite_master WHERE name='user_after_insert'`).toArray()
    ).toHaveLength(1);
  });

  it("runLocked threads the run's abort signal into eval outbound rpc.call", async () => {
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
        createWorkerdClient: () => ({}),
      })
    );

    // Stub the heavy engine path: capture the bindings, then invoke the eval's rpc binding ourselves.
    const fakeScope = {
      current: {},
      api: {},
      enterEval: () => {},
      exitEval: () => Promise.resolve(),
    };
    setPriv(instance, "ensureEngine", () =>
      Promise.resolve({
        executeSandbox: async (_code: string, opts: { bindings: Record<string, unknown> }) => {
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
});
