/**
 * Host-neutral runtime lease state machine. It converts server lease snapshots
 * and lease-change events into load/unload intents for one panel host.
 */
import type {
  PanelRuntimeLease,
  PanelRuntimeLeaseChangedEvent,
  RuntimeLeaseSnapshot,
  RuntimeLeaseVersion,
} from "./panelLease.js";
import type { PanelEntityId, PanelSlotId } from "./ids.js";

export type LeaseIntent =
  | {
      kind: "load";
      slotId: PanelSlotId;
      runtimeEntityId: PanelEntityId;
      connectionId: string;
    }
  | {
      kind: "unload";
      slotId: PanelSlotId;
      reason: "lease-transfer" | "released" | "stale";
    };

export type RuntimeLeaseChangeDisposition =
  | { kind: "assigned"; lease: PanelRuntimeLease }
  | {
      kind: "unassigned";
      slotId: PanelSlotId;
      reason: "lease-transfer" | "released";
      previous: PanelRuntimeLease;
    }
  | { kind: "unrelated" };

interface HeldLease {
  runtimeEntityId: PanelEntityId;
  connectionId: string;
}

function versionNewer(a: RuntimeLeaseVersion, b: RuntimeLeaseVersion | null): boolean {
  if (!b) return true;
  if (a.epoch !== b.epoch) return true;
  return a.counter > b.counter;
}

export function classifyRuntimeLeaseChange(
  clientSessionId: string,
  event: PanelRuntimeLeaseChangedEvent
): RuntimeLeaseChangeDisposition {
  if (event.next?.clientSessionId === clientSessionId) {
    return { kind: "assigned", lease: event.next };
  }
  if (event.previous?.clientSessionId === clientSessionId) {
    return {
      kind: "unassigned",
      slotId: event.slotId,
      reason: event.next ? "lease-transfer" : "released",
      previous: event.previous,
    };
  }
  return { kind: "unrelated" };
}

export class LeaseTracker {
  private readonly held = new Map<PanelSlotId, HeldLease>();
  private version: RuntimeLeaseVersion | null = null;

  constructor(private readonly clientSessionId: string) {}

  heldSlots(): PanelSlotId[] {
    return [...this.held.keys()];
  }

  heldLease(slotId: PanelSlotId): HeldLease | undefined {
    return this.held.get(slotId);
  }

  reconcile(snapshot: RuntimeLeaseSnapshot): LeaseIntent[] {
    this.version = snapshot.version;
    const intents: LeaseIntent[] = [];
    const mine = new Map<PanelSlotId, PanelRuntimeLease>();
    for (const lease of snapshot.leases) {
      if (lease.clientSessionId === this.clientSessionId) mine.set(lease.slotId, lease);
    }
    for (const [slotId, current] of this.held) {
      const next = mine.get(slotId);
      if (!next) {
        this.held.delete(slotId);
        intents.push({ kind: "unload", slotId, reason: "lease-transfer" });
      } else if (next.connectionId !== current.connectionId) {
        this.held.set(slotId, {
          runtimeEntityId: next.runtimeEntityId,
          connectionId: next.connectionId,
        });
        intents.push({ kind: "unload", slotId, reason: "stale" });
        intents.push({
          kind: "load",
          slotId,
          runtimeEntityId: next.runtimeEntityId,
          connectionId: next.connectionId,
        });
      }
    }
    for (const [slotId, lease] of mine) {
      if (!this.held.has(slotId)) {
        this.held.set(slotId, {
          runtimeEntityId: lease.runtimeEntityId,
          connectionId: lease.connectionId,
        });
        intents.push({
          kind: "load",
          slotId,
          runtimeEntityId: lease.runtimeEntityId,
          connectionId: lease.connectionId,
        });
      }
    }
    return intents;
  }

  apply(event: PanelRuntimeLeaseChangedEvent): LeaseIntent[] {
    if (!versionNewer(event.version, this.version)) return [];
    this.version = event.version;
    const disposition = classifyRuntimeLeaseChange(this.clientSessionId, event);
    const slotId = event.slotId;
    const current = this.held.get(slotId);

    if (disposition.kind === "assigned") {
      const { lease } = disposition;
      if (!current) {
        this.held.set(slotId, {
          runtimeEntityId: lease.runtimeEntityId,
          connectionId: lease.connectionId,
        });
        return [
          {
            kind: "load",
            slotId,
            runtimeEntityId: lease.runtimeEntityId,
            connectionId: lease.connectionId,
          },
        ];
      }
      if (current.connectionId !== lease.connectionId) {
        this.held.set(slotId, {
          runtimeEntityId: lease.runtimeEntityId,
          connectionId: lease.connectionId,
        });
        return [
          { kind: "unload", slotId, reason: "stale" },
          {
            kind: "load",
            slotId,
            runtimeEntityId: lease.runtimeEntityId,
            connectionId: lease.connectionId,
          },
        ];
      }
      return [];
    }

    if (current && disposition.kind === "unassigned") {
      this.held.delete(slotId);
      return [{ kind: "unload", slotId, reason: disposition.reason }];
    }
    return [];
  }

  drop(slotId: PanelSlotId): void {
    this.held.delete(slotId);
  }
}
