import {
  encodeRpcJson,
  decodeRpcJson,
  deserializeRpcFailure,
  rpcCallerAbortedError,
} from "@vibestudio/rpc";
// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DORef } from "@vibestudio/shared/doDispatcher";
import type {
  DurableWorkQueue,
  DurableWorkReadyHint,
  WorkClaim,
} from "@vibestudio/shared/durableWork";
import {
  createDurableWorkHandlers,
  createDurableWorkOwnerScanner,
  DurableWorkDriver,
  type DurableWorkHandler,
} from "./durableWorkDriver.js";

const owner = (objectKey: string): DORef => ({
  source: "workers/agent-worker",
  className: "AiChatWorker",
  objectKey,
});

function claim(itemId: string, generation = 1): WorkClaim {
  return {
    itemId,
    generation,
    idempotencyKey: `idempotency:${itemId}`,
    createdAt: 0,
    attempt: 1,
    payload: {},
  };
}

function handlers(overrides: Partial<DurableWorkHandler> = {}) {
  const handler: DurableWorkHandler = {
    claim: vi.fn(async () => []),
    laneKey: (_owner, item) => item.itemId,
    execute: vi.fn(async () => ({ ok: true })),
    settle: vi.fn(async () => "accepted" as const),
    fail: vi.fn(async () => undefined),
    ...overrides,
  };
  return {
    handler,
    record: {
      "channel-delivery": handler,
      "channel-observation": handler,
      "workspace-publication": handler,
    } satisfies Record<DurableWorkQueue, DurableWorkHandler>,
  };
}

describe("DurableWorkDriver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not reclaim a terminally failed owned item", async () => {
    const original = new Error("canonical observation failed");
    const suite = handlers({
      claim: vi.fn(async () => [claim("failed")]),
      execute: vi.fn(async () => {
        throw original;
      }),
      fail: vi.fn(async () => ({ failed: true })),
    });
    const driver = new DurableWorkDriver({
      handlers: suite.record,
      scanReadyOwners: async () => [],
      workerId: "driver-1",
    });
    driver.start();
    driver.notify({ owner: owner("a"), queues: ["channel-observation"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(suite.handler.claim).toHaveBeenCalledTimes(1);
    expect(suite.handler.fail).toHaveBeenCalledWith(
      owner("a"),
      expect.objectContaining({ error: original, itemId: "failed", generation: 1 })
    );
    expect(suite.handler.settle).not.toHaveBeenCalled();
    await driver.quiesce();
  });

  it("lets the parent run while fork prerequisites wait outside the only execution slot", async () => {
    let releaseParent!: () => void;
    const observed = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });
    const issued = new Set<string>();
    const execution: string[] = [];
    const suite = handlers({
      claim: vi.fn(async (target) => {
        if (issued.has(target.objectKey)) return [];
        issued.add(target.objectKey);
        return [claim(target.objectKey)];
      }),
      prepare: async (target) => {
        if (target.objectKey === "child") await observed;
      },
      execute: async (target) => {
        execution.push(target.objectKey);
        if (target.objectKey === "parent") releaseParent();
        return {};
      },
    });
    const driver = new DurableWorkDriver({
      handlers: suite.record,
      scanReadyOwners: async () => [],
      concurrency: 1,
    });
    driver.start();
    driver.notify({ owner: owner("child"), queues: ["channel-observation"] });
    driver.notify({ owner: owner("parent"), queues: ["channel-observation"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(execution).toEqual(["parent", "child"]);
    expect(suite.handler.settle).toHaveBeenCalledTimes(2);
    await driver.quiesce();
  });

  it("cancels and joins a waiting prerequisite on driver quiescence", async () => {
    let started = false;
    let joined = false;
    const suite = handlers({
      claim: vi.fn(async () => [claim("waiting")]),
      prepare: async (_owner, _claim, signal) => {
        started = true;
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => {
              joined = true;
              reject(signal.reason);
            },
            { once: true }
          )
        );
      },
    });
    const driver = new DurableWorkDriver({
      handlers: suite.record,
      scanReadyOwners: async () => [],
      concurrency: 1,
    });
    driver.start();
    driver.notify({ owner: owner("child"), queues: ["channel-observation"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(true);
    expect(driver.inspect().active).toBe(0);
    await driver.quiesce();
    expect(joined).toBe(true);
    expect(driver.inspect().activeLanes).toEqual([]);
    expect(suite.handler.execute).not.toHaveBeenCalled();
    expect(suite.handler.fail).not.toHaveBeenCalled();
  });

  it("retains transition traces without serializing or emitting them at info level", async () => {
    vi.stubEnv("VIBESTUDIO_LOG_LEVEL", "info");
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const stringify = vi.spyOn(JSON, "stringify");
    const pending = [claim("effect-1")];
    const suite = handlers({ claim: vi.fn(async () => pending.splice(0)) });
    const driver = new DurableWorkDriver({
      handlers: suite.record,
      scanReadyOwners: async () => [],
      workerId: "driver-1",
    });

    driver.start();
    driver.notify({ owner: owner("a"), queues: ["channel-delivery"] });
    await vi.advanceTimersByTimeAsync(0);

    expect(driver.inspect().recentTrace.length).toBeGreaterThan(0);
    expect(stringify).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
    await driver.quiesce();
  });

  it("coalesces disposable hints and settles the exact claimed generation", async () => {
    const queue = [claim("effect-1", 7)];
    const suite = handlers({
      claim: vi.fn(async () => queue.splice(0)),
    });
    const driver = new DurableWorkDriver({
      handlers: suite.record,
      scanReadyOwners: async () => [],
      workerId: "driver-1",
    });
    driver.start();
    driver.notify({ owner: owner("a"), queues: ["channel-delivery"] });
    driver.notify({ owner: owner("a"), queues: ["channel-delivery"] });
    await vi.advanceTimersByTimeAsync(0);

    expect(suite.handler.execute).toHaveBeenCalledOnce();
    expect(suite.handler.settle).toHaveBeenCalledWith(owner("a"), {
      workerId: "driver-1",
      itemId: "effect-1",
      generation: 7,
      outcome: { ok: true },
    });
    expect(driver.inspect().duplicateHints).toBeGreaterThan(0);
    await driver.quiesce();
  });

  it("claims a same-lane successor only after the prior settlement releases its lane", async () => {
    const target = owner("same-lane-owner");
    const lane = "channel-observation\u0000observation-lane";
    const first = { ...claim("first", 1), payload: { laneKey: "observation-lane" } };
    const second = { ...claim("second", 2), payload: { laneKey: "observation-lane" } };
    let claimCount = 0;
    let driver!: DurableWorkDriver;
    let successorSawReleasedLane = false;
    let releaseSettlement!: () => void;
    const settlementReceipt = new Promise<void>((resolve) => {
      releaseSettlement = resolve;
    });
    const suite = handlers({
      claim: vi.fn(async () => {
        claimCount += 1;
        if (claimCount === 1) return [first];
        if (claimCount === 2) {
          successorSawReleasedLane = !driver.inspect().activeLanes.includes(lane);
          return [second];
        }
        return [];
      }),
      laneKey: (_owner, work) => String((work.payload as { laneKey: string }).laneKey),
      settle: vi.fn(async (_owner, request) => {
        if (request.itemId === "first") {
          driver.notify({ owner: target, queues: ["channel-observation"] });
          await settlementReceipt;
        }
        return "accepted" as const;
      }),
    });
    driver = new DurableWorkDriver({
      handlers: suite.record,
      scanReadyOwners: async () => [],
      concurrency: 2,
      workerId: "driver-same-lane",
    });

    driver.start();
    driver.notify({ owner: target, queues: ["channel-observation"] });
    await vi.advanceTimersByTimeAsync(0);

    expect(claimCount).toBe(1);
    expect(driver.inspect().activeLanes).toContain(lane);
    releaseSettlement();
    await vi.advanceTimersByTimeAsync(0);

    expect(claimCount).toBeGreaterThanOrEqual(2);
    expect(successorSawReleasedLane).toBe(true);
    expect(suite.handler.fail).not.toHaveBeenCalled();
    expect(suite.handler.settle).toHaveBeenCalledWith(
      target,
      expect.objectContaining({ itemId: "first" })
    );
    await driver.quiesce();
  });

  it("keeps distinct lanes of one owner queue executable in parallel", async () => {
    const target = owner("parallel-lanes");
    const claims = [
      { ...claim("first", 1), payload: { laneKey: "lane-a" } },
      { ...claim("second", 1), payload: { laneKey: "lane-b" } },
    ];
    const started = new Set<string>();
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finish!: () => void;
    const hold = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const suite = handlers({
      claim: vi.fn(async () => claims.splice(0)),
      laneKey: (_owner, work) => String((work.payload as { laneKey: string }).laneKey),
      execute: vi.fn(async (_owner, work) => {
        started.add(work.itemId);
        if (started.size === 2) release();
        await hold;
        return { ok: true };
      }),
    });
    const driver = new DurableWorkDriver({
      handlers: suite.record,
      scanReadyOwners: async () => [],
      concurrency: 2,
      workerId: "driver-parallel-lanes",
    });

    driver.start();
    driver.notify({ owner: target, queues: ["channel-observation"] });
    await vi.advanceTimersByTimeAsync(0);
    await bothStarted;
    expect(started).toEqual(new Set(["first", "second"]));
    finish();
    await vi.advanceTimersByTimeAsync(0);
    await driver.quiesce();
  });

  it("does not ask a retired or superseded owner for continuation after stale settlement", async () => {
    const queue = [claim("effect-1", 7)];
    const suite = handlers({
      claim: vi.fn(async () => queue.splice(0)),
      settle: vi.fn(async () => "stale" as const),
    });
    const driver = new DurableWorkDriver({
      handlers: suite.record,
      scanReadyOwners: async () => [],
      workerId: "driver-1",
    });

    driver.start();
    driver.notify({ owner: owner("retired"), queues: ["channel-delivery"] });
    await vi.advanceTimersByTimeAsync(0);

    expect(suite.handler.claim).toHaveBeenCalledOnce();
    expect(driver.inspect()).toMatchObject({
      staleSettlements: 1,
      claimsByTrigger: { hint: 1, recovery: 0, continuation: 0 },
    });
    await driver.quiesce();
  });

  it("discards a hint whose durable owner was retired before claim", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const suite = handlers({
      claim: vi.fn(async () => {
        throw Object.assign(new Error("entity is no longer active"), { code: "DO_NOT_CREATED" });
      }),
    });
    const driver = new DurableWorkDriver({
      handlers: suite.record,
      scanReadyOwners: async () => [],
      workerId: "driver-1",
    });

    driver.start();
    driver.notify({ owner: owner("retired"), queues: ["channel-delivery"] });
    await vi.advanceTimersByTimeAsync(0);

    expect(suite.handler.claim).toHaveBeenCalledOnce();
    expect(warning).not.toHaveBeenCalled();
    expect(driver.inspect()).toMatchObject({ accepting: true, pendingHints: 0, active: 0 });
    await driver.quiesce();
  });

  it("lets an independent lane advance while another execution is held", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = new Map([
      ["slow", [claim("slow")]],
      ["fast", [claim("fast")]],
    ]);
    const started: string[] = [];
    const suite = handlers({
      claim: vi.fn(async (ref) => pending.get(ref.objectKey)?.splice(0) ?? []),
      execute: vi.fn(async (_ref, item) => {
        started.push(item.itemId);
        if (item.itemId === "slow") await held;
        return { ok: true };
      }),
    });
    const driver = new DurableWorkDriver({
      handlers: suite.record,
      scanReadyOwners: async () => [],
      workerId: "driver-1",
      concurrency: 2,
    });
    driver.start();
    driver.notify({ owner: owner("slow"), queues: ["channel-delivery"] });
    driver.notify({ owner: owner("fast"), queues: ["channel-delivery"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["slow", "fast"]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    await driver.quiesce();
  });

  it("keeps the workspace alive when a removed owner rejects duplicate-lane settlement", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = [claim("first"), claim("second")];
    const suite = handlers({
      claim: vi.fn(async () => {
        const next = pending.shift();
        return next ? [next] : [];
      }),
      laneKey: () => "same-channel",
      execute: vi.fn(async (_owner, item) => {
        if (item.itemId === "first") await held;
        return { ok: true };
      }),
      fail: vi.fn(async () => {
        throw Object.assign(new Error("Not a member of this workspace"), { code: "EACCES" });
      }),
    });
    const driver = new DurableWorkDriver({
      handlers: suite.record,
      scanReadyOwners: async () => [],
      workerId: "driver-1",
      concurrency: 2,
    });
    driver.start();
    driver.notify({ owner: owner("removed"), queues: ["channel-delivery"] });
    await vi.advanceTimersByTimeAsync(0);
    driver.notify({ owner: owner("removed"), queues: ["channel-delivery"] });
    await vi.advanceTimersByTimeAsync(0);

    expect(suite.handler.fail).toHaveBeenCalledOnce();
    expect(driver.inspect()).toMatchObject({ accepting: true, active: 1 });

    release();
    await vi.advanceTimersByTimeAsync(0);
    await driver.quiesce();
  });

  it("recovers all work when every immediate hint is dropped", async () => {
    const pending = [claim("recovered")];
    const suite = handlers({
      claim: vi.fn(async () => pending.splice(0)),
    });
    const recoveryHint: DurableWorkReadyHint = {
      owner: owner("recovered-owner"),
      queues: ["workspace-publication"],
    };
    const driver = new DurableWorkDriver({
      handlers: suite.record,
      scanReadyOwners: async () => [recoveryHint],
      workerId: "driver-1",
    });
    driver.start();
    await driver.recoverNow();
    await vi.advanceTimersByTimeAsync(0);

    expect(suite.handler.execute).toHaveBeenCalledWith(
      recoveryHint.owner,
      expect.objectContaining({ itemId: "recovered" }),
      expect.any(AbortSignal)
    );
    expect(driver.inspect()).toMatchObject({
      recoveryScans: 1,
      recoveryHits: 1,
      claimsByTrigger: { hint: 0, recovery: 1, continuation: 0 },
      recentTrace: expect.arrayContaining([
        expect.objectContaining({
          phase: "claim.completed",
          trigger: "recovery",
          queue: "workspace-publication",
        }),
      ]),
    });
    await driver.quiesce();
  });

  it("coalesces overlapping recovery scans", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const suite = handlers();
    const scanReadyOwners = vi.fn(async (_signal: AbortSignal) => {
      await held;
      return [];
    });
    const driver = new DurableWorkDriver({
      handlers: suite.record,
      scanReadyOwners,
      workerId: "driver-1",
    });
    driver.start();

    const first = driver.recoverNow();
    const second = driver.recoverNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(scanReadyOwners).toHaveBeenCalledOnce();
    expect(driver.inspect().recoveryScans).toBe(1);

    release();
    await Promise.all([first, second]);
    await driver.quiesce();
  });

  it("cancels and joins an owned recovery adoption before quiesce settles", async () => {
    let markAdoptionStarted!: () => void;
    const adoptionStarted = new Promise<void>((resolve) => {
      markAdoptionStarted = resolve;
    });
    let markCancellationObserved!: () => void;
    const cancellationObserved = new Promise<void>((resolve) => {
      markCancellationObserved = resolve;
    });
    let finishRemoteCleanup!: () => void;
    const remoteCleanup = new Promise<void>((resolve) => {
      finishRemoteCleanup = resolve;
    });
    const registration = {
      owner: owner("recovering-owner"),
      queues: ["channel-delivery"] as const,
    };
    const dispatchHeldWithSignal = vi.fn(
      async (_ref: DORef, signal: AbortSignal, method: string) => {
        if (method === "durableWorkOwnerList") return [registration];
        if (method === "adoptDurableWorkWorker") {
          markAdoptionStarted();
          return new Promise<never>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                markCancellationObserved();
                void remoteCleanup.then(() => reject(signal.reason));
              },
              { once: true }
            );
          });
        }
        return { readyQueues: [], nextRecoveryAt: null };
      }
    );
    const scanReadyOwners = createDurableWorkOwnerScanner(
      { dispatchHeldWithSignal } as never,
      {
        source: "vibestudio/internal",
        className: "WorkspaceDO",
        objectKey: "workspace",
      },
      "driver-generation-1"
    );
    const suite = handlers();
    const driver = new DurableWorkDriver({
      handlers: suite.record,
      scanReadyOwners,
      workerId: "driver-generation-1",
    });
    driver.start();

    const recovery = driver.recoverNow();
    await adoptionStarted;
    let quiesced = false;
    const stopping = driver.quiesce().then(() => {
      quiesced = true;
    });
    await cancellationObserved;
    expect(quiesced).toBe(false);

    finishRemoteCleanup();
    await Promise.all([recovery, stopping]);
    expect(quiesced).toBe(true);
    expect(dispatchHeldWithSignal).toHaveBeenCalledWith(
      registration.owner,
      expect.objectContaining({ aborted: true }),
      "adoptDurableWorkWorker",
      "driver-generation-1"
    );
  });

  it("scans owner recovery status through a single low-priority lane", async () => {
    const registrations = Array.from({ length: 12 }, (_, index) => ({
      owner: owner(`registered-${index}`),
      queues: ["workspace-publication"] as const,
    }));
    let active = 0;
    let maxActive = 0;
    const dispatchHeldWithSignal = vi.fn(
      async (_ref: DORef, _signal: AbortSignal, method: string) => {
        if (method === "durableWorkOwnerList") return registrations;
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        if (method === "adoptDurableWorkWorker") return { adopted: true, previousWorkerId: null };
        return { readyQueues: ["workspace-publication"], nextRecoveryAt: null };
      }
    );
    const scan = createDurableWorkOwnerScanner(
      { dispatchHeldWithSignal } as never,
      {
        source: "vibestudio/internal",
        className: "WorkspaceDO",
        objectKey: "workspace",
      },
      "driver-generation-1"
    );

    const result = scan(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(200);

    await expect(result).resolves.toHaveLength(registrations.length);
    expect(maxActive).toBe(1);
  });

  it("reports an unchanged permanent readiness failure only once while continuing probes", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registration = { owner: owner("blocked"), queues: ["channel-delivery"] as const };
    const dispatchHeldWithSignal = vi.fn(
      async (_ref: DORef, _signal: AbortSignal, method: string) => {
        if (method === "durableWorkOwnerList") return [registration];
        throw Object.assign(new Error("sealed execution unavailable"), {
          code: "RUNTIME_IMAGE_UNAVAILABLE",
        });
      }
    );
    const scan = createDurableWorkOwnerScanner(
      { dispatchHeldWithSignal } as never,
      {
        source: "vibestudio/internal",
        className: "WorkspaceDO",
        objectKey: "workspace",
      },
      "driver-generation-1"
    );

    await scan(new AbortController().signal);
    await scan(new AbortController().signal);

    expect(dispatchHeldWithSignal).toHaveBeenCalledTimes(4);
    expect(
      consoleWarn.mock.calls.filter(([message]) => String(message).includes("readiness blocked"))
    ).toHaveLength(1);
  });

  it("retains independent owner failures when the readiness scan is cancelled", async () => {
    const cancellation = new Error("scanner stopped");
    const primary = new Error("owner dispatch failed");
    const cleanup = new Error("owner cleanup failed");
    const independent = new AggregateError(
      [primary, cleanup],
      "owner operation and cleanup failed",
      {
        cause: primary,
      }
    );
    const registrations = ["cancelled", "independent"].map((key) => ({
      owner: owner(key),
      queues: ["channel-delivery"] as const,
    }));
    let started = 0;
    let releaseStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    const dispatchHeldWithSignal = vi.fn((_ref: DORef, signal: AbortSignal, method: string) => {
      if (method === "durableWorkOwnerList") return Promise.resolve(registrations);
      if (method !== "adoptDurableWorkWorker") {
        return Promise.reject(new Error(`unexpected readiness method ${method}`));
      }
      const key = _ref.objectKey;
      started++;
      if (started === registrations.length) releaseStarted();
      return new Promise((_, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(key === "cancelled" ? rpcCallerAbortedError(signal.reason) : independent),
          { once: true }
        );
      });
    });
    const scan = createDurableWorkOwnerScanner(
      { dispatchHeldWithSignal } as never,
      {
        source: "vibestudio/internal",
        className: "WorkspaceDO",
        objectKey: "workspace",
      },
      "driver-generation-1",
      2
    );
    const controller = new AbortController();
    const result = scan(controller.signal);

    await bothStarted;
    controller.abort(cancellation);

    const failure = await result.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([cancellation, independent]);
    expect((failure as AggregateError).cause).toBe(cancellation);
    expect((failure as AggregateError).errors[1]).toBe(independent);
  });

  it("keeps nested owner failure details in transient readiness warnings", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const primary = new Error("owner request failed");
    const cleanup = new Error("owner cleanup failed");
    const ownerFailure = new AggregateError([primary, cleanup], "owner operation failed", {
      cause: primary,
    });
    const dispatchHeldWithSignal = vi.fn(
      async (_ref: DORef, _signal: AbortSignal, method: string) => {
        if (method === "durableWorkOwnerList") {
          return [{ owner: owner("transient"), queues: ["channel-delivery"] as const }];
        }
        throw ownerFailure;
      }
    );
    const scan = createDurableWorkOwnerScanner(
      { dispatchHeldWithSignal } as never,
      {
        source: "vibestudio/internal",
        className: "WorkspaceDO",
        objectKey: "workspace",
      },
      "driver-generation-1"
    );

    await scan(new AbortController().signal);

    const warning = consoleWarn.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.includes("readiness scan failed"));
    expect(warning).toContain("owner operation failed");
    expect(warning).toContain("owner request failed");
    expect(warning).toContain("owner cleanup failed");
  });

  it.each(["root", "append", "fork"] as const)(
    "prepares only the external causal prerequisite for a %s observation",
    async (kind) => {
      const dispatch = vi.fn();
      const dispatchHeldWithSignal = vi.fn(async () => undefined);
      const record = createDurableWorkHandlers({ dispatch, dispatchHeldWithSignal } as never);
      const work = claim(`observation:${kind}`, 7);
      work.payload = { laneKey: "channel-observation:channel-1", observation: { kind } };
      const signal = new AbortController().signal;
      await record["channel-observation"].prepare!(owner("channel-1"), work, signal);
      if (kind === "fork") {
        expect(dispatchHeldWithSignal).toHaveBeenCalledExactlyOnceWith(
          owner("channel-1"),
          signal,
          "prepareChannelObservationClaim",
          { itemId: "observation:fork", generation: 7 }
        );
      } else expect(dispatchHeldWithSignal).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
    }
  );

  it("refuses an observation without its canonical variant rather than assuming no prerequisite", async () => {
    const dispatchHeldWithSignal = vi.fn(async () => undefined);
    const record = createDurableWorkHandlers({
      dispatch: vi.fn(),
      dispatchHeldWithSignal,
    } as never);
    await expect(
      record["channel-observation"].prepare!(
        owner("channel-1"),
        claim("observation:unknown", 7),
        new AbortController().signal
      )
    ).rejects.toThrow("canonical causal variant");
    expect(dispatchHeldWithSignal).not.toHaveBeenCalled();
  });

  it("executes channel observation on its exact owner and claim generation", async () => {
    const dispatch = vi.fn();
    const dispatchHeldWithSignal = vi.fn(async () => ({ observed: true }));
    const record = createDurableWorkHandlers({ dispatch, dispatchHeldWithSignal } as never);
    const work = claim("observation:event-1", 7);
    const signal = new AbortController().signal;
    await expect(
      record["channel-observation"].execute(owner("channel-1"), work, signal)
    ).resolves.toEqual({ observed: true });
    expect(dispatchHeldWithSignal).toHaveBeenCalledExactlyOnceWith(
      owner("channel-1"),
      signal,
      "executeChannelObservationClaim",
      {
        itemId: "observation:event-1",
        generation: 7,
      }
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("executes channel maintenance on its owner instead of requiring a participant target", async () => {
    const dispatch = vi.fn(async () => []);
    const dispatchHeldWithSignal = vi.fn(async () => ({ processed: true }));
    const record = createDurableWorkHandlers({
      dispatch,
      dispatchHeldWithSignal,
    } as never);
    const work = claim("maintenance:call-deadline:call-1", 4);
    work.payload = { workKind: "channel-maintenance" };

    await expect(
      record["channel-delivery"].execute(owner("channel-1"), work, new AbortController().signal)
    ).resolves.toEqual({ processed: true });
    expect(dispatchHeldWithSignal).toHaveBeenCalledWith(
      owner("channel-1"),
      expect.any(AbortSignal),
      "executeChannelMaintenanceClaim",
      { itemId: work.itemId, generation: 4 }
    );
  });

  it("terminalizes delivery to a retired durable target without retry churn", async () => {
    const event = { id: 7, messageId: "event-7" };
    const dispatchHeldWithSignal = vi.fn(async (_owner, _signal, method) => {
      if (method === "getEnvelope") return event;
      throw Object.assign(new Error("durable target is retired"), {
        code: "DURABLE_OBJECT_RETIRED",
      });
    });
    const record = createDurableWorkHandlers({
      dispatch: vi.fn(),
      dispatchHeldWithSignal,
    } as never);
    const work = claim("delivery-retired", 2);
    work.payload = {
      target: owner("retired-agent"),
      delivery: {
        deliveryId: "delivery-retired",
        channelId: "channel-1",
        envelopeId: "event-7",
        eventSequence: 7,
      },
    };
    await expect(
      record["channel-delivery"].execute(owner("channel-1"), work, new AbortController().signal)
    ).resolves.toEqual({ deliveryId: "delivery-retired", disposition: "retired" });
    expect(dispatchHeldWithSignal).toHaveBeenCalledTimes(2);
  });

  it("hydrates the exact canonical image payload at delivery and preserves the recipient start marker", async () => {
    const outcome = { processed: true, recipientExecutionStartedAt: 1_234 };
    const event = { id: 7, messageId: "event-7", payload: { image: "A".repeat(3_000_000) } };
    const dispatchHeldWithSignal = vi.fn(async (_owner, _signal, method) =>
      method === "getEnvelope" ? event : outcome
    );
    const record = createDurableWorkHandlers({
      dispatch: vi.fn(),
      dispatchHeldWithSignal,
    } as never);
    const work = claim("delivery-direct", 5);
    const target = owner("direct-agent");
    const delivery = {
      deliveryId: "delivery-direct",
      channelId: "channel-1",
      participantId: "agent-1",
      envelopeId: "event-7",
      eventSequence: 7,
      agenticContext: { version: 1 },
    };
    work.payload = { target, delivery };
    await expect(
      record["channel-delivery"].execute(owner("channel-1"), work, new AbortController().signal)
    ).resolves.toEqual(outcome);
    expect(dispatchHeldWithSignal).toHaveBeenNthCalledWith(
      1,
      owner("channel-1"),
      expect.any(AbortSignal),
      "getEnvelope",
      "event-7"
    );
    const { envelopeId: _id, ...fields } = delivery;
    expect(dispatchHeldWithSignal).toHaveBeenNthCalledWith(
      2,
      target,
      expect.any(AbortSignal),
      "acceptChannelDelivery",
      { ...fields, envelope: { kind: "log", phase: "live", event } }
    );
  });

  it("refuses a canonical event that differs from the leased mailbox reference", async () => {
    const dispatchHeldWithSignal = vi.fn(async () => ({ id: 8, messageId: "event-7" }));
    const record = createDurableWorkHandlers({
      dispatch: vi.fn(),
      dispatchHeldWithSignal,
    } as never);
    const work = claim("delivery-wrong", 5);
    work.payload = {
      target: owner("agent"),
      delivery: { envelopeId: "event-7", eventSequence: 7 },
    };
    await expect(
      record["channel-delivery"].execute(owner("channel-1"), work, new AbortController().signal)
    ).rejects.toThrow("differs");
    expect(dispatchHeldWithSignal).toHaveBeenCalledOnce();
  });

  it("preserves the original structured failure through the owner settlement wire", async () => {
    const original = Object.assign(
      new Error("publication refused", { cause: new Error("original storage cause") }),
      { code: "STORAGE_REFUSED" }
    );
    const dispatch = vi.fn(async (_owner, method, ...args) => {
      expect(method).toBe("failReadyWork");
      const wire = decodeRpcJson(encodeRpcJson(args)) as [
        string,
        { error: Parameters<typeof deserializeRpcFailure>[0] },
      ];
      const restored = deserializeRpcFailure(wire[1].error);
      expect(restored).toMatchObject({
        message: original.message,
        code: "STORAGE_REFUSED",
        stack: original.stack,
        cause: expect.objectContaining({ message: "original storage cause" }),
      });
      return { failed: true };
    });
    const handlers = createDurableWorkHandlers({
      dispatch,
      dispatchHeldWithSignal: vi.fn(),
    } as never);
    await expect(
      handlers["workspace-publication"].fail(owner("gad"), {
        workerId: "driver-test",
        itemId: "intent",
        generation: 1,
        error: original,
      })
    ).resolves.toEqual({ failed: true });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("delivers committed workspace publications to their exact channel target", async () => {
    const dispatchHeldWithSignal = vi.fn(async () => ({ admitted: 2 }));
    const record = createDurableWorkHandlers({
      dispatch: vi.fn(),
      dispatchHeldWithSignal,
    } as never);
    const work = claim("publication-1", 3);
    const target = {
      source: "workers/pubsub-channel",
      className: "PubSubChannel",
      objectKey: "channel-7",
    };
    work.payload = {
      laneKey: "channel-7",
      target,
      intents: [
        {
          envelopeId: "event-1",
          actor: { participantId: "agent" },
          payloadKind: "agentic",
          payload: {},
        },
        {
          envelopeId: "event-2",
          actor: { participantId: "agent" },
          payloadKind: "agentic",
          payload: {},
        },
      ],
    };

    await expect(
      record["workspace-publication"].execute(owner("gad"), work, new AbortController().signal)
    ).resolves.toEqual({ admitted: 2 });
    expect(dispatchHeldWithSignal).toHaveBeenCalledWith(
      target,
      expect.any(AbortSignal),
      "admitPublishedEnvelopes",
      (work.payload as { intents: unknown }).intents
    );
  });

  it("terminalizes publication to a retired channel without retry churn", async () => {
    const dispatchHeldWithSignal = vi.fn(async () => {
      throw Object.assign(new Error("channel is retired"), {
        code: "DURABLE_OBJECT_RETIRED",
      });
    });
    const record = createDurableWorkHandlers({
      dispatch: vi.fn(),
      dispatchHeldWithSignal,
    } as never);
    const work = claim("publication-retired", 7);
    work.payload = {
      target: {
        source: "workers/pubsub-channel",
        className: "PubSubChannel",
        objectKey: "retired-channel",
      },
      intents: [
        {
          envelopeId: "event-1",
          actor: { participantId: "agent" },
          payloadKind: "agentic",
          payload: {},
        },
        {
          envelopeId: "event-2",
          actor: { participantId: "agent" },
          payloadKind: "agentic",
          payload: {},
        },
      ],
    };

    await expect(
      record["workspace-publication"].execute(owner("gad"), work, new AbortController().signal)
    ).resolves.toEqual({ discarded: 2 });
    expect(dispatchHeldWithSignal).toHaveBeenCalledOnce();
  });

  it("fails a publication claim unless the channel acknowledges the complete batch", async () => {
    const record = createDurableWorkHandlers({
      dispatch: vi.fn(),
      dispatchHeldWithSignal: vi.fn(async () => ({ admitted: 0 })),
    } as never);
    const work = claim("publication-1");
    work.payload = {
      target: {
        source: "workers/pubsub-channel",
        className: "PubSubChannel",
        objectKey: "channel-7",
      },
      intents: [
        {
          envelopeId: "event-1",
          actor: { participantId: "agent" },
          payloadKind: "agentic",
          payload: {},
        },
      ],
    };

    await expect(
      record["workspace-publication"].execute(owner("gad"), work, new AbortController().signal)
    ).rejects.toThrow(/acknowledged 0 of 1 envelopes/);
  });

  it("adopts only on recovery claims", async () => {
    const dispatchHeldWithSignal = vi.fn(
      async (_ref: DORef, _signal: AbortSignal, method: string) =>
        method === "claimReadyWork" ? [] : undefined
    );
    const record = createDurableWorkHandlers({
      dispatch: vi.fn(),
      dispatchHeldWithSignal,
    } as never);
    const request = {
      workerId: "driver-1",
      now: 1_000,
      limit: 1,
    };

    await record["channel-delivery"].claim(
      owner("agent-1"),
      {
        ...request,
        trigger: "hint",
      },
      new AbortController().signal
    );
    await record["channel-delivery"].claim(
      owner("agent-1"),
      {
        ...request,
        trigger: "continuation",
      },
      new AbortController().signal
    );
    expect(dispatchHeldWithSignal).not.toHaveBeenCalledWith(
      owner("agent-1"),
      expect.any(AbortSignal),
      "adoptDurableWorkWorker",
      "driver-1"
    );

    await record["channel-delivery"].claim(
      owner("agent-1"),
      {
        ...request,
        trigger: "recovery",
      },
      new AbortController().signal
    );
    expect(dispatchHeldWithSignal).toHaveBeenNthCalledWith(
      3,
      owner("agent-1"),
      expect.any(AbortSignal),
      "adoptDurableWorkWorker",
      "driver-1"
    );
  });
});
