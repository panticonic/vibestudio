import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteRpcError } from "../errors.js";
import { createRecoveryCoordinator } from "./recoveryCoordinator.js";

afterEach(() => {
  vi.useRealTimers();
});

const flush = async (turns = 5): Promise<void> => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
};

describe("DefaultRecoveryCoordinator", () => {
  it("runs registered handlers for the matching kind, in registration order", async () => {
    const coord = createRecoveryCoordinator();
    const order: string[] = [];
    coord.registerResubscribeHandler("a", () => void order.push("a"));
    coord.registerResubscribeHandler("b", () => void order.push("b"));
    coord.registerColdRecoverHandler("c", () => void order.push("c"));

    await coord.run("resubscribe");
    expect(order).toEqual(["a", "b"]); // cold-recover 'c' not fired

    await coord.run("cold-recover");
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("serializes overlapping runs (one queue, never concurrent)", async () => {
    const coord = createRecoveryCoordinator();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    let calls = 0;
    coord.registerResubscribeHandler("h", async () => {
      calls++;
      events.push(`start-${calls}`);
      if (calls === 1) await firstGate;
      events.push(`end-${calls}`);
    });

    const runA = coord.run("resubscribe");
    const runB = coord.run("resubscribe");
    await flush();
    // The second run must NOT start until the first completes.
    expect(events).toEqual(["start-1"]);
    releaseFirst();
    await Promise.all([runA, runB]);
    expect(events).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });

  it("propagates the original handler failure and does not retry on elapsed time", async () => {
    vi.useFakeTimers();
    const coord = createRecoveryCoordinator();
    const failure = new Error("boom");
    const failed = vi.fn(() => {
      throw failure;
    });
    const following = vi.fn();
    coord.registerResubscribeHandler("failed", failed);
    coord.registerResubscribeHandler("following", following);
    await expect(coord.run("resubscribe")).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(following).not.toHaveBeenCalled();
  });

  it("allows the next explicit recovery generation after the original failure", async () => {
    const coord = createRecoveryCoordinator();
    const failure = new Error("transient");
    let attempts = 0;
    coord.registerResubscribeHandler("recovers", () => {
      attempts++;
      if (attempts === 1) throw failure;
    });
    await expect(coord.run("resubscribe")).rejects.toBe(failure);
    expect(attempts).toBe(1);
    await expect(coord.run("resubscribe")).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it("defers an interrupted generation until the host signals recovery again", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const coord = createRecoveryCoordinator();
    let offline = true;
    const cause = new RemoteRpcError("offline", "transport", "CONNECTION_LOST");
    const failure = Object.assign(new Error("subscription unavailable"), {
      code: "connection",
      errorCode: "CONNECTION_LOST",
      cause,
    });
    const subscription = vi.fn(() => {
      if (offline) throw failure;
    });
    coord.registerResubscribeHandler("subscription", subscription);
    const following = vi.fn();
    coord.registerResubscribeHandler("following", following);
    await expect(coord.run("resubscribe")).rejects.toBe(failure);
    const late = vi.fn();
    coord.registerResubscribeHandler("late", late);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(subscription).toHaveBeenCalledTimes(1);
    expect(following).not.toHaveBeenCalled();
    expect(late).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();

    offline = false;
    await coord.run("resubscribe");
    expect(subscription).toHaveBeenCalledTimes(2);
    expect(following).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("late-registers a resubscribe handler AFTER a completed generation and runs it immediately", async () => {
    const coord = createRecoveryCoordinator();
    await coord.run("resubscribe"); // completes generation 1 with no handlers
    const ran: string[] = [];
    coord.registerResubscribeHandler("late", () => void ran.push("late"));
    await flush();
    // Registering into an already-completed generation self-fires (bootstrap).
    expect(ran).toEqual(["late"]);
  });

  it("lets self-bootstrapped resources observe only future resubscribe generations", async () => {
    const coord = createRecoveryCoordinator();
    await coord.run("resubscribe");
    const ran: string[] = [];
    coord.registerResubscribeHandler("self-bootstrapped", () => void ran.push("run"), {
      includeCurrentGeneration: false,
    });
    await flush();
    expect(ran).toEqual([]);

    await coord.run("resubscribe");
    expect(ran).toEqual(["run"]);
  });

  it("does NOT auto-fire a cold-recover handler registered after a run", async () => {
    const coord = createRecoveryCoordinator();
    await coord.run("cold-recover");
    const ran: string[] = [];
    coord.registerColdRecoverHandler("late", () => void ran.push("late"));
    await flush();
    expect(ran).toEqual([]); // only resubscribe bootstraps late registrations
  });

  it("an unregistered handler no longer runs", async () => {
    const coord = createRecoveryCoordinator();
    const ran: string[] = [];
    const off = coord.registerResubscribeHandler("x", () => void ran.push("x"));
    off();
    await coord.run("resubscribe");
    expect(ran).toEqual([]);
  });

  it("skips a handler that was replaced (same name) mid-run", async () => {
    const coord = createRecoveryCoordinator();
    const ran: string[] = [];
    let gate!: () => void;
    const wait = new Promise<void>((r) => (gate = r));
    coord.registerResubscribeHandler("first", () => void ran.push("first-A"));
    coord.registerResubscribeHandler("slow", async () => {
      ran.push("slow-start");
      await wait;
    });
    const run = coord.run("resubscribe");
    await flush();
    expect(ran).toEqual(["first-A", "slow-start"]);
    // Replace "first" while the run is parked on "slow" (generation in flight,
    // not yet completed → no bootstrap).
    coord.registerResubscribeHandler("first", () => void ran.push("first-B"));
    gate();
    await run;
    await flush();
    // The replacement did NOT run in this generation (registered mid-run, and the
    // snapshot had already passed "first"); it fires on the NEXT run.
    expect(ran).toEqual(["first-A", "slow-start"]);
    await coord.run("resubscribe");
    expect(ran).toContain("first-B");
  });
});
