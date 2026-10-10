// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { deserializeRpcFailure } from "@vibestudio/rpc";
import { LifecycleDriver } from "./lifecycleDriver.js";
import type { RestartBeginEvent, RestartReadyEvent, WorkerdManager } from "../workerdManager.js";
import type { DODispatch } from "../doDispatch.js";
import type {
  DORef,
  LifecyclePrepareInput,
  LifecyclePrepareResult,
} from "@vibestudio/shared/doDispatcher";

function makeHarness(
  opts: {
    prepare?: (ref: DORef, input: LifecyclePrepareInput) => Promise<LifecyclePrepareResult>;
    workspace?: (method: string, args: unknown[]) => Promise<void>;
    leases?: Array<{ source: string; className: string; objectKey: string }>;
    concurrency?: number;
  } = {}
) {
  let beginHook: ((event: RestartBeginEvent) => Promise<void> | void) | null = null;
  let readyHook: ((event: RestartReadyEvent) => Promise<void> | void) | null = null;
  const calls: Array<{
    kind: "workspace" | "lifecycle";
    method: string;
    ref?: DORef;
    arg?: unknown;
  }> = [];
  const leases = opts.leases ?? [
    { source: "workers/agent", className: "AiChatWorker", objectKey: "ch-1" },
  ];
  let epoch = "";

  const workerdManager = {
    getBootGeneration: () => 7,
    onRestartBegin(fn: (event: RestartBeginEvent) => Promise<void> | void) {
      beginHook = fn;
      return () => {
        beginHook = null;
      };
    },
    onRestartReady(fn: (event: RestartReadyEvent) => Promise<void> | void) {
      readyHook = fn;
      return () => {
        readyHook = null;
      };
    },
  } as Pick<WorkerdManager, "getBootGeneration" | "onRestartBegin" | "onRestartReady">;

  const doDispatch = {
    dispatch: async (_ref: DORef, method: string, ...args: unknown[]) => {
      calls.push({ kind: "workspace", method, arg: args[0] });
      await opts.workspace?.(method, args);
      if (method === "lifecycleOpenEpoch") {
        epoch = "epoch-1";
        return epoch;
      }
      if (method === "lifecycleListLeases")
        return leases.map((lease) => ({
          ...lease,
          detail: null,
          createdAt: 0,
          refreshedAt: 0,
        }));
      if (method === "lifecycleListResumeTargets") return leases;
      if (method === "lifecycleListOps") {
        return leases.map((lease) => ({
          ...lease,
          epochId: epoch,
          opKind: "resume",
          status: "pending",
          detail: null,
          updatedAt: 0,
        }));
      }
      return undefined;
    },
    dispatchLifecycle: async (ref: DORef, method: "prepare" | "resume", arg: unknown) => {
      calls.push({ kind: "lifecycle", method, ref, arg });
      if (opts.prepare && method === "prepare")
        return opts.prepare(ref, arg as LifecyclePrepareInput);
      return method === "prepare" ? { status: "ready" } : undefined;
    },
  } as Pick<DODispatch, "dispatch" | "dispatchLifecycle">;

  const driver = new LifecycleDriver({
    workerdManager: workerdManager as WorkerdManager,
    doDispatch: doDispatch as DODispatch,
    workspaceId: "workspace-main",
    concurrency: opts.concurrency ?? 2,
  });
  driver.start();
  return {
    calls,
    driver,
    fireBegin: (event: RestartBeginEvent) => beginHook?.(event),
    fireReady: (event: RestartReadyEvent) => readyHook?.(event),
  };
}

describe("LifecycleDriver", () => {
  it("prepares once on restart begin and resumes only on restart ready", async () => {
    const harness = makeHarness();
    await harness.fireBegin({ correlationId: "r1", generation: 8, reason: "planned" });

    expect(harness.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "workspace", method: "lifecycleOpenEpoch" }),
        expect.objectContaining({ kind: "lifecycle", method: "prepare" }),
        expect.objectContaining({ kind: "workspace", method: "lifecycleRecordOp" }),
      ])
    );
    expect(
      harness.calls.some((call) => call.kind === "lifecycle" && call.method === "resume")
    ).toBe(false);
    expect(
      harness.calls
        .filter((call) => call.kind === "lifecycle" && call.method === "prepare")
        .map((call) => (call.arg as LifecyclePrepareInput).phase)
    ).toEqual(["quiesce", "peer-obligations", "release"]);
    expect(
      harness.calls.find((call) => call.kind === "lifecycle" && call.method === "prepare")?.arg
    ).toMatchObject({ mode: "suspend", phase: "quiesce" });

    await harness.fireReady({
      correlationId: "r1",
      generation: 8,
      previousGeneration: 7,
      reason: "planned",
    });

    expect(harness.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "lifecycle", method: "resume" }),
        expect.objectContaining({ kind: "workspace", method: "lifecycleCompleteEpoch" }),
      ])
    );
  });

  it("recovers durable leases directly after an unresponsive-runtime crash restart", async () => {
    const harness = makeHarness();

    await harness.fireReady({
      correlationId: "unprepared-crash",
      generation: 8,
      previousGeneration: 7,
      reason: "crash",
    });

    expect(harness.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "workspace",
          method: "lifecycleOpenEpoch",
          arg: expect.objectContaining({ kind: "crash", reason: "crash" }),
        }),
        expect.objectContaining({ kind: "lifecycle", method: "resume" }),
        expect.objectContaining({ kind: "workspace", method: "lifecycleCompleteEpoch" }),
      ])
    );
    expect(
      harness.calls.some((call) => call.kind === "lifecycle" && call.method === "prepare")
    ).toBe(false);
  });

  it("keeps a slow valid release owned beyond the former shutdown deadline", async () => {
    vi.useFakeTimers();
    const entered = deferred<void>();
    const release = deferred<LifecyclePrepareResult>();
    const harness = makeHarness({
      prepare: async () => {
        entered.resolve(undefined);
        return release.promise;
      },
    });
    let settled = false;
    const preparation = harness.driver.prepareForShutdown();
    const observed = preparation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(settled).toBe(false);
      expect(harness.calls.find((call) => call.kind === "lifecycle")?.arg).toMatchObject({
        mode: "suspend",
        deadlineMs: 0,
        reason: "server_shutdown",
      });
      expect(harness.calls.some((call) => call.method === "lifecycleRecordOp")).toBe(false);
      release.resolve({ status: "ready" });
      await preparation;
      expect(harness.calls.find((call) => call.method === "lifecycleRecordOp")?.arg).toMatchObject({
        status: "ready",
      });
    } finally {
      release.resolve({ status: "ready" });
      await observed;
      vi.useRealTimers();
    }
  });

  it("joins the actual journal acknowledgement after release without timing it out", async () => {
    vi.useFakeTimers();
    const entered = deferred<void>();
    const journal = deferred<void>();
    const harness = makeHarness({
      workspace: async (method) => {
        if (method === "lifecycleRecordOp") {
          entered.resolve(undefined);
          await journal.promise;
        }
      },
    });
    let settled = false;
    const preparation = harness.fireBegin({
      correlationId: "r-journal",
      generation: 8,
      reason: "planned",
    });
    const observed = Promise.resolve(preparation).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(settled).toBe(false);
      journal.resolve(undefined);
      await preparation;
      expect(settled).toBe(true);
    } finally {
      journal.resolve(undefined);
      await observed;
      vi.useRealTimers();
    }
  });

  it("retains the original release failure while attempting independent targets", async () => {
    const original = new Error("native connection cleanup refused", {
      cause: new Error("socket cause"),
    });
    const harness = makeHarness({
      concurrency: 1,
      leases: [
        { source: "workers/agent", className: "AiChatWorker", objectKey: "ch-1" },
        { source: "workers/agent", className: "AiChatWorker", objectKey: "ch-2" },
      ],
      prepare: async (ref) => {
        if (ref.objectKey === "ch-1") throw original;
        return { status: "ready" };
      },
    });
    const failure = await harness.driver.prepareForShutdown().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(1);
    expect((failure as AggregateError).errors[0]).toBe(original);
    expect((failure as AggregateError).cause).toBe(original);
    expect(harness.calls.filter((call) => call.kind === "lifecycle")).toHaveLength(2);
    expect(
      harness.calls
        .filter((call) => call.method === "lifecycleRecordOp")
        .map((call) => (call.arg as { status: string }).status)
    ).toEqual(["failed", "ready"]);
  });

  it("propagates original journal failure without a second bookkeeping attempt", async () => {
    const original = new Error("lifecycle journal rejected");
    const harness = makeHarness({
      workspace: async (method) => {
        if (method === "lifecycleRecordOp") throw original;
      },
    });
    const failure = await harness.driver.prepareForShutdown().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(1);
    expect((failure as AggregateError).errors[0]).toBe(original);
    expect(harness.calls.filter((call) => call.method === "lifecycleRecordOp")).toHaveLength(1);
  });

  it("preserves nested aggregate failure identity and codes in the lifecycle journal", async () => {
    const shared = Object.assign(new Error("original cause"), { code: "CAUSE_CODE" });
    const original = Object.assign(
      new AggregateError([shared, shared], "original aggregate", { cause: shared }),
      { code: "AGGREGATE_CODE" }
    );
    const harness = makeHarness({
      prepare: async (_ref, input) => {
        if (input.phase === "quiesce") throw original;
        return { status: "ready" };
      },
    });
    const failure = await harness.driver.prepareForShutdown().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toBe(original);
    expect((failure as AggregateError).cause).toBe(original);
    const journal = harness.calls.find((call) => call.method === "lifecycleRecordOp")?.arg as {
      status: string;
      detail: { phase: string; result: unknown };
    };
    expect(journal).toMatchObject({
      status: "failed",
      detail: {
        phase: "quiesce",
        result: { message: "original aggregate", code: "AGGREGATE_CODE" },
      },
    });
    const restored = deserializeRpcFailure(journal.detail.result);
    expect(restored).toBeInstanceOf(AggregateError);
    if (!(restored instanceof AggregateError)) throw new Error("Expected an aggregate RPC failure");
    expect(restored.code).toBe("AGGREGATE_CODE");
    expect(restored.errors).toHaveLength(2);
    expect(restored.errors[0]).toBe(restored.errors[1]);
    expect(restored.errors[0]).toBe(restored.cause);
    expect(restored.errors[0]).toMatchObject({ message: "original cause", code: "CAUSE_CODE" });
  });

  it("does not acknowledge an invalid prepare result as released ownership", async () => {
    const harness = makeHarness({
      prepare: async () => undefined as unknown as LifecyclePrepareResult,
    });
    await expect(harness.driver.prepareForShutdown()).rejects.toThrow(/Lifecycle quiesce failed/u);
    expect(harness.calls.find((call) => call.method === "lifecycleRecordOp")?.arg).toMatchObject({
      status: "failed",
      detail: {
        phase: "quiesce",
        result: { message: "Lifecycle prepare returned no valid phase receipt" },
      },
    });
  });

  it("joins a crash-preempted dispatch until actual old-target destruction and admits no further work", async () => {
    const entered = deferred<void>();
    const destroyed = deferred<LifecyclePrepareResult>();
    const original = new Error("old workerd process connection destroyed");
    const harness = makeHarness({
      concurrency: 1,
      leases: [
        { source: "workers/agent", className: "AiChatWorker", objectKey: "ch-1" },
        { source: "workers/agent", className: "AiChatWorker", objectKey: "ch-2" },
      ],
      prepare: async () => {
        entered.resolve(undefined);
        return destroyed.promise;
      },
    });
    const controller = new AbortController();
    const preparation = harness.fireBegin({
      correlationId: "r-preempt",
      generation: 8,
      reason: "planned",
      signal: controller.signal,
    });
    let settled = false;
    const observed = Promise.resolve(preparation).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    try {
      await entered.promise;
      controller.abort(new Error("authoritative crash replacement"));
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(harness.calls.some((call) => call.method === "lifecycleRecordOp")).toBe(false);
      destroyed.reject(original);
      const failure = await Promise.resolve(preparation).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toHaveLength(1);
      expect((failure as AggregateError).errors[0]).toBe(original);
      expect(harness.calls.filter((call) => call.kind === "lifecycle")).toHaveLength(1);
      expect(harness.calls.some((call) => call.method === "lifecycleRecordOp")).toBe(false);
    } finally {
      destroyed.reject(original);
      await observed;
    }
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}
