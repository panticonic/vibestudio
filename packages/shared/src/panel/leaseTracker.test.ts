import { describe, expect, it } from "vitest";
import type {
  PanelRuntimeLease,
  PanelRuntimeLeaseChangedEvent,
  RuntimeLeaseSnapshot,
} from "./panelLease.js";
import { classifyRuntimeLeaseChange, LeaseTracker } from "./leaseTracker.js";
import { asPanelEntityId, asPanelSlotId, type PanelSlotId } from "./ids.js";

const ME = "headless-test";
const A = asPanelSlotId("panel:tree/a");
const B = asPanelSlotId("panel:tree/b");

function slotName(slotId: PanelSlotId): string {
  return slotId.slice("panel:tree/".length);
}

function lease(slotId: PanelSlotId, overrides: Partial<PanelRuntimeLease> = {}): PanelRuntimeLease {
  const name = slotName(slotId);
  const base: PanelRuntimeLease = {
    slotId,
    runtimeEntityId: asPanelEntityId(`panel:nav-${name}`),
    clientSessionId: ME,
    hostConnectionId: ME,
    connectionId: `default-cdp-${name}-1`,
    holderLabel: "Headless",
    platform: "headless",
    supportsCdp: true,
    loadOnLeaseAssignment: true,
    acquiredAt: 1,
  };
  return { ...base, ...overrides };
}

function snapshot(leases: PanelRuntimeLease[], counter = 1): RuntimeLeaseSnapshot {
  return { version: { epoch: "e1", counter }, leases };
}

function event(
  slotId: PanelSlotId,
  next: PanelRuntimeLease | null,
  previous: PanelRuntimeLease | null,
  counter: number
): PanelRuntimeLeaseChangedEvent {
  return {
    type: "panel:runtimeLeaseChanged",
    version: { epoch: "e1", counter },
    slotId,
    runtimeEntityId: (next ?? previous)!.runtimeEntityId,
    previous,
    next,
    reason: next ? "acquired" : "released",
  };
}

describe("LeaseTracker", () => {
  it("reconciles a snapshot into load intents for own leases only", () => {
    const tracker = new LeaseTracker(ME);
    const intents = tracker.reconcile(
      snapshot([lease(A), lease(B, { clientSessionId: "someone-else" })])
    );
    expect(intents).toEqual([
      {
        kind: "load",
        slotId: A,
        runtimeEntityId: "panel:nav-a",
        connectionId: "default-cdp-a-1",
      },
    ]);
    expect(tracker.heldSlots()).toEqual([A]);
  });

  it("unloads leases that vanish from a later snapshot", () => {
    const tracker = new LeaseTracker(ME);
    tracker.reconcile(snapshot([lease(A)]));
    const intents = tracker.reconcile(snapshot([], 2));
    expect(intents).toEqual([{ kind: "unload", slotId: A, reason: "lease-transfer" }]);
  });

  it("treats a connectionId change as unload + reload", () => {
    const tracker = new LeaseTracker(ME);
    tracker.reconcile(snapshot([lease(A)]));
    const intents = tracker.reconcile(
      snapshot([lease(A, { connectionId: "default-cdp-a-2" })], 2)
    );
    expect(intents).toEqual([
      { kind: "unload", slotId: A, reason: "stale" },
      {
        kind: "load",
        slotId: A,
        runtimeEntityId: "panel:nav-a",
        connectionId: "default-cdp-a-2",
      },
    ]);
  });

  it("applies acquire/transfer/release events", () => {
    const tracker = new LeaseTracker(ME);
    expect(tracker.apply(event(A, lease(A), null, 1))).toEqual([
      {
        kind: "load",
        slotId: A,
        runtimeEntityId: "panel:nav-a",
        connectionId: "default-cdp-a-1",
      },
    ]);
    expect(
      tracker.apply(event(A, lease(A, { clientSessionId: "desktop-1" }), lease(A), 2))
    ).toEqual([{ kind: "unload", slotId: A, reason: "lease-transfer" }]);
    expect(
      tracker.apply(event(A, null, lease(A, { clientSessionId: "desktop-1" }), 3))
    ).toEqual([]);
  });

  it("drops stale events older than the reconciled version", () => {
    const tracker = new LeaseTracker(ME);
    tracker.reconcile(snapshot([lease(A)], 10));
    expect(tracker.apply(event(A, null, lease(A), 5))).toEqual([]);
    expect(tracker.heldSlots()).toEqual([A]);
  });

  it("accepts events from a new epoch regardless of counter", () => {
    const tracker = new LeaseTracker(ME);
    tracker.reconcile(snapshot([lease(A)], 10));
    const fresh = {
      ...event(A, null, lease(A), 1),
      version: { epoch: "e2", counter: 1 },
    };
    expect(tracker.apply(fresh)).toEqual([{ kind: "unload", slotId: A, reason: "released" }]);
  });

  it("ignores duplicate acquires for the same connectionId", () => {
    const tracker = new LeaseTracker(ME);
    tracker.apply(event(A, lease(A), null, 1));
    expect(tracker.apply(event(A, lease(A), null, 2))).toEqual([]);
  });

  it("never unloads a keepLoaded lease that vanishes from a later snapshot", () => {
    const tracker = new LeaseTracker(ME);
    tracker.reconcile(snapshot([lease(A, { keepLoaded: true })]));
    expect(tracker.reconcile(snapshot([], 2))).toEqual([]);
    expect(tracker.heldSlots()).toEqual([A]);
    expect(tracker.heldLease(A)?.keepLoaded).toBe(true);
  });

  it("never unloads a keepLoaded lease on a release/transfer event", () => {
    const tracker = new LeaseTracker(ME);
    tracker.apply(event(A, lease(A, { keepLoaded: true }), null, 1));
    // Release event for a pinned lease is refused.
    expect(tracker.apply(event(A, null, lease(A, { keepLoaded: true }), 2))).toEqual([]);
    // Transfer to another client is also refused while pinned.
    expect(
      tracker.apply(
        event(A, lease(A, { clientSessionId: "desktop-1", keepLoaded: true }), lease(A), 3)
      )
    ).toEqual([]);
    expect(tracker.heldSlots()).toEqual([A]);
  });

  it("tracks keepLoaded toggles without emitting load/unload", () => {
    const tracker = new LeaseTracker(ME);
    tracker.reconcile(snapshot([lease(A)]));
    expect(tracker.heldLease(A)?.keepLoaded).toBe(false);
    // Pin applied (same connectionId) → no intents, flag updates locally.
    expect(tracker.reconcile(snapshot([lease(A, { keepLoaded: true })], 2))).toEqual([]);
    expect(tracker.heldLease(A)?.keepLoaded).toBe(true);
    // Unpin applied via event → still no intents.
    expect(tracker.apply(event(A, lease(A), lease(A, { keepLoaded: true }), 3))).toEqual([]);
    expect(tracker.heldLease(A)?.keepLoaded).toBe(false);
  });
});

describe("classifyRuntimeLeaseChange", () => {
  it("classifies ownership transitions without mutating tracker state", () => {
    expect(classifyRuntimeLeaseChange(ME, event(A, lease(A), null, 1))).toMatchObject({
      kind: "assigned",
      lease: expect.objectContaining({ slotId: A }),
    });
    expect(
      classifyRuntimeLeaseChange(
        ME,
        event(A, lease(A, { clientSessionId: "desktop" }), lease(A), 2)
      )
    ).toMatchObject({ kind: "unassigned", reason: "lease-transfer", slotId: A });
    expect(
      classifyRuntimeLeaseChange(
        ME,
        event(A, null, lease(A, { clientSessionId: "desktop" }), 3)
      )
    ).toEqual({ kind: "unrelated" });
  });
});
