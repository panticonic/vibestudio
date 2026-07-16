import { describe, expect, it, vi } from "vitest";
import { createTestDO } from "@vibestudio/durable/test-utils";
import { EvalDO } from "./evalDO.js";

type RunResult = {
  success: boolean;
  console: string;
  returnValue?: unknown;
  error?: string;
  errorCode?: string;
};
type RunLockedFn = (...args: unknown[]) => Promise<RunResult>;
type Sql = { exec: (query: string, ...bindings: unknown[]) => unknown };

function priv<T = unknown>(instance: object, key: string): T {
  return (instance as Record<string, unknown>)[key] as T;
}

function setPriv(instance: object, key: string, value: unknown): void {
  (instance as Record<string, unknown>)[key] = value;
}

const policy = {
  mode: "adaptive" as const,
  effects: "mutable" as const,
  approvals: "prompt" as const,
  requests: [],
};

function seedPreparedRun(
  instance: EvalDO,
  sql: Sql,
  runId: string,
  options: { status?: string; deadlineAt?: number | null } = {}
): void {
  sql.exec(
    `INSERT INTO eval_runs_v3
      (run_id, args, status, accepted_at, started_at, deadline_at, start_intent_digest,
       source_digest, source_bundle_digest, manifest_digest, run_digest)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    runId,
    JSON.stringify({ code: "return 1", contextId: "ctx" }),
    options.status ?? "preparing",
    Date.now(),
    Date.now(),
    options.deadlineAt ?? null,
    "a".repeat(64),
    "b".repeat(64),
    "c".repeat(64),
    "d".repeat(64),
    "e".repeat(64)
  );
  priv<Map<string, unknown>>(instance, "invocationLeases").set(runId, {
    credential: "credential",
    policy,
  });
  setPriv(instance, "evalClient", {
    beginCleanup: vi.fn(async () => ({ expiresAt: Date.now() + 30_000 })),
    renew: vi.fn(async () => ({ expiresAt: Date.now() + 30_000 })),
  });
}

function blockUntilAborted(): {
  runLocked: RunLockedFn;
  started: Promise<AbortSignal>;
} {
  let resolveStarted!: (signal: AbortSignal) => void;
  const started = new Promise<AbortSignal>((resolve) => {
    resolveStarted = resolve;
  });
  const runLocked: RunLockedFn = async (_args, signal) =>
    await new Promise<RunResult>((_resolve, reject) => {
      const abort = signal as AbortSignal;
      resolveStarted(abort);
      if (abort.aborted) return reject(new Error("aborted"));
      abort.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  return { runLocked, started };
}

describe("EvalDO lifecycle, cancellation, and recovery", () => {
  it("pages and deletes persistent scope text without creating a run", async () => {
    const { instance } = await createTestDO(EvalDO);
    const value = `before-${"😀\u0000".repeat(60_000)}-after`;
    const current: Record<string, unknown> = { temporary: value };
    const exitEval = vi.fn(async () => undefined);
    setPriv(instance, "ensureEngine", async () => ({}));
    setPriv(instance, "scopeManager", {
      current,
      api: {},
      hydrate: async () => undefined,
      enterEval: vi.fn(),
      exitEval,
    });

    const first = await instance.readScopeTextPage("temporary", 0, 131_072);
    const second = await instance.readScopeTextPage("temporary", 131_072, 131_072);
    const decode = (chunk: string) => Buffer.from(chunk, "base64").toString("utf16le");
    expect(decode(first.chunk) + decode(second.chunk)).toBe(value);
    await expect(instance.deleteScopeValue("temporary")).resolves.toEqual({
      ok: true,
      existed: true,
    });
    expect(current).not.toHaveProperty("temporary");
    expect(exitEval).toHaveBeenCalledOnce();
  });

  it("accept is idempotent for identical intent and conflicts on changed input", async () => {
    const { instance } = await createTestDO(EvalDO);
    const input = {
      runId: "run-idempotent",
      startIntentDigest: "a".repeat(64),
      deadlineAt: null,
    };
    const first = instance.accept(input);
    const replay = instance.accept(input);
    expect(first).toMatchObject({ status: "accepted", needsStart: true });
    expect(replay).toEqual({ ...first, needsStart: false });
    expect(() => instance.accept({ ...input, startIntentDigest: "b".repeat(64) })).toThrow(
      /different input/
    );
  });

  it("persists host-classified terminal failures without rewriting their error code", async () => {
    const { instance } = await createTestDO(EvalDO);
    instance.accept({
      runId: "run-preparation-failed",
      startIntentDigest: "a".repeat(64),
      deadlineAt: null,
    });

    expect(
      instance.terminate({
        runId: "run-preparation-failed",
        status: "failed",
        error: "source bundle is too large",
        errorCode: "EVAL_RESOURCE_LIMIT",
      })
    ).toEqual({ status: "failed" });
    expect(instance.get("run-preparation-failed")).toMatchObject({
      status: "failed",
      result: {
        success: false,
        error: "source bundle is too large",
        errorCode: "EVAL_RESOURCE_LIMIT",
      },
    });
  });

  it("preserves every eval kernel table when resetting user scope", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    sql.exec(`CREATE TABLE user_scratch (value TEXT)`);

    await expect(instance.reset()).resolves.toEqual({ status: "reset" });

    const tables = new Set(
      (
        sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table'`).toArray() as Array<{
          name: string;
        }>
      ).map((row) => row.name)
    );
    expect([...tables]).toEqual(
      expect.arrayContaining([
        "state",
        "eval_runs_v3",
        "eval_run_progress_v3",
        "eval_run_events_v3",
        "eval_retained_modules_v1",
        "eval_run_owned_contexts_v1",
      ])
    );
    expect(tables.has("user_scratch")).toBe(false);
    expect(tables.has("repl_scopes")).toBe(false);
  });

  it("persists bounded run progress without queueing another eval", async () => {
    const { instance } = await createTestDO(EvalDO);
    instance.accept({
      runId: "run-progress",
      startIntentDigest: "a".repeat(64),
      deadlineAt: null,
    });
    priv<(runId: string, progress: unknown) => void>(instance, "persistRunProgress").call(
      instance,
      "run-progress",
      { active: ["fs-write-read"], completed: 2 }
    );
    expect(instance.get("run-progress")).toMatchObject({
      status: "accepted",
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

  it("makes a suspended authority challenge visible and resumes the same live run", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    seedPreparedRun(instance, sql, "run-challenge", { status: "running" });
    expect(
      instance.authorityChallenge({
        runId: "run-challenge",
        phase: "run",
        waiting: true,
        capability: "service:externalOpen.open",
        resourceKey: "https://example.com",
      })
    ).toEqual({ status: "awaiting-challenge" });
    expect(instance.get("run-challenge")).toMatchObject({ status: "awaiting-challenge" });
    expect(
      instance.authorityChallenge({
        runId: "run-challenge",
        phase: "run",
        waiting: false,
        capability: "service:externalOpen.open",
        resourceKey: "https://example.com",
      })
    ).toEqual({ status: "running" });
    expect(instance.get("run-challenge")).toMatchObject({ status: "running" });
  });

  it.each(["accepted", "preparing", "running"])(
    "keeps a durable %s run resident",
    async (status) => {
      const { instance, sql } = await createTestDO(EvalDO);
      seedPreparedRun(instance, sql, `active-${status}`, { status });
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      const setAlarmAt = vi
        .spyOn(instance as never, "setAlarmAt")
        .mockImplementation(() => undefined);
      await instance.alarm();
      expect(setAlarmAt).toHaveBeenCalledWith(expect.any(Number), { bestEffort: true });
      expect(info).toHaveBeenCalledWith(
        "[EvalDO] idle eviction alarm",
        expect.objectContaining({ durableRuns: 1 })
      );
    }
  );

  it("executes once and stores a bounded terminal result", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    const cleanup = vi.fn(async () => undefined);
    const hugeConsole = `console-start\n${"c".repeat(220_000)}\nconsole-end`;
    const hugeReturn = { value: `return-start\n${"r".repeat(220_000)}\nreturn-end` };
    const runLocked = vi.fn<RunLockedFn>(async () => ({
      success: true,
      console: hugeConsole,
      returnValue: hugeReturn,
    }));
    setPriv(instance, "runLocked", runLocked);
    seedPreparedRun(instance, sql, "huge-run");
    priv<Map<string, Set<() => Promise<void>>>>(instance, "runCleanupHandlers").set(
      "huge-run",
      new Set([cleanup])
    );

    const result = await instance.execute("huge-run");
    expect(runLocked.mock.calls[0]?.[6]).toBe("e".repeat(64));
    expect(result.success).toBe(true);
    expect(result.console.length).toBeLessThan(100_000);
    expect(result.console).toContain("scope.$lastConsole");
    expect(result.returnValue).toMatchObject({ truncated: true, scopeKey: "$lastReturn" });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(instance.get("huge-run")).toMatchObject({ status: "succeeded", result });
    const annotated = instance.attachAuthoritySummary("huge-run", {
      manifestDigest: "d".repeat(64),
      activated: [],
      approvalsRequested: 0,
      approvalsReused: 0,
      approvalsDenied: 0,
      constraintFailures: 0,
    });
    expect(annotated).toMatchObject({
      provenance: {
        startIntentDigest: "a".repeat(64),
        sourceDigest: "b".repeat(64),
        runDigest: "e".repeat(64),
        sourceBundleDigest: "c".repeat(64),
        manifestDigest: "d".repeat(64),
      },
      authority: { approvalsRequested: 0 },
    });
  });

  it("cancels a live run at its awaited outbound boundary without resurrecting it", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    const kernelCall = vi.fn(async () => undefined);
    setPriv(instance, "connectionless", { client: { call: kernelCall } });
    const blocked = blockUntilAborted();
    setPriv(instance, "runLocked", blocked.runLocked);
    seedPreparedRun(instance, sql, "run-cancel");
    // runLocked normally installs this live invocation before user code starts;
    // the test replaces runLocked with an abort boundary, so install its state explicitly.
    setPriv(instance, "currentEvalInvocation", {
      runId: "run-cancel",
      credential: "credential",
    });
    priv<(runId: string, method: string, args: unknown[], result: unknown) => void>(
      instance,
      "observeAuthoredLifecycleCall"
    ).call(
      instance,
      "run-cancel",
      "runtime.createEntity",
      [{ kind: "do", source: "workers/agent", className: "AgentDO" }],
      { id: "do:workers/agent:AgentDO:child", contextId: "ctx-child" }
    );

    const execution = instance.execute("run-cancel");
    const signal = await blocked.started;
    expect(signal.aborted).toBe(false);
    const cleanup = vi.fn(async () => {
      expect(signal.aborted).toBe(true);
      const cleanupContext = priv<{
        getStore(): { phase: string; signal?: AbortSignal } | undefined;
      }>(instance, "authoredCallContext").getStore();
      expect(cleanupContext?.phase).toBe("cleanup");
      expect(cleanupContext?.signal).not.toBe(signal);
      expect(cleanupContext?.signal?.aborted).toBe(false);
      const cleanupOptions = priv<() => { signal: AbortSignal }>(
        instance,
        "currentRunCallOptions"
      ).call(instance);
      expect(cleanupOptions.signal).toBe(cleanupContext?.signal);
    });
    priv<Map<string, Set<() => Promise<void>>>>(instance, "runCleanupHandlers").set(
      "run-cancel",
      new Set([cleanup])
    );
    await expect(instance.cancel("run-cancel")).resolves.toEqual({ status: "requested" });
    expect(signal.aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(kernelCall).toHaveBeenCalledWith("main", "runtime.cleanupEvalOwnedContext", [
      {
        contextId: "ctx-child",
        ownerEntityId: "do:workers/agent:AgentDO:child",
        recursive: true,
      },
    ]);
    await expect(execution).resolves.toMatchObject({
      success: false,
      error: "eval: run cancelled",
    });
    expect(instance.get("run-cancel")).toMatchObject({ status: "cancelled" });
  });

  it("persists and annotates cancellation before execution begins", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    seedPreparedRun(instance, sql, "run-cancel-before-execute");

    await expect(instance.cancel("run-cancel-before-execute")).resolves.toEqual({
      status: "cancelled",
    });
    const terminal = instance.get("run-cancel-before-execute");
    expect(terminal).toMatchObject({
      status: "cancelled",
      result: {
        success: false,
        error: "eval: run cancelled",
        errorCode: "EVAL_CANCELLED",
      },
    });
    await expect(instance.execute("run-cancel-before-execute")).resolves.toMatchObject({
      success: false,
      error: "eval: run cancelled",
      errorCode: "EVAL_CANCELLED",
    });
    expect(
      instance.attachAuthoritySummary("run-cancel-before-execute", { approvalsRequested: 0 })
    ).toMatchObject({
      success: false,
      errorCode: "EVAL_CANCELLED",
      authority: { approvalsRequested: 0 },
    });
    expect(instance.events("run-cancel-before-execute").events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "terminal", status: "cancelled" })])
    );
  });

  it("automatically owns fresh runtime contexts and permits explicit detachment", async () => {
    const { instance } = await createTestDO(EvalDO);
    instance.accept({
      runId: "run-owned",
      startIntentDigest: "a".repeat(64),
      deadlineAt: null,
    });
    const kernelCall = vi.fn(async () => undefined);
    setPriv(instance, "connectionless", { client: { call: kernelCall } });
    const observe = priv<(runId: string, method: string, args: unknown[], result: unknown) => void>(
      instance,
      "observeAuthoredLifecycleCall"
    );

    observe.call(
      instance,
      "run-owned",
      "runtime.createEntity",
      [{ kind: "do", source: "workers/agent", className: "AgentDO" }],
      { id: "do:workers/agent:AgentDO:owned", contextId: "ctx-owned" }
    );
    observe.call(
      instance,
      "run-owned",
      "runtime.createEntity",
      [{ kind: "do", contextId: "ctx-shared" }],
      { id: "do:workers/agent:AgentDO:shared", contextId: "ctx-shared" }
    );
    expect(
      priv<(runId: string, contextId: string) => boolean>(instance, "detachRunOwnedContext").call(
        instance,
        "run-owned",
        "ctx-owned"
      )
    ).toBe(true);
    observe.call(
      instance,
      "run-owned",
      "runtime.createEntity",
      [{ kind: "worker", source: "workers/task" }],
      { id: "worker:workers/task:owned", contextId: "ctx-cleanup" }
    );
    await priv<(runId: string) => Promise<void>>(instance, "executeRunCleanupHandlers").call(
      instance,
      "run-owned"
    );
    expect(kernelCall).toHaveBeenCalledWith("main", "runtime.cleanupEvalOwnedContext", [
      {
        contextId: "ctx-cleanup",
        ownerEntityId: "worker:workers/task:owned",
        recursive: true,
      },
    ]);
  });

  it("retains a failed kernel cleanup record for a later terminal reconciliation", async () => {
    const { instance } = await createTestDO(EvalDO);
    instance.accept({
      runId: "run-retry-cleanup",
      startIntentDigest: "a".repeat(64),
      deadlineAt: null,
    });
    const kernelCall = vi
      .fn()
      .mockRejectedValueOnce(new Error("runtime temporarily unavailable"))
      .mockResolvedValueOnce(undefined);
    setPriv(instance, "connectionless", { client: { call: kernelCall } });
    priv<(runId: string, method: string, args: unknown[], result: unknown) => void>(
      instance,
      "observeAuthoredLifecycleCall"
    ).call(
      instance,
      "run-retry-cleanup",
      "runtime.createEntity",
      [{ kind: "worker", source: "workers/task" }],
      { id: "worker:workers/task:retry", contextId: "ctx-retry" }
    );

    await expect(
      priv<(runId: string) => Promise<void>>(instance, "cleanupRunOwnedContexts").call(
        instance,
        "run-retry-cleanup"
      )
    ).rejects.toThrow(/runtime temporarily unavailable/);
    await expect(
      priv<(runId: string) => Promise<void>>(instance, "cleanupRunOwnedContexts").call(
        instance,
        "run-retry-cleanup"
      )
    ).resolves.toBeUndefined();
    expect(kernelCall).toHaveBeenCalledTimes(2);
    expect(
      priv<(runId: string, contextId: string) => boolean>(instance, "detachRunOwnedContext").call(
        instance,
        "run-retry-cleanup",
        "ctx-retry"
      )
    ).toBe(false);
  });

  it("holds the scope FIFO lease until terminal cleanup settles", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    let releaseCleanup!: () => void;
    const cleanupBlocked = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const started: string[] = [];
    setPriv(
      instance,
      "runLocked",
      vi.fn(async (_args, _signal, runId) => {
        started.push(String(runId));
        return { success: true, console: String(runId) };
      })
    );
    seedPreparedRun(instance, sql, "run-first");
    seedPreparedRun(instance, sql, "run-second");
    priv<Map<string, Set<() => Promise<void>>>>(instance, "runCleanupHandlers").set(
      "run-first",
      new Set([() => cleanupBlocked])
    );

    const first = instance.execute("run-first");
    const second = instance.execute("run-second");
    await vi.waitFor(() => expect(started).toEqual(["run-first"]));
    releaseCleanup();

    await expect(first).resolves.toMatchObject({ success: true });
    await expect(second).resolves.toMatchObject({ success: true });
    expect(started).toEqual(["run-first", "run-second"]);
  });

  it("returns terminal for a completed run and leaves other runs untouched", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    seedPreparedRun(instance, sql, "done", { status: "succeeded" });
    seedPreparedRun(instance, sql, "other", { status: "accepted" });
    await expect(instance.cancel("done")).resolves.toEqual({ status: "terminal" });
    expect(instance.get("done")).toMatchObject({ status: "succeeded" });
    expect(instance.get("other")).toMatchObject({ status: "accepted" });
  });

  it("reports cleanup failure for an already-expired run and releases live state", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    seedPreparedRun(instance, sql, "expired", { deadlineAt: Date.now() - 1 });
    const runLocked = vi.fn(async () => ({ success: true, console: "unexpected" }));
    setPriv(instance, "runLocked", runLocked);
    priv<Map<string, Set<() => Promise<void>>>>(instance, "runCleanupHandlers").set(
      "expired",
      new Set([async () => Promise.reject(new Error("cleanup exploded"))])
    );

    const result = await instance.execute("expired");
    expect(result).toMatchObject({ success: false });
    expect(result.error).toMatch(/terminal cleanup failed/i);
    expect(runLocked).not.toHaveBeenCalled();
    expect(instance.get("expired")).toMatchObject({
      status: "expired",
      result: { errorCode: "EVAL_INVOCATION_EXPIRED" },
    });
    expect(priv<Map<string, unknown>>(instance, "runAborts").has("expired")).toBe(false);
  });

  it("does not orphan a non-yielding run during force reset", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    const blocked = blockUntilAborted();
    setPriv(instance, "runLocked", blocked.runLocked);
    seedPreparedRun(instance, sql, "wedged");
    const execution = instance.execute("wedged");
    const signal = await blocked.started;

    await expect(instance.forceReset()).resolves.toEqual({
      status: "requires-process-restart",
    });
    expect(signal.aborted).toBe(true);
    await execution;
    expect(instance.get("wedged")).toMatchObject({ status: "cancelled" });
  });

  it("keeps invocation credentials run-local and supplies them only in live call options", async () => {
    const { instance } = await createTestDO(EvalDO);
    const signal = new AbortController().signal;
    setPriv(instance, "currentEvalInvocation", { runId: "run-1", credential: "secret" });
    setPriv(instance, "currentRunAbortSignal", signal);
    setPriv(instance, "currentRunReadOnly", true);

    expect(priv<() => unknown>(instance, "currentRunCallOptions").call(instance)).toEqual({
      evalInvocation: { runId: "run-1", credential: "secret" },
      signal,
      readOnly: true,
    });
    setPriv(instance, "currentEvalInvocation", null);
    expect(() => priv<() => unknown>(instance, "currentRunCallOptions").call(instance)).toThrow(
      /no active invocation authority/
    );
  });
});
