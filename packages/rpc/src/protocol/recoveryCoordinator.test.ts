import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("retries a throwing handler up to 3 times, then gives up without throwing", async () => {
    vi.useFakeTimers();
    const coord = createRecoveryCoordinator();
    let attempts = 0;
    coord.registerResubscribeHandler("flaky", () => {
      attempts++;
      throw new Error("boom");
    });
    const run = coord.run("resubscribe");
    // Backoff between attempts: 250ms, then 500ms (capped at 1000ms).
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(run).resolves.toBeUndefined(); // exhausting attempts never rejects
    expect(attempts).toBe(3);
  });

  it("stops retrying as soon as a handler succeeds", async () => {
    vi.useFakeTimers();
    const coord = createRecoveryCoordinator();
    let attempts = 0;
    coord.registerResubscribeHandler("recovers", () => {
      attempts++;
      if (attempts < 2) throw new Error("transient");
    });
    const run = coord.run("resubscribe");
    await vi.advanceTimersByTimeAsync(2_000);
    await run;
    expect(attempts).toBe(2); // succeeded on the 2nd attempt, no 3rd
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
