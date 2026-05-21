import { randomUUID } from "crypto";
import type { EventService } from "@natstack/shared/eventsService";
import type {
  ClientSession,
  PanelRuntimeAcquireResult,
  PanelRuntimeLease,
  PanelRuntimeLeaseChangedReason,
  RuntimeLeaseSnapshot,
  RuntimeLeaseVersion,
} from "@natstack/shared/panel/panelLease";
import { asPanelEntityId, asPanelSlotId } from "@natstack/shared/panel/ids";
import type { PanelEntityId, PanelSlotId } from "@natstack/shared/panel/ids";

const LEASE_RECONNECT_GRACE_MS = 3000;

export type RuntimeLeaseClose = (
  runtimeEntityId: string,
  connectionId: string,
  code: number,
  reason: string
) => void;

export class PanelRuntimeCoordinator {
  private readonly epoch = randomUUID();
  private counter = 0;
  private leases = new Map<PanelEntityId, PanelRuntimeLease>();
  private clients = new Map<string, ClientSession>();
  private expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private closeConnection: RuntimeLeaseClose | null = null;

  constructor(private readonly deps: { eventService?: EventService } = {}) {}

  setCloseConnection(fn: RuntimeLeaseClose): void {
    this.closeConnection = fn;
  }

  registerClient(input: {
    clientSessionId: string;
    label: string;
    platform: "desktop" | "mobile";
  }): void {
    const now = Date.now();
    const existing = this.clients.get(input.clientSessionId);
    this.clients.set(input.clientSessionId, {
      clientSessionId: input.clientSessionId,
      label: input.label,
      platform: input.platform,
      connectedAt: existing?.connectedAt ?? now,
      lastSeenAt: now,
    });
  }

  getSnapshot(): RuntimeLeaseSnapshot {
    return {
      version: this.currentVersion(),
      leases: [...this.leases.values()],
    };
  }

  getLease(runtimeEntityId: string): PanelRuntimeLease | null {
    return this.leases.get(asPanelEntityId(runtimeEntityId)) ?? null;
  }

  acquire(
    runtimeEntityId: string,
    input: { slotId: string; clientSessionId: string; connectionId: string }
  ): PanelRuntimeAcquireResult {
    const entityId = asPanelEntityId(runtimeEntityId);
    const existing = this.leases.get(entityId);
    if (
      existing &&
      existing.connectionId !== input.connectionId &&
      existing.clientSessionId !== input.clientSessionId
    ) {
      return { acquired: false, lease: existing };
    }
    return { acquired: true, lease: this.writeLease(entityId, input, "acquired") };
  }

  takeOver(
    runtimeEntityId: string,
    input: { slotId: string; clientSessionId: string; connectionId: string }
  ): PanelRuntimeAcquireResult {
    const entityId = asPanelEntityId(runtimeEntityId);
    const existing = this.leases.get(entityId);
    if (existing && existing.connectionId !== input.connectionId) {
      this.closeConnection?.(
        runtimeEntityId,
        existing.connectionId,
        4091,
        "Panel runtime lease revoked"
      );
      this.emitChange(entityId, existing.slotId, existing, null, "revoked");
    }
    return { acquired: true, lease: this.writeLease(entityId, input, "acquired") };
  }

  release(
    runtimeEntityId: string,
    connectionId: string,
    reason: PanelRuntimeLeaseChangedReason = "released"
  ): void {
    const entityId = asPanelEntityId(runtimeEntityId);
    const existing = this.leases.get(entityId);
    if (!existing || existing.connectionId !== connectionId) return;
    this.clearExpiry(entityId);
    this.leases.delete(entityId);
    this.emitChange(entityId, existing.slotId, existing, null, reason);
  }

  retireRuntimeEntity(runtimeEntityId: string): void {
    const entityId = asPanelEntityId(runtimeEntityId);
    const existing = this.leases.get(entityId);
    if (!existing) return;
    this.clearExpiry(entityId);
    this.leases.delete(entityId);
    this.closeConnection?.(
      runtimeEntityId,
      existing.connectionId,
      4093,
      "Panel runtime entity retired"
    );
    this.emitChange(entityId, existing.slotId, existing, null, "retired");
  }

  authorizePanelConnection(
    runtimeEntityId: string,
    connectionId: string
  ): { ok: true } | { ok: false; reason: string } {
    const lease = this.leases.get(asPanelEntityId(runtimeEntityId));
    if (!lease) return { ok: false, reason: "Panel runtime has no active lease" };
    if (lease.connectionId !== connectionId) {
      return { ok: false, reason: `Panel runtime is leased by ${lease.holderLabel}` };
    }
    return { ok: true };
  }

  markConnected(runtimeEntityId: string, connectionId: string): void {
    const entityId = asPanelEntityId(runtimeEntityId);
    const lease = this.leases.get(entityId);
    if (!lease || lease.connectionId !== connectionId) return;
    this.clearExpiry(entityId);
    if (lease.expiresAt !== undefined) {
      const next = { ...lease };
      delete next.expiresAt;
      this.leases.set(entityId, next);
      this.emitChange(entityId, lease.slotId, lease, next, "acquired");
    }
  }

  markDisconnected(runtimeEntityId: string, connectionId: string): void {
    const entityId = asPanelEntityId(runtimeEntityId);
    const lease = this.leases.get(entityId);
    if (!lease || lease.connectionId !== connectionId) return;
    this.clearExpiry(entityId);
    const expiresAt = Date.now() + LEASE_RECONNECT_GRACE_MS;
    const next = { ...lease, expiresAt };
    this.leases.set(entityId, next);
    this.emitChange(entityId, lease.slotId, lease, next, "released");
    this.expiryTimers.set(
      entityId,
      setTimeout(() => {
        this.release(runtimeEntityId, connectionId, "expired");
      }, LEASE_RECONNECT_GRACE_MS)
    );
  }

  resolveRouteConnection(runtimeEntityId: string): string | null {
    return this.leases.get(asPanelEntityId(runtimeEntityId))?.connectionId ?? null;
  }

  private writeLease(
    runtimeEntityId: PanelEntityId,
    input: { slotId: string; clientSessionId: string; connectionId: string },
    reason: PanelRuntimeLeaseChangedReason
  ): PanelRuntimeLease {
    const client = this.clients.get(input.clientSessionId);
    if (!client) {
      throw new Error(`Unknown runtime client session: ${input.clientSessionId}`);
    }
    const slotId = asPanelSlotId(input.slotId);
    const previous = this.leases.get(runtimeEntityId) ?? null;
    this.clearExpiry(runtimeEntityId);
    const lease: PanelRuntimeLease = {
      slotId,
      runtimeEntityId,
      clientSessionId: input.clientSessionId,
      connectionId: input.connectionId,
      holderLabel: client.label,
      platform: client.platform,
      acquiredAt: Date.now(),
    };
    this.leases.set(runtimeEntityId, lease);
    this.emitChange(runtimeEntityId, slotId, previous, lease, reason);
    return lease;
  }

  private clearExpiry(runtimeEntityId: PanelEntityId): void {
    const timer = this.expiryTimers.get(runtimeEntityId);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(runtimeEntityId);
  }

  private currentVersion(): RuntimeLeaseVersion {
    return { epoch: this.epoch, counter: this.counter };
  }

  private nextVersion(): RuntimeLeaseVersion {
    this.counter += 1;
    return this.currentVersion();
  }

  private emitChange(
    runtimeEntityId: PanelEntityId,
    slotId: PanelSlotId,
    previous: PanelRuntimeLease | null,
    next: PanelRuntimeLease | null,
    reason: PanelRuntimeLeaseChangedReason
  ): void {
    this.deps.eventService?.emit("panel:runtimeLeaseChanged", {
      type: "panel:runtimeLeaseChanged",
      version: this.nextVersion(),
      slotId,
      runtimeEntityId,
      previous,
      next,
      reason,
    });
  }
}
