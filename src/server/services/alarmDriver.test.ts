// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlarmDriver } from "./alarmDriver.js";
import { LifecycleDriver } from "./lifecycleDriver.js";
import type { DODispatch } from "../doDispatch.js";
import type { WorkerdManager } from "../workerdManager.js";
import type { DORef } from "@vibestudio/shared/doDispatcher";

type Alarm = { source: string; className: string; objectKey: string; wakeAt: number };

function replaceAlarm(alarms: Alarm[], alarm: Alarm): void {
  const index = alarms.findIndex(
    (candidate) =>
      candidate.source === alarm.source &&
      candidate.className === alarm.className &&
      candidate.objectKey === alarm.objectKey
  );
  if (index === -1) alarms.push(alarm);
  else alarms[index] = alarm;
}

function clearAlarm(alarms: Alarm[], key: Pick<Alarm, "source" | "className" | "objectKey">): void {
  const index = alarms.findIndex(
    (candidate) =>
      candidate.source === key.source &&
      candidate.className === key.className &&
      candidate.objectKey === key.objectKey
  );
  if (index !== -1) alarms.splice(index, 1);
}

function makeHarness(initial: Alarm[] = []) {
  const alarms = [...initial];
  const fired: DORef[] = [];

  const doDispatch = {
    dispatch: async (_ref: DORef, method: string, ...args: unknown[]) => {
      if (method === "alarmNextWakeAt") {
        return alarms.length ? Math.min(...alarms.map((a) => a.wakeAt)) : null;
      }
      if (method === "alarmListDue") {
        const now = args[0] as number;
        return alarms.filter((a) => a.wakeAt <= now);
      }
      if (method === "alarmSet") {
        replaceAlarm(alarms, args[0] as Alarm);
        return undefined;
      }
      if (method === "alarmClear") {
        clearAlarm(alarms, args[0] as Alarm);
        return undefined;
      }
      return undefined;
    },
    dispatchAlarm: async (ref: DORef) => {
      fired.push(ref);
      return { nextAlarm: null };
    },
  } as unknown as DODispatch;

  const driver = new AlarmDriver({ doDispatch, workspaceId: "ws-1" });
  return { driver, alarms, fired };
}

describe("AlarmDriver", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("fires __alarm for a due alarm and reschedules to the next", async () => {
    vi.setSystemTime(0);
    const { driver, fired } = makeHarness([
      { source: "workers/poller", className: "PollerDO", objectKey: "p-1", wakeAt: 1_000 },
      { source: "workers/poller", className: "PollerDO", objectKey: "p-2", wakeAt: 3_000 },
    ]);

    driver.start();
    await vi.advanceTimersByTimeAsync(0); // let the initial reschedule settle

    // Before the first wake — nothing fired yet.
    await vi.advanceTimersByTimeAsync(999);
    expect(fired).toHaveLength(0);

    // At 1s, p-1 fires; driver re-arms for p-2.
    await vi.advanceTimersByTimeAsync(1);
    expect(fired.map((r) => r.objectKey)).toEqual(["p-1"]);

    // At 3s, p-2 fires.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fired.map((r) => r.objectKey)).toEqual(["p-1", "p-2"]);

    driver.stop();
  });

  it("re-arms when a newly-set alarm is sooner than the pending one", async () => {
    vi.setSystemTime(0);
    const { driver, alarms, fired } = makeHarness([
      { source: "workers/poller", className: "PollerDO", objectKey: "far", wakeAt: 10_000 },
    ]);
    driver.start();
    await vi.advanceTimersByTimeAsync(0);

    // A new, sooner alarm appears; notifyChanged re-arms the timer.
    alarms.push({
      source: "workers/poller",
      className: "PollerDO",
      objectKey: "soon",
      wakeAt: 500,
    });
    driver.notifyChanged();
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(500);
    expect(fired.map((r) => r.objectKey)).toEqual(["soon"]);

    driver.stop();
  });

  it("stop() cancels the pending timer", async () => {
    vi.setSystemTime(0);
    const { driver, fired } = makeHarness([
      { source: "workers/poller", className: "PollerDO", objectKey: "p-1", wakeAt: 1_000 },
    ]);
    driver.start();
    await vi.advanceTimersByTimeAsync(0);
    driver.stop();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(fired).toHaveLength(0);
  });

  it("durably defers agent alarms while authority is paused", async () => {
    vi.setSystemTime(10_000);
    const due: Alarm = {
      source: "workers/agent-worker",
      className: "AiChatWorker",
      objectKey: "agent-1",
      wakeAt: 10_000,
    };
    const alarms = [due];
    const dispatchAlarm = vi.fn(async () => ({ nextAlarm: null }));
    const dispatch = vi.fn(async (_ref: DORef, method: string, ...args: unknown[]) => {
      if (method === "alarmNextWakeAt") return alarms[0]?.wakeAt ?? null;
      if (method === "alarmListDue") {
        const now = args[0] as number;
        return alarms.filter((alarm) => alarm.wakeAt <= now);
      }
      if (method === "alarmSet") {
        replaceAlarm(alarms, args[0] as Alarm);
        return undefined;
      }
      throw new Error(`Unexpected workspace method ${method}`);
    });
    const isAuthorityPaused = vi.fn(() => true);
    const driver = new AlarmDriver({
      workspaceId: "ws-1",
      doDispatch: { dispatch, dispatchAlarm } as unknown as DODispatch,
      isAuthorityPaused,
    });

    driver.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(isAuthorityPaused).toHaveBeenCalledWith({
      source: due.source,
      className: due.className,
      objectKey: due.objectKey,
    });
    expect(dispatchAlarm).not.toHaveBeenCalled();
    expect(alarms).toEqual([{ ...due, wakeAt: 70_000 }]);
    driver.stop();
  });

  it("persists the next schedule returned by an alarm handler after dispatch completes", async () => {
    vi.setSystemTime(0);
    const testPolicy = {
      policyId: "system-test:permissions-list",
      kind: "orchestrator" as const,
    };
    const alarms: Array<Alarm & { testPolicy?: typeof testPolicy }> = [
      {
        source: "workers/poller",
        className: "PollerDO",
        objectKey: "p-1",
        wakeAt: 100,
        testPolicy,
      },
    ];
    const dispatch = vi.fn(async (_ref: DORef, method: string, ...args: unknown[]) => {
      if (method === "alarmNextWakeAt") {
        return alarms.length ? Math.min(...alarms.map((alarm) => alarm.wakeAt)) : null;
      }
      if (method === "alarmListDue") {
        const now = args[0] as number;
        return alarms.filter((alarm) => alarm.wakeAt <= now);
      }
      if (method === "alarmSet") {
        replaceAlarm(alarms, args[0] as Alarm);
        return undefined;
      }
      if (method === "alarmClear") {
        clearAlarm(alarms, args[0] as Alarm);
        return undefined;
      }
      return undefined;
    });
    const dispatchAlarm = vi
      .fn()
      .mockResolvedValueOnce({ nextAlarm: { wakeAt: 250 } })
      .mockResolvedValue({ nextAlarm: null });
    const driver = new AlarmDriver({
      workspaceId: "ws-1",
      doDispatch: { dispatch, dispatchAlarm },
    });

    driver.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(dispatchAlarm).toHaveBeenNthCalledWith(
      1,
      { source: "workers/poller", className: "PollerDO", objectKey: "p-1" },
      expect.any(AbortSignal),
      testPolicy
    );
    expect(alarms).toContainEqual({
      source: "workers/poller",
      className: "PollerDO",
      objectKey: "p-1",
      wakeAt: 250,
    });

    await vi.advanceTimersByTimeAsync(150);
    expect(dispatchAlarm).toHaveBeenCalledTimes(2);
    driver.stop();
  });

  it("quiesces the owned alarm transport without consuming its wake, then permits lifecycle release", async () => {
    vi.setSystemTime(0);
    const due: Alarm = {
      source: "workers/agent-worker",
      className: "AiChatWorker",
      objectKey: "agent-1",
      wakeAt: 0,
    };
    const alarms = [due];
    const durableMutations: string[] = [];
    let alarmTransportActive = false;
    let alarmSignal: AbortSignal | undefined;
    const releaseActivation = vi.fn(async () => {
      expect(alarmTransportActive).toBe(false);
      return { status: "ready" as const, detail: { releasedEffects: 1 } };
    });
    const dispatch = vi.fn(async (_ref: DORef, method: string, ...args: unknown[]) => {
      if (method === "alarmNextWakeAt") return alarms[0]?.wakeAt ?? null;
      if (method === "alarmListDue") return [...alarms];
      if (method === "alarmSet" || method === "alarmClear") {
        durableMutations.push(method);
        return undefined;
      }
      if (method === "lifecycleOpenEpoch") return "epoch-1";
      if (method === "lifecycleListLeases") return [due];
      if (method === "lifecycleRecordOp") return undefined;
      throw new Error(`Unexpected workspace method ${method} (${JSON.stringify(args)})`);
    });
    const dispatchAlarm = vi.fn(
      async (_ref: DORef, signal?: AbortSignal): Promise<{ nextAlarm: null }> => {
        if (!signal) throw new Error("Alarm dispatch did not receive scheduler ownership signal");
        alarmSignal = signal;
        alarmTransportActive = true;
        return await new Promise<{ nextAlarm: null }>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }).finally(() => {
          alarmTransportActive = false;
        });
      }
    );
    const dispatchLifecycle = vi.fn(async () => releaseActivation());
    const doDispatch = {
      dispatch,
      dispatchAlarm,
      dispatchLifecycle,
    } as unknown as DODispatch;
    const driver = new AlarmDriver({ workspaceId: "ws-1", doDispatch });

    driver.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatchAlarm).toHaveBeenCalledOnce();
    expect(alarmTransportActive).toBe(true);

    await driver.quiesce();
    expect(alarmSignal?.aborted).toBe(true);
    expect(alarmTransportActive).toBe(false);
    expect(durableMutations).toEqual([]);
    expect(alarms).toEqual([due]);

    const lifecycle = new LifecycleDriver({
      workspaceId: "ws-1",
      doDispatch,
      workerdManager: { getBootGeneration: () => 1 } as WorkerdManager,
    });
    await lifecycle.prepareForShutdown(1_000);
    expect(dispatchLifecycle).toHaveBeenCalledOnce();
    expect(releaseActivation).toHaveBeenCalledOnce();
    expect(alarms).toEqual([due]);
  });
});

/** Harness whose `dispatchAlarm` always fails, recording the durable retry. */
function makeFailingHarness(initial: Alarm[]) {
  const alarms = [...initial];
  const reArmed: Array<{ objectKey: string }> = [];
  const doDispatch = {
    dispatch: async (_ref: DORef, method: string, ...args: unknown[]) => {
      if (method === "alarmNextWakeAt") {
        return alarms.length ? Math.min(...alarms.map((a) => a.wakeAt)) : null;
      }
      if (method === "alarmListDue") {
        const now = args[0] as number;
        return alarms.filter((a) => a.wakeAt <= now);
      }
      if (method === "alarmSet") {
        reArmed.push(args[0] as { objectKey: string });
        replaceAlarm(alarms, args[0] as Alarm);
      }
      if (method === "alarmClear") {
        clearAlarm(alarms, args[0] as Alarm);
      }
      return undefined;
    },
    dispatchAlarm: async () => {
      throw new Error("alarm transport failed");
    },
  } as unknown as DODispatch;
  const driver = new AlarmDriver({ doDispatch, workspaceId: "ws-1" });
  return { driver, reArmed };
}

describe("AlarmDriver re-arm on dispatch failure", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("re-arms a normal at-least-once alarm whose dispatch fails (wake must not be lost)", async () => {
    vi.setSystemTime(0);
    const { driver, reArmed } = makeFailingHarness([
      { source: "workers/poller", className: "PollerDO", objectKey: "k", wakeAt: 1_000 },
    ]);
    driver.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000); // fire → dispatch fails → re-arm
    expect(reArmed).toHaveLength(1);
    expect(reArmed[0]).toMatchObject({ objectKey: "k" });
    driver.stop();
  });

  it("treats an invalid alarm response as a failed dispatch and preserves a normal wake", async () => {
    vi.setSystemTime(0);
    const alarm = {
      source: "workers/poller",
      className: "PollerDO",
      objectKey: "k",
      wakeAt: 0,
    };
    const pending = [alarm];
    const reArmed: unknown[] = [];
    const dispatch = vi.fn(async (_ref: DORef, method: string, ...args: unknown[]) => {
      if (method === "alarmNextWakeAt") {
        return pending.length ? Math.min(...pending.map((item) => item.wakeAt)) : null;
      }
      if (method === "alarmListDue") return [...pending];
      if (method === "alarmSet") {
        reArmed.push(args[0]);
        replaceAlarm(pending, args[0] as Alarm);
      }
      if (method === "alarmClear") {
        clearAlarm(pending, args[0] as Alarm);
      }
      return undefined;
    });
    const driver = new AlarmDriver({
      workspaceId: "ws-1",
      doDispatch: {
        dispatch,
        dispatchAlarm: vi.fn(async () => ({ result: "legacy-shape" }) as never),
      },
    });

    driver.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(reArmed).toHaveLength(1);
    expect(reArmed[0]).toMatchObject({ objectKey: "k" });
    driver.stop();
  });

  it("retries a completed alarm when durable acknowledgement fails", async () => {
    vi.setSystemTime(0);
    const due: Alarm = {
      source: "workers/poller",
      className: "PollerDO",
      objectKey: "k",
      wakeAt: 0,
    };
    let pending = true;
    let clearAttempts = 0;
    const dispatch = vi.fn(async (_ref: DORef, method: string) => {
      if (method === "alarmNextWakeAt") return pending ? due.wakeAt : null;
      if (method === "alarmListDue") return pending ? [due] : [];
      if (method === "alarmClear") {
        clearAttempts++;
        if (clearAttempts === 1) throw new TypeError("workspace acknowledgement unavailable");
        pending = false;
      }
      return undefined;
    });
    const dispatchAlarm = vi.fn(async () => ({ nextAlarm: null }));
    const driver = new AlarmDriver({
      workspaceId: "ws-1",
      doDispatch: { dispatch, dispatchAlarm } as unknown as DODispatch,
    });

    driver.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatchAlarm).toHaveBeenCalledTimes(1);
    expect(pending).toBe(true);

    await vi.advanceTimersByTimeAsync(999);
    expect(dispatchAlarm).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(dispatchAlarm).toHaveBeenCalledTimes(2);
    expect(pending).toBe(false);
    driver.stop();
  });
});

describe("AlarmDriver single-flight scheduling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("coalesces mutation notifications while a schedule read is in flight", async () => {
    let releaseFirst!: (value: number | null) => void;
    const first = new Promise<number | null>((resolve) => {
      releaseFirst = resolve;
    });
    const dispatch = vi
      .fn()
      .mockImplementationOnce(async () => first)
      .mockResolvedValue(null);
    const driver = new AlarmDriver({
      workspaceId: "ws-1",
      doDispatch: {
        dispatch,
        dispatchAlarm: vi.fn(async () => ({ nextAlarm: null })),
      } as unknown as DODispatch,
    });

    driver.start();
    for (let i = 0; i < 100; i++) driver.notifyChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch).toHaveBeenCalledTimes(1);

    releaseFirst(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch).toHaveBeenCalledTimes(2);
    driver.stop();
  });

  it("never overlaps a recurring target with its still-running prior alarm", async () => {
    vi.setSystemTime(0);
    const alarms: Alarm[] = [
      { source: "workers/poller", className: "PollerDO", objectKey: "same", wakeAt: 0 },
    ];
    let releaseFirst!: () => void;
    const firstDispatch = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let activeDispatches = 0;
    let maxActiveDispatches = 0;
    const dispatchAlarm = vi.fn(async () => {
      activeDispatches++;
      maxActiveDispatches = Math.max(maxActiveDispatches, activeDispatches);
      try {
        if (dispatchAlarm.mock.calls.length === 1) await firstDispatch;
      } finally {
        activeDispatches--;
      }
      return dispatchAlarm.mock.calls.length === 1
        ? { nextAlarm: { wakeAt: Date.now() + 100 } }
        : { nextAlarm: null };
    });
    const dispatch = vi.fn(async (_ref: DORef, method: string, ...args: unknown[]) => {
      if (method === "alarmNextWakeAt") {
        return alarms.length ? Math.min(...alarms.map((alarm) => alarm.wakeAt)) : null;
      }
      if (method === "alarmListDue") {
        const now = args[0] as number;
        return alarms.filter((alarm) => alarm.wakeAt <= now);
      }
      if (method === "alarmSet") {
        replaceAlarm(alarms, args[0] as Alarm);
        return undefined;
      }
      if (method === "alarmClear") {
        clearAlarm(alarms, args[0] as Alarm);
        return undefined;
      }
      return undefined;
    });
    const driver = new AlarmDriver({
      workspaceId: "ws-1",
      doDispatch: { dispatch, dispatchAlarm } as unknown as DODispatch,
    });

    driver.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(dispatchAlarm).toHaveBeenCalledTimes(1);

    releaseFirst();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(dispatchAlarm).toHaveBeenCalledTimes(2);
    expect(maxActiveDispatches).toBe(1);
    driver.stop();
  });

  it("recovers a transient due-list failure through one bounded retry timer", async () => {
    vi.setSystemTime(0);
    const due = { source: "workers/poller", className: "PollerDO", objectKey: "same", wakeAt: 0 };
    let takeAttempts = 0;
    let pending = true;
    const dispatch = vi.fn(async (_ref: DORef, method: string) => {
      if (method === "alarmNextWakeAt") return pending ? 0 : null;
      if (method === "alarmListDue") {
        takeAttempts++;
        if (takeAttempts === 1) throw new TypeError("fetch failed");
        return pending ? [due] : [];
      }
      if (method === "alarmClear") pending = false;
      return undefined;
    });
    const dispatchAlarm = vi.fn(async () => ({ nextAlarm: null }));
    const driver = new AlarmDriver({
      workspaceId: "ws-1",
      doDispatch: {
        dispatch,
        dispatchAlarm,
      } as unknown as DODispatch,
    });

    driver.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch.mock.calls.filter((call) => call[1] === "alarmListDue")).toHaveLength(1);

    // A concurrent durable-row notification must not replace the fire failure's
    // bounded retry with an immediate refresh of the same past-due row.
    driver.notifyChanged();
    await vi.advanceTimersByTimeAsync(999);
    expect(dispatch.mock.calls.filter((call) => call[1] === "alarmNextWakeAt")).toHaveLength(1);
    expect(dispatch.mock.calls.filter((call) => call[1] === "alarmListDue")).toHaveLength(1);
    expect(dispatchAlarm).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(dispatch.mock.calls.filter((call) => call[1] === "alarmListDue")).toHaveLength(2);
    expect(dispatchAlarm).toHaveBeenCalledOnce();
    driver.stop();
  });
});
