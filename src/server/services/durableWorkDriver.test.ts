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
      "agent-inbox": handler,
      "agent-effect": handler,
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
    driver.notify({ owner: owner("a"), queues: ["agent-effect"] });
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
    driver.notify({ owner: owner("a"), queues: ["agent-effect"] });
    driver.notify({ owner: owner("a"), queues: ["agent-effect"] });
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
    driver.notify({ owner: owner("slow"), queues: ["agent-effect"] });
    driver.notify({ owner: owner("fast"), queues: ["agent-effect"] });
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
    driver.notify({ owner: owner("removed"), queues: ["agent-effect"] });
    await vi.advanceTimersByTimeAsync(0);
    driver.notify({ owner: owner("removed"), queues: ["agent-effect"] });
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
      queues: ["agent-inbox"],
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
          queue: "agent-inbox",
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
    const scanReadyOwners = vi.fn(async () => {
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

  it("scans owner recovery status through a single low-priority lane", async () => {
    const registrations = Array.from({ length: 12 }, (_, index) => ({
      owner: owner(`registered-${index}`),
      queues: ["agent-inbox"] as const,
    }));
    let active = 0;
    let maxActive = 0;
    const dispatch = vi.fn(async (_ref: DORef, method: string) => {
      if (method === "durableWorkOwnerList") return registrations;
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return { readyQueues: ["agent-inbox"] };
    });
    const scan = createDurableWorkOwnerScanner(
      { dispatch } as never,
      {
        source: "vibestudio/internal",
        className: "WorkspaceDO",
        objectKey: "workspace",
      },
      "driver-generation-1"
    );

    const result = scan();
    await vi.advanceTimersByTimeAsync(200);

    await expect(result).resolves.toHaveLength(registrations.length);
    expect(maxActive).toBe(1);
  });

  it("reports an unchanged permanent readiness failure only once while continuing probes", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registration = { owner: owner("blocked"), queues: ["agent-effect"] as const };
    const dispatch = vi.fn(async (_ref: DORef, method: string) => {
      if (method === "durableWorkOwnerList") return [registration];
      throw Object.assign(new Error("sealed execution unavailable"), {
        code: "RUNTIME_IMAGE_UNAVAILABLE",
      });
    });
    const scan = createDurableWorkOwnerScanner(
      { dispatch } as never,
      {
        source: "vibestudio/internal",
        className: "WorkspaceDO",
        objectKey: "workspace",
      },
      "driver-generation-1"
    );

    await scan();
    await scan();

    expect(dispatch).toHaveBeenCalledTimes(4);
    expect(
      consoleWarn.mock.calls.filter(([message]) => String(message).includes("readiness blocked"))
    ).toHaveLength(1);
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

  it("adopts only on recovery claims", async () => {
    const dispatch = vi.fn(async (_ref: DORef, method: string) =>
      method === "claimReadyWork" ? [] : undefined
    );
    const record = createDurableWorkHandlers({
      dispatch,
      dispatchHeldWithSignal: vi.fn(),
    } as never);
    const request = {
      workerId: "driver-1",
      now: 1_000,
      limit: 1,
    };

    await record["agent-effect"].claim(owner("agent-1"), {
      ...request,
      trigger: "hint",
    });
    await record["agent-effect"].claim(owner("agent-1"), {
      ...request,
      trigger: "continuation",
    });
    expect(dispatch).not.toHaveBeenCalledWith(
      owner("agent-1"),
      "adoptDurableWorkWorker",
      "driver-1"
    );

    await record["agent-effect"].claim(owner("agent-1"), {
      ...request,
      trigger: "recovery",
    });
    expect(dispatch).toHaveBeenCalledWith(owner("agent-1"), "adoptDurableWorkWorker", "driver-1");
  });
});
