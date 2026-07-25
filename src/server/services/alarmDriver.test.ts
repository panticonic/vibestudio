// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DORef } from "@vibestudio/shared/doDispatcher";
import type { AgentExecutionTestPolicy } from "@vibestudio/rpc";
import type { DODispatch } from "../doDispatch.js";
import { AlarmDriver } from "./alarmDriver.js";

type AlarmRow = {
  source: string;
  className: string;
  objectKey: string;
  wakeAt: number;
  dispatchGeneration: number;
  dispatchOwner: string | null;
  dispatchExpiresAt: number | null;
  testPolicy?: AgentExecutionTestPolicy;
};

type AlarmInput = Pick<AlarmRow, "source" | "className" | "objectKey" | "wakeAt"> &
  Partial<
    Pick<AlarmRow, "dispatchGeneration" | "dispatchOwner" | "dispatchExpiresAt" | "testPolicy">
  >;

function keyOf(key: Pick<AlarmRow, "source" | "className" | "objectKey">): string {
  return `${key.source}\u0000${key.className}\u0000${key.objectKey}`;
}

function makeHarness(
  initial: AlarmInput[] = [],
  dispatchAlarm: DODispatch["dispatchAlarm"] = vi.fn(async () => ({ nextAlarm: null }))
) {
  const alarms = initial.map<AlarmRow>((row) => ({
    ...row,
    dispatchGeneration: row.dispatchGeneration ?? 0,
    dispatchOwner: row.dispatchOwner ?? null,
    dispatchExpiresAt: row.dispatchExpiresAt ?? null,
  }));
  const workspaceCalls: string[] = [];
  let activeWorkerId: string | null = null;
  const dispatch = vi.fn(async (_ref: DORef, method: string, ...args: unknown[]) => {
    workspaceCalls.push(method);
    if (method === "alarmAdoptWorker") {
      const previousWorkerId = activeWorkerId;
      activeWorkerId = args[0] as string;
      for (const row of alarms) {
        row.dispatchOwner = null;
        row.dispatchExpiresAt = null;
      }
      return { previousWorkerId };
    }
    if (method === "alarmNextWakeAt") {
      const excluded = new Set(
        ((args[1] as Array<Pick<AlarmRow, "source" | "className" | "objectKey">>) ?? []).map(keyOf)
      );
      const eligible = alarms.filter(
        (row) => row.dispatchOwner === null && !excluded.has(keyOf(row))
      );
      if (eligible.length === 0) return null;
      return Math.min(...eligible.map((row) => row.wakeAt));
    }
    if (method === "alarmClaimDue") {
      const input = args[0] as {
        now: number;
        workerId: string;
        limit: number;
        exclude?: Array<Pick<AlarmRow, "source" | "className" | "objectKey">>;
      };
      if (input.workerId !== activeWorkerId) throw new Error("inactive alarm worker generation");
      const excluded = new Set((input.exclude ?? []).map(keyOf));
      const selected = alarms
        .filter((row) => row.wakeAt <= input.now && !row.dispatchOwner && !excluded.has(keyOf(row)))
        .sort((a, b) => a.wakeAt - b.wakeAt || keyOf(a).localeCompare(keyOf(b)))
        .slice(0, input.limit);
      return selected.map((row) => {
        row.dispatchGeneration++;
        row.dispatchOwner = input.workerId;
        row.dispatchExpiresAt = null;
        return {
          source: row.source,
          className: row.className,
          objectKey: row.objectKey,
          wakeAt: row.wakeAt,
          dispatchGeneration: row.dispatchGeneration,
          ...(row.testPolicy ? { testPolicy: row.testPolicy } : {}),
        };
      });
    }
    if (method === "alarmSet") {
      const input = args[0] as AlarmInput;
      const index = alarms.findIndex((row) => keyOf(row) === keyOf(input));
      if (input.dispatchOwner !== undefined) {
        const row = alarms[index];
        if (
          !row ||
          row.dispatchOwner !== input.dispatchOwner ||
          row.dispatchGeneration !== input.dispatchGeneration
        ) {
          return "stale";
        }
        row.wakeAt = input.wakeAt;
        row.dispatchOwner = null;
        row.dispatchExpiresAt = null;
        return "accepted";
      }
      if (index === -1) {
        alarms.push({
          ...input,
          dispatchGeneration: 0,
          dispatchOwner: null,
          dispatchExpiresAt: null,
        });
      } else {
        const row = alarms[index]!;
        row.wakeAt = input.wakeAt;
        row.dispatchOwner = null;
        row.dispatchExpiresAt = null;
      }
      return "accepted";
    }
    if (method === "alarmClear") {
      const input = args[0] as Omit<AlarmInput, "wakeAt">;
      const index = alarms.findIndex((row) => keyOf(row) === keyOf(input));
      const row = alarms[index];
      if (input.dispatchOwner !== undefined) {
        if (
          !row ||
          row.dispatchOwner !== input.dispatchOwner ||
          row.dispatchGeneration !== input.dispatchGeneration
        ) {
          return "stale";
        }
      }
      if (index !== -1) alarms.splice(index, 1);
      return "accepted";
    }
    throw new Error(`Unexpected workspace method ${method}`);
  });
  const doDispatch = { dispatch, dispatchAlarm } as unknown as DODispatch;
  return { alarms, dispatch, doDispatch, workspaceCalls };
}

describe("AlarmDriver durable concurrent scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("fires a due alarm and persists its next schedule under the claim generation", async () => {
    const dispatchAlarm = vi
      .fn()
      .mockResolvedValueOnce({ nextAlarm: { wakeAt: 250 } })
      .mockResolvedValue({ nextAlarm: null });
    const harness = makeHarness(
      [{ source: "workers/poller", className: "PollerDO", objectKey: "p-1", wakeAt: 100 }],
      dispatchAlarm
    );
    const driver = new AlarmDriver({
      workspaceId: "ws-1",
      doDispatch: harness.doDispatch,
      workerId: "driver-1",
    });

    driver.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(dispatchAlarm).toHaveBeenCalledTimes(1);
    expect(harness.alarms).toMatchObject([
      { objectKey: "p-1", wakeAt: 250, dispatchGeneration: 1, dispatchOwner: null },
    ]);

    await vi.advanceTimersByTimeAsync(150);
    expect(dispatchAlarm).toHaveBeenCalledTimes(2);
    expect(harness.alarms).toEqual([]);
    driver.stop();
  });

  it("admits another due target while the first alarm handler is still running", async () => {
    let releaseSlow!: () => void;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const started: string[] = [];
    const dispatchAlarm = vi.fn(async (ref: DORef) => {
      started.push(ref.objectKey);
      if (ref.objectKey === "slow") await slow;
      return { nextAlarm: null };
    });
    const harness = makeHarness(
      [{ source: "workers/poller", className: "PollerDO", objectKey: "slow", wakeAt: 0 }],
      dispatchAlarm
    );
    const driver = new AlarmDriver({
      workspaceId: "ws-1",
      doDispatch: harness.doDispatch,
      workerId: "driver-1",
      concurrency: 2,
    });

    driver.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["slow"]);

    harness.alarms.push({
      source: "workers/poller",
      className: "PollerDO",
      objectKey: "fast",
      wakeAt: 0,
      dispatchGeneration: 0,
      dispatchOwner: null,
      dispatchExpiresAt: null,
    });
    driver.notifyChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["slow", "fast"]);

    releaseSlow();
    await vi.advanceTimersByTimeAsync(0);
    driver.stop();
  });

  it("does not poll WorkspaceDO while all lanes are occupied", async () => {
    const held = new Promise<never>(() => {});
    const dispatchAlarm = vi.fn(async () => held);
    const harness = makeHarness(
      [{ source: "workers/poller", className: "PollerDO", objectKey: "held", wakeAt: 0 }],
      dispatchAlarm
    );
    const driver = new AlarmDriver({
      workspaceId: "ws-1",
      doDispatch: harness.doDispatch,
      workerId: "driver-1",
      concurrency: 1,
    });

    driver.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dispatchAlarm).toHaveBeenCalledOnce();
    expect(harness.workspaceCalls.filter((method) => method === "alarmClaimDue")).toHaveLength(1);
    expect(
      harness.workspaceCalls.filter((method) => method === "alarmNextWakeAt").length
    ).toBeLessThan(4);
    driver.stop();
  });

  it("does not spin regardless of how long an active target runs", async () => {
    const held = new Promise<never>(() => {});
    const harness = makeHarness(
      [{ source: "workers/poller", className: "PollerDO", objectKey: "held", wakeAt: 0 }],
      vi.fn(async () => held)
    );
    const driver = new AlarmDriver({
      workspaceId: "ws-1",
      doDispatch: harness.doDispatch,
      workerId: "driver-1",
      concurrency: 2,
    });

    driver.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.workspaceCalls.filter((method) => method === "alarmClaimDue")).toHaveLength(1);
    expect(
      harness.workspaceCalls.filter((method) => method === "alarmNextWakeAt").length
    ).toBeLessThan(4);
    driver.stop();
  });

  it("never overlaps a target whose wake is replaced during its active lane", async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let active = 0;
    let maxActive = 0;
    const dispatchAlarm = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        if (dispatchAlarm.mock.calls.length === 1) await first;
      } finally {
        active--;
      }
      return { nextAlarm: null };
    });
    const due = { source: "workers/poller", className: "PollerDO", objectKey: "same", wakeAt: 0 };
    const harness = makeHarness([due], dispatchAlarm);
    const driver = new AlarmDriver({
      workspaceId: "ws-1",
      doDispatch: harness.doDispatch,
      workerId: "driver-1",
      concurrency: 2,
    });

    driver.start();
    await vi.advanceTimersByTimeAsync(0);
    await harness.dispatch({} as DORef, "alarmSet", { ...due, wakeAt: 10 });
    driver.notifyChanged();
    await vi.advanceTimersByTimeAsync(10);
    expect(dispatchAlarm).toHaveBeenCalledOnce();

    releaseFirst();
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatchAlarm).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
    driver.stop();
  });

  it("durably defers an authority-paused target without occupying a lane", async () => {
    vi.setSystemTime(10_000);
    const due = {
      source: "workers/agent-worker",
      className: "AiChatWorker",
      objectKey: "agent-1",
      wakeAt: 10_000,
    };
    const dispatchAlarm = vi.fn(async () => ({ nextAlarm: null }));
    const harness = makeHarness([due], dispatchAlarm);
    const driver = new AlarmDriver({
      workspaceId: "ws-1",
      doDispatch: harness.doDispatch,
      workerId: "driver-1",
      isAuthorityPaused: () => true,
    });

    driver.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatchAlarm).not.toHaveBeenCalled();
    expect(harness.alarms).toMatchObject([
      { objectKey: "agent-1", wakeAt: 70_000, dispatchOwner: null },
    ]);
    driver.stop();
  });

  it("recovers an acknowledgement failure only after a new driver generation adopts it", async () => {
    const dispatchAlarm = vi.fn(async () => ({ nextAlarm: null }));
    const harness = makeHarness(
      [{ source: "workers/poller", className: "PollerDO", objectKey: "p-1", wakeAt: 0 }],
      dispatchAlarm
    );
    const originalDispatch = harness.dispatch.getMockImplementation()!;
    let clearAttempts = 0;
    harness.dispatch.mockImplementation(async (ref: DORef, method: string, ...args: unknown[]) => {
      if (method === "alarmClear" && ++clearAttempts === 1) {
        throw new TypeError("workspace acknowledgement unavailable");
      }
      return originalDispatch(ref, method, ...args);
    });
    const driver = new AlarmDriver({
      workspaceId: "ws-1",
      doDispatch: harness.doDispatch,
      workerId: "driver-1",
    });

    driver.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatchAlarm).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(dispatchAlarm).toHaveBeenCalledOnce();
    driver.stop();

    const replacement = new AlarmDriver({
      workspaceId: "ws-1",
      doDispatch: harness.doDispatch,
      workerId: "driver-2",
    });
    replacement.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatchAlarm).toHaveBeenCalledTimes(2);
    replacement.stop();
  });

  it("quiesce aborts and waits for scheduler-owned transports without acknowledging", async () => {
    let signal: AbortSignal | undefined;
    const dispatchAlarm = vi.fn(
      async (_ref: DORef, inputSignal?: AbortSignal): Promise<{ nextAlarm: null }> => {
        signal = inputSignal;
        return await new Promise<{ nextAlarm: null }>((_resolve, reject) => {
          inputSignal?.addEventListener("abort", () => reject(inputSignal.reason), { once: true });
        });
      }
    );
    const harness = makeHarness(
      [{ source: "workers/poller", className: "PollerDO", objectKey: "p-1", wakeAt: 0 }],
      dispatchAlarm
    );
    const driver = new AlarmDriver({
      workspaceId: "ws-1",
      doDispatch: harness.doDispatch,
      workerId: "driver-1",
    });

    driver.start();
    await vi.advanceTimersByTimeAsync(0);
    await driver.quiesce();
    expect(signal?.aborted).toBe(true);
    expect(harness.alarms).toHaveLength(1);
    expect(harness.alarms[0]).toMatchObject({ dispatchOwner: "driver-1", dispatchGeneration: 1 });
  });
});
