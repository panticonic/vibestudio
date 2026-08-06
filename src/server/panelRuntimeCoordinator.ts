import { randomUUID } from "crypto";
import type { EventService } from "@vibestudio/shared/eventsService";
import type {
  ClientSession,
  PanelHostRegistration,
  PanelRuntimeAcquireResult,
  PanelRuntimeLease,
  PanelRuntimeLeaseChangedEvent,
  PanelRuntimeLeaseChangedReason,
  RuntimeLeaseSnapshot,
  RuntimeLeaseVersion,
} from "@vibestudio/shared/panel/panelLease";
import {
  asPanelEntityId,
  asPanelSlotId,
  isPanelEntityId,
  isPanelSlotId,
} from "@vibestudio/shared/panel/ids";
import type { PanelEntityId, PanelSlotId } from "@vibestudio/shared/panel/ids";
import type {
  PanelBootObservation,
  PanelPageObservation,
} from "@vibestudio/shared/panel/observation";

const LEASE_RECONNECT_GRACE_MS = 3000;

function samePageObservation(
  previous: PanelPageObservation | undefined,
  next: { url: string; loading: boolean; boot: PanelBootObservation }
): boolean {
  if (!previous) return false;
  return (
    previous.view.url === next.url &&
    previous.view.loading === next.loading &&
    previous.boot.phase === next.boot.phase &&
    previous.boot.runtimeEntityId === next.boot.runtimeEntityId &&
    previous.boot.source === next.boot.source &&
    previous.boot.contextId === next.boot.contextId &&
    previous.boot.effectiveVersion === next.boot.effectiveVersion &&
    previous.boot.buildKey === next.boot.buildKey &&
    previous.boot.message === next.boot.message &&
    previous.boot.errorName === next.boot.errorName &&
    previous.boot.stack === next.boot.stack
  );
}

type DefaultCdpHostOptions = {
  isHostAvailable?: (hostConnectionId: string) => boolean;
  replaceUnavailableLease?: boolean;
  /** A host that deliberately relinquished this residency is not an
   *  immediate candidate for the replacement lease. */
  excludedHostConnectionId?: string;
};

export type RuntimeLeaseClose = (
  runtimeEntityId: string,
  connectionId: string,
  code: number,
  reason: string
) => void;

export class PanelRuntimeCoordinator {
  private readonly epoch = randomUUID();
  private counter = 0;
  private slotObservationCounters = new Map<PanelSlotId, number>();
  private leases = new Map<PanelEntityId, PanelRuntimeLease>();
  private clients = new Map<string, ClientSession>();
  private expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private defaultCdpLeaseConnections = new Set<string>();
  private reportedViews = new Map<
    PanelEntityId,
    { connectionId: string; observation: PanelPageObservation }
  >();
  /**
   * Slots that must stay loaded on their serving host (≥1 CDP client attached).
   * Leases for a pinned slot carry `keepLoaded: true` and are refused for
   * release/unload/expiry so mid-automation operations can't yank the page.
   */
  private keptLoadedSlots = new Set<PanelSlotId>();
  private closeConnection: RuntimeLeaseClose | null = null;
  private leaseChangeListeners = new Set<(event: PanelRuntimeLeaseChangedEvent) => void>();
  private slotObservationListeners = new Set<(slotId: PanelSlotId) => void>();

  constructor(
    private readonly deps: {
      eventService?: EventService;
      onError?: (error: unknown, operation: string) => void;
    } = {}
  ) {}

  setCloseConnection(fn: RuntimeLeaseClose): void {
    this.closeConnection = fn;
  }

  onLeaseChanged(listener: (event: PanelRuntimeLeaseChangedEvent) => void): () => void {
    this.leaseChangeListeners.add(listener);
    return () => {
      this.leaseChangeListeners.delete(listener);
    };
  }

  /**
   * Subscribe to the canonical observation stream. The coordinator owns both
   * lease and page-observation transitions, so consumers never need to sample
   * a presentation host on a timer.
   */
  onSlotObservationChanged(listener: (slotId: PanelSlotId) => void): () => void {
    this.slotObservationListeners.add(listener);
    return () => this.slotObservationListeners.delete(listener);
  }

  observationVersion(slotId: string): RuntimeLeaseVersion {
    const normalizedSlotId = asPanelSlotId(slotId);
    return {
      epoch: this.epoch,
      counter: this.slotObservationCounters.get(normalizedSlotId) ?? 0,
    };
  }

  /**
   * Pin a slot loaded while a CDP client is connected. Re-stamps any existing
   * lease(s) for the slot with `keepLoaded: true` and emits a lease change so
   * the serving host's tracker keeps the panel loaded (and skips eviction).
   */
  pinSlotLoaded(slotId: string): void {
    const normalizedSlotId = asPanelSlotId(slotId);
    if (this.keptLoadedSlots.has(normalizedSlotId)) return;
    this.keptLoadedSlots.add(normalizedSlotId);
    this.restampSlotKeepLoaded(normalizedSlotId, true);
  }

  /** Release the keep-loaded pin; normal unload/eviction resumes for the slot. */
  unpinSlotLoaded(slotId: string): void {
    const normalizedSlotId = asPanelSlotId(slotId);
    if (!this.keptLoadedSlots.delete(normalizedSlotId)) return;
    this.restampSlotKeepLoaded(normalizedSlotId, false);
  }

  private restampSlotKeepLoaded(slotId: PanelSlotId, keepLoaded: boolean): void {
    for (const [entityId, lease] of this.leases) {
      if (lease.slotId !== slotId) continue;
      if ((lease.keepLoaded ?? false) === keepLoaded) continue;
      const next: PanelRuntimeLease = { ...lease, keepLoaded };
      this.leases.set(entityId, next);
      this.emitChange(entityId, slotId, lease, next, "acquired");
    }
  }

  registerClient(input: PanelHostRegistration): void {
    const now = Date.now();
    const existing = this.clients.get(input.clientSessionId);
    this.clients.set(input.clientSessionId, {
      clientSessionId: input.clientSessionId,
      hostConnectionId:
        input.hostConnectionId ?? existing?.hostConnectionId ?? input.clientSessionId,
      ownerCallerId: input.ownerCallerId ?? existing?.ownerCallerId,
      label: input.label,
      platform: input.platform,
      supportsCdp: input.supportsCdp ?? input.platform !== "mobile",
      loadOnLeaseAssignment: input.loadOnLeaseAssignment ?? false,
      connectedAt: existing?.connectedAt ?? now,
      lastSeenAt: now,
    });
  }

  unregisterClient(clientSessionId: string): void {
    const client = this.clients.get(clientSessionId);
    if (!client) return;
    this.clients.delete(clientSessionId);

    const released: Array<{
      entityId: PanelEntityId;
      lease: PanelRuntimeLease;
      wasDefaultCdpLease: boolean;
    }> = [];
    for (const [entityId, lease] of this.leases) {
      if (lease.clientSessionId !== clientSessionId) continue;
      this.clearExpiry(entityId);
      this.leases.delete(entityId);
      this.reportedViews.delete(entityId);
      const wasDefaultCdpLease = this.defaultCdpLeaseConnections.delete(lease.connectionId);
      this.closeLeaseConnection(
        lease.runtimeEntityId,
        lease.connectionId,
        4095,
        "Panel runtime host unregistered"
      );
      this.emitChange(entityId, lease.slotId, lease, null, "released");
      released.push({ entityId, lease, wasDefaultCdpLease });
    }

    for (const { entityId, lease, wasDefaultCdpLease } of released) {
      if (this.shouldReassignDefaultCdpLease(lease, wasDefaultCdpLease)) {
        this.assignDefaultCdpHost(entityId, lease.slotId, lease.hostConnectionId);
      }
    }
  }

  getSnapshot(): RuntimeLeaseSnapshot {
    return {
      version: this.currentVersion(),
      leases: [...this.leases.values()],
    };
  }

  getLease(runtimeEntityId: string): PanelRuntimeLease | null {
    // Called with arbitrary caller ids during routing (panels, workers, DOs). The lease map is keyed
    // by panel ENTITY ids, so a non-panel id simply has no panel lease — return null, don't throw.
    if (!isPanelEntityId(runtimeEntityId)) return null;
    return this.leases.get(runtimeEntityId) ?? null;
  }

  hasClientHostConnection(hostConnectionId: string, ownerCallerId?: string): boolean {
    for (const client of this.clients.values()) {
      if (client.hostConnectionId !== hostConnectionId) continue;
      if (ownerCallerId && client.ownerCallerId && client.ownerCallerId !== ownerCallerId) {
        return false;
      }
      return true;
    }
    return false;
  }

  ownsClientSession(clientSessionId: string, ownerCallerId: string): boolean {
    const client = this.clients.get(clientSessionId);
    if (!client) return false;
    return client.ownerCallerId === undefined || client.ownerCallerId === ownerCallerId;
  }

  resolveHostForSlot(slotId: string): { hostConnectionId: string; supportsCdp: boolean } | null {
    const normalizedSlotId = asPanelSlotId(slotId);
    for (const lease of this.leases.values()) {
      if (lease.slotId === normalizedSlotId) {
        return { hostConnectionId: lease.hostConnectionId, supportsCdp: lease.supportsCdp };
      }
    }
    return null;
  }

  reportView(
    runtimeEntityId: string,
    connectionId: string,
    input: { url: string; loading: boolean; boot: PanelBootObservation }
  ): void {
    const entityId = asPanelEntityId(runtimeEntityId);
    const lease = this.leases.get(entityId);
    if (!lease || lease.connectionId !== connectionId) {
      throw new Error(`Panel runtime view report does not match the active lease: ${entityId}`);
    }
    const previous = this.reportedViews.get(entityId);
    if (
      previous?.connectionId === connectionId &&
      samePageObservation(previous.observation, input)
    ) {
      return;
    }
    this.reportedViews.set(entityId, {
      connectionId,
      observation: {
        view: { url: input.url, loading: input.loading },
        boot: { ...input.boot, updatedAt: Date.now() },
      },
    });
    this.nextVersion();
    this.nextSlotObservationVersion(lease.slotId);
    this.emitSlotObservationChanged(lease.slotId);
  }

  reportedViewForSlot(
    slotId: string
  ): { lease: PanelRuntimeLease; observation: PanelPageObservation } | null {
    const normalizedSlotId = asPanelSlotId(slotId);
    for (const [entityId, lease] of this.leases) {
      if (lease.slotId !== normalizedSlotId) continue;
      // A reconnecting client still owns the lease during the short grace
      // period, but its last page sample is no longer evidence about the
      // current connection. Do not expose that sample as live state.
      if (lease.expiresAt !== undefined) return null;
      const reported = this.reportedViews.get(entityId);
      if (!reported || reported.connectionId !== lease.connectionId) return null;
      return { lease, observation: reported.observation };
    }
    return null;
  }

  observeSlot(slotId: string): {
    lease: PanelRuntimeLease | null;
    observation: PanelPageObservation | null;
  } {
    const lease = this.leaseForSlot(asPanelSlotId(slotId));
    if (!lease) return { lease: null, observation: null };
    // Reconnect grace is a real lifecycle state: routing may preserve the
    // lease briefly, but readiness cannot survive a broken runtime channel.
    if (lease.expiresAt !== undefined) return { lease, observation: null };
    const reported = this.reportedViews.get(lease.runtimeEntityId);
    const observation = reported?.connectionId === lease.connectionId ? reported.observation : null;
    return { lease, observation };
  }

  /**
   * Resolve the shell caller that owns the host currently presenting a slot.
   *
   * Presentation is device-local. The caller id stamped when a host registers
   * is therefore the canonical address for focus/layout events; broadcasting
   * those events would make one device rearrange every collaborator's shell.
   */
  resolvePresentationCallerForSlot(slotId: string): string | null {
    const normalizedSlotId = asPanelSlotId(slotId);
    for (const lease of this.leases.values()) {
      if (lease.slotId !== normalizedSlotId) continue;
      return this.clientForHostConnection(lease.hostConnectionId)?.ownerCallerId ?? null;
    }
    return null;
  }

  resolvePresentationCallerForRuntime(runtimeEntityId: string): string | null {
    if (!isPanelEntityId(runtimeEntityId)) return null;
    const lease = this.leases.get(runtimeEntityId);
    return lease
      ? (this.clientForHostConnection(lease.hostConnectionId)?.ownerCallerId ?? null)
      : null;
  }

  adoptHostLeaseForSlot(
    slotId: string,
    runtimeEntityId: string,
    hostConnectionId: string
  ): PanelRuntimeLease | null {
    const normalizedSlotId = asPanelSlotId(slotId);
    const entityId = asPanelEntityId(runtimeEntityId);
    const existing = this.leases.get(entityId) ?? this.leaseForSlot(normalizedSlotId);
    if (existing) {
      if (existing.hostConnectionId === hostConnectionId && existing.supportsCdp) return existing;
      return null;
    }

    const client = this.clientForHostConnection(hostConnectionId);
    if (!client || client.supportsCdp === false) return null;

    return this.writeLease(
      entityId,
      {
        slotId,
        clientSessionId: client.clientSessionId,
        connectionId: `adopted-cdp-${slotId}-${randomUUID()}`,
        hostConnectionId,
      },
      "acquired"
    );
  }

  /**
   * Pick the default CDP host for a PROGRAMMATIC panel (no UI launcher).
   *
   * Origin is implicit here: a UI-launched panel reaches its desktop host via
   * the desktop orchestrator's own `acquire()` (the lease already exists, so
   * `ensureDefaultCdpHostForSlot` short-circuits at `already_held` and never
   * calls this). Every call into this selection is therefore agent/eval/worker
   * originated, with no UI host of its own. We MUST prefer the headless host:
   * `Page.captureScreenshot` and other CDP ops hang on an unpainted panel on a
   * headed desktop host. The desktop is kept only as a graceful fallback so
   * programmatic panels still render when no headless host is reachable
   * (matches the "degrade to desktop" requirement). Regression guard: 6ab6c7ca
   * flipped this to desktop-first, sending programmatic panels to the headed
   * host where capture hangs.
   *
   * `preferredPlatform` is only for stale-lease recovery. Visible UI leases
   * must recover onto the same platform; only server-created default CDP leases
   * may fall back to the programmatic default order.
   */
  getDefaultCdpHostClient(
    options: DefaultCdpHostOptions = {},
    preferredPlatform?: PanelRuntimeLease["platform"]
  ): ClientSession | null {
    const candidates = [...this.clients.values()].sort((a, b) => {
      const defaultRank = (client: ClientSession) => (client.platform === "headless" ? 0 : 1);
      const rank = (client: ClientSession) =>
        preferredPlatform
          ? client.platform === preferredPlatform
            ? 0
            : 1
          : client.platform === "headless"
            ? 0
            : 1;
      return rank(a) - rank(b) || defaultRank(a) - defaultRank(b);
    });
    for (const client of candidates) {
      const hostConnectionId = client.hostConnectionId ?? client.clientSessionId;
      if (hostConnectionId === options.excludedHostConnectionId) continue;
      if (client.supportsCdp === false) continue;
      if (client.loadOnLeaseAssignment !== true) continue;
      if (options.isHostAvailable && !options.isHostAvailable(hostConnectionId)) continue;
      return client;
    }
    return null;
  }

  ensureDefaultCdpHostForSlot(
    slotId: string,
    runtimeEntityId: string,
    options: DefaultCdpHostOptions = {}
  ):
    | { assigned: true; lease: PanelRuntimeLease }
    | {
        assigned: false;
        reason: "already_held" | "mobile_held" | "no_default_cdp_host";
        lease?: PanelRuntimeLease;
      } {
    const normalizedSlotId = asPanelSlotId(slotId);
    const entityId = asPanelEntityId(runtimeEntityId);
    const existing = this.leases.get(entityId) ?? null;
    if (existing) {
      if (!existing.supportsCdp) return { assigned: false, reason: "mobile_held", lease: existing };
      const reported = this.reportedViews.get(entityId);
      if (
        reported?.connectionId === existing.connectionId &&
        reported.observation.boot.phase === "failed" &&
        (this.defaultCdpLeaseConnections.has(existing.connectionId) ||
          existing.platform === "headless")
      ) {
        // A lease whose host has reported materialization failure no longer
        // satisfies ensureSlot. Reissue the host incarnation so the caller
        // gets one clean recovery attempt instead of waiting on a dead lease.
        return this.replaceFailedCdpLease(entityId, existing, options);
      }
      if (
        options.replaceUnavailableLease &&
        options.isHostAvailable &&
        !options.isHostAvailable(existing.hostConnectionId)
      ) {
        return this.replaceUnavailableCdpLease(entityId, existing, options);
      }
      if (
        existing.loadOnLeaseAssignment &&
        this.defaultCdpLeaseConnections.has(existing.connectionId) &&
        reported?.connectionId !== existing.connectionId
      ) {
        // A lease is only the desired presentation assignment. Until its host
        // reports the exact connection, it is not evidence that a renderer was
        // materialized. Re-announce the current assignment when an explicit
        // ensure observes that gap. This closes the event/state race between a
        // slot commit and host hydration without minting another incarnation.
        // Self-acquired desktop and mobile leases are deliberately excluded:
        // those hosts own their renderer lifecycle.
        this.emitChange(entityId, normalizedSlotId, existing, existing, "acquired");
        return { assigned: true, lease: existing };
      }
      return { assigned: false, reason: "already_held", lease: existing };
    }

    for (const lease of this.leases.values()) {
      if (lease.slotId !== normalizedSlotId) continue;
      if (!lease.supportsCdp) return { assigned: false, reason: "mobile_held", lease };
      if (
        lease.runtimeEntityId !== entityId &&
        (!options.isHostAvailable || options.isHostAvailable(lease.hostConnectionId))
      ) {
        const replacement = this.replaceRuntimeEntityForSlot(
          normalizedSlotId,
          lease.runtimeEntityId,
          entityId
        );
        return {
          assigned: true,
          lease: replacement ?? lease,
        };
      }
      if (
        options.replaceUnavailableLease &&
        options.isHostAvailable &&
        !options.isHostAvailable(lease.hostConnectionId)
      ) {
        return this.replaceUnavailableCdpLease(entityId, lease, options);
      }
      return { assigned: false, reason: "already_held", lease };
    }

    const client = this.getDefaultCdpHostClient(options);
    if (!client) return { assigned: false, reason: "no_default_cdp_host" };

    return {
      assigned: true,
      lease: this.writeLease(
        entityId,
        {
          slotId,
          clientSessionId: client.clientSessionId,
          connectionId: `default-cdp-${slotId}-${randomUUID()}`,
          hostConnectionId: client.hostConnectionId,
        },
        "acquired",
        { defaultCdpLease: true }
      ),
    };
  }

  /**
   * Advance the runtime identity of a slot that is already resident.
   *
   * A committed slot is durable workspace state, not a request to allocate a
   * renderer. Slot/entity reconciliation may therefore preserve an existing
   * lease, but it must never create the first lease. First residency belongs
   * to an explicit presentation consumer (`ensureSlot`, a visible desktop
   * pane, or CDP automation).
   */
  advanceResidentSlotEntity(slotId: string, nextRuntimeEntityId: string): PanelRuntimeLease | null {
    const normalizedSlotId = asPanelSlotId(slotId);
    const nextEntityId = asPanelEntityId(nextRuntimeEntityId);

    for (const lease of this.leases.values()) {
      if (lease.slotId !== normalizedSlotId) continue;
      if (lease.runtimeEntityId === nextEntityId) return lease;
      return this.replaceRuntimeEntityForSlot(
        normalizedSlotId,
        lease.runtimeEntityId,
        nextEntityId
      );
    }
    return null;
  }

  /**
   * Move one slot's host lease to a committed replacement runtime in a single
   * versioned transition. This prevents hosts from observing an unleased gap
   * between immutable panel incarnations.
   */
  replaceRuntimeEntityForSlot(
    slotId: string,
    previousRuntimeEntityId: string,
    nextRuntimeEntityId: string
  ): PanelRuntimeLease | null {
    const normalizedSlotId = asPanelSlotId(slotId);
    const previousEntityId = asPanelEntityId(previousRuntimeEntityId);
    const nextEntityId = asPanelEntityId(nextRuntimeEntityId);
    if (previousEntityId === nextEntityId) return this.leases.get(previousEntityId) ?? null;

    const previous = this.leases.get(previousEntityId);
    if (!previous || previous.slotId !== normalizedSlotId) {
      return this.leases.get(nextEntityId) ?? null;
    }
    const existingNext = this.leases.get(nextEntityId);
    if (existingNext) {
      // Converge recovery state as well as the ordinary single-lease path. A
      // pre-existing next lease must not leave the retiring incarnation as a
      // second lease for the same slot.
      this.clearExpiry(previousEntityId);
      this.leases.delete(previousEntityId);
      this.reportedViews.delete(previousEntityId);
      this.defaultCdpLeaseConnections.delete(previous.connectionId);
      this.closeLeaseConnection(
        previousEntityId,
        previous.connectionId,
        4091,
        "Panel runtime replaced"
      );
      this.emitChange(nextEntityId, normalizedSlotId, previous, existingNext, "acquired");
      return existingNext;
    }

    const wasDefaultCdpLease = this.defaultCdpLeaseConnections.delete(previous.connectionId);
    this.clearExpiry(previousEntityId);
    this.leases.delete(previousEntityId);
    this.reportedViews.delete(previousEntityId);
    this.closeLeaseConnection(
      previousEntityId,
      previous.connectionId,
      4091,
      "Panel runtime replaced"
    );

    if (!previous.loadOnLeaseAssignment) {
      // Hosts such as mobile own their renderer lifecycle and cannot realize a
      // server-assigned connection id. Release the retired incarnation and let
      // that host acquire the new entity with its own connection after the
      // canonical tree update. Transferring a fabricated lease here strands
      // the host on an unregistered principal.
      this.emitChange(nextEntityId, normalizedSlotId, previous, null, "released");
      return null;
    }

    const next: PanelRuntimeLease = {
      ...previous,
      runtimeEntityId: nextEntityId,
      connectionId: `replacement-cdp-${normalizedSlotId}-${randomUUID()}`,
      acquiredAt: Date.now(),
    };
    delete next.expiresAt;
    this.leases.set(nextEntityId, next);
    if (wasDefaultCdpLease) this.defaultCdpLeaseConnections.add(next.connectionId);
    this.emitChange(nextEntityId, normalizedSlotId, previous, next, "acquired");
    return next;
  }

  acquire(
    runtimeEntityId: string,
    input: {
      slotId: string;
      clientSessionId: string;
      connectionId: string;
      hostConnectionId?: string;
    }
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
    input: {
      slotId: string;
      clientSessionId: string;
      connectionId: string;
      hostConnectionId?: string;
    }
  ): PanelRuntimeAcquireResult {
    const entityId = asPanelEntityId(runtimeEntityId);
    const existing = this.leases.get(entityId);
    if (existing && existing.connectionId !== input.connectionId) {
      this.closeLeaseConnection(
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
    // Keep-loaded pin: a CDP client is mid-automation on this slot. Refuse the
    // drop so the lease stays in the snapshot and the host keeps the panel.
    if (this.keptLoadedSlots.has(existing.slotId)) {
      this.clearExpiry(entityId);
      return;
    }
    this.clearExpiry(entityId);
    this.leases.delete(entityId);
    this.reportedViews.delete(entityId);
    const wasDefaultCdpLease = this.defaultCdpLeaseConnections.delete(existing.connectionId);
    this.emitChange(entityId, existing.slotId, existing, null, reason);
    if (
      (reason === "released" || reason === "expired") &&
      this.shouldReassignDefaultCdpLease(existing, wasDefaultCdpLease)
    ) {
      this.assignDefaultCdpHost(entityId, existing.slotId, existing.hostConnectionId);
    }
  }

  unloadSlot(slotId: string): PanelRuntimeLease | null {
    const normalizedSlotId = asPanelSlotId(slotId);
    // Keep-loaded pin wins over an explicit unload while CDP automation is live.
    if (this.keptLoadedSlots.has(normalizedSlotId)) return null;
    for (const [entityId, lease] of this.leases) {
      if (lease.slotId !== normalizedSlotId) continue;
      this.clearExpiry(entityId);
      this.leases.delete(entityId);
      this.reportedViews.delete(entityId);
      this.defaultCdpLeaseConnections.delete(lease.connectionId);
      this.closeLeaseConnection(
        lease.runtimeEntityId,
        lease.connectionId,
        4094,
        "Panel runtime unloaded"
      );
      this.emitChange(entityId, lease.slotId, lease, null, "released");
      return lease;
    }
    return null;
  }

  retireRuntimeEntity(runtimeEntityId: string): void {
    // Runs for EVERY retiring entity (panels, workers, DOs — see runtimeEntityCleanup). Only panel
    // entities can hold a panel lease, so a non-panel id has nothing to retire here — return, don't throw.
    if (!isPanelEntityId(runtimeEntityId)) return;
    const entityId = runtimeEntityId;
    const existing = this.leases.get(entityId);
    if (!existing) return;
    this.clearExpiry(entityId);
    this.leases.delete(entityId);
    this.reportedViews.delete(entityId);
    this.defaultCdpLeaseConnections.delete(existing.connectionId);
    this.closeLeaseConnection(
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
    // The old sample belongs to the disconnected runtime channel. Keeping it
    // would make observeSlot report ready throughout reconnect grace.
    this.reportedViews.delete(entityId);
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

  resolveRouteLease(targetId: string): PanelRuntimeLease | null {
    // The router probes EVERY target id here — panel entity, panel slot, worker, or do. Branch on the
    // id KIND (a non-panel target has no panel lease) instead of laundering it through asPanel*, which
    // now throws. A panel entity id matches a lease directly; a panel slot id scans for the slot.
    if (isPanelEntityId(targetId)) {
      const entityLease = this.leases.get(targetId);
      if (entityLease) return entityLease;
    }
    if (isPanelSlotId(targetId)) {
      for (const lease of this.leases.values()) {
        if (lease.slotId === targetId) return lease;
      }
    }
    return null;
  }

  resolveRouteConnection(targetId: string): string | null {
    return this.resolveRouteLease(targetId)?.connectionId ?? null;
  }

  resolveRouteRuntimeEntityId(targetId: string): string | null {
    return this.resolveRouteLease(targetId)?.runtimeEntityId ?? null;
  }

  private writeLease(
    runtimeEntityId: PanelEntityId,
    input: {
      slotId: string;
      clientSessionId: string;
      connectionId: string;
      hostConnectionId?: string;
    },
    reason: PanelRuntimeLeaseChangedReason,
    options: { defaultCdpLease?: boolean } = {}
  ): PanelRuntimeLease {
    const client = this.clients.get(input.clientSessionId);
    if (!client) {
      throw new Error(`Unknown runtime client session: ${input.clientSessionId}`);
    }
    const slotId = asPanelSlotId(input.slotId);
    const previous = this.leases.get(runtimeEntityId) ?? null;
    this.clearExpiry(runtimeEntityId);
    // Re-acquiring the exact same runtime connection is an idempotent lease
    // refresh. Its page did not change, so keep the observation. A different
    // connection is a different host incarnation and must prove readiness for
    // itself.
    if (previous?.connectionId !== input.connectionId) {
      this.reportedViews.delete(runtimeEntityId);
    }
    if (previous) this.defaultCdpLeaseConnections.delete(previous.connectionId);
    const lease: PanelRuntimeLease = {
      slotId,
      runtimeEntityId,
      clientSessionId: input.clientSessionId,
      hostConnectionId: input.hostConnectionId ?? client.hostConnectionId ?? input.clientSessionId,
      connectionId: input.connectionId,
      holderLabel: client.label,
      platform: client.platform,
      supportsCdp: client.supportsCdp ?? client.platform !== "mobile",
      loadOnLeaseAssignment: client.loadOnLeaseAssignment ?? false,
      keepLoaded: this.keptLoadedSlots.has(slotId),
      acquiredAt: Date.now(),
    };
    this.leases.set(runtimeEntityId, lease);
    if (options.defaultCdpLease) this.defaultCdpLeaseConnections.add(lease.connectionId);
    this.emitChange(runtimeEntityId, slotId, previous, lease, reason);
    return lease;
  }

  private assignDefaultCdpHost(
    runtimeEntityId: PanelEntityId,
    slotId: PanelSlotId,
    excludedHostConnectionId?: string
  ): PanelRuntimeLease | null {
    // A release is an admission-control decision by the serving host (for
    // example, resource-cap eviction), not evidence that the same host should
    // immediately materialize the panel again. Reassignment may move durable
    // programmatic demand to another host, but never bounce it straight back
    // to the host that just declined residency.
    const client = this.getDefaultCdpHostClient({ excludedHostConnectionId });
    if (!client) return null;
    const connectionId = `default-cdp-${slotId}-${randomUUID()}`;
    return this.writeLease(
      runtimeEntityId,
      {
        slotId,
        clientSessionId: client.clientSessionId,
        connectionId,
        hostConnectionId: client.hostConnectionId,
      },
      "acquired",
      { defaultCdpLease: true }
    );
  }

  private replaceUnavailableCdpLease(
    runtimeEntityId: PanelEntityId,
    existing: PanelRuntimeLease,
    options: DefaultCdpHostOptions
  ):
    | { assigned: true; lease: PanelRuntimeLease }
    | { assigned: false; reason: "no_default_cdp_host"; lease: PanelRuntimeLease } {
    const wasDefaultCdpLease = this.defaultCdpLeaseConnections.has(existing.connectionId);
    const client = this.getDefaultCdpHostClient(options, existing.platform);
    if (!client || (!wasDefaultCdpLease && client.platform !== existing.platform)) {
      return { assigned: false, reason: "no_default_cdp_host", lease: existing };
    }
    this.defaultCdpLeaseConnections.delete(existing.connectionId);
    this.clearExpiry(existing.runtimeEntityId);
    this.leases.delete(existing.runtimeEntityId);
    this.reportedViews.delete(existing.runtimeEntityId);
    this.closeLeaseConnection(
      existing.runtimeEntityId,
      existing.connectionId,
      4091,
      "Panel runtime lease revoked"
    );
    this.emitChange(existing.runtimeEntityId, existing.slotId, existing, null, "revoked");
    return {
      assigned: true,
      lease: this.writeLease(
        runtimeEntityId,
        {
          slotId: existing.slotId,
          clientSessionId: client.clientSessionId,
          connectionId: `default-cdp-${existing.slotId}-${randomUUID()}`,
          hostConnectionId: client.hostConnectionId,
        },
        "acquired",
        { defaultCdpLease: wasDefaultCdpLease }
      ),
    };
  }

  private replaceFailedCdpLease(
    runtimeEntityId: PanelEntityId,
    existing: PanelRuntimeLease,
    options: DefaultCdpHostOptions
  ):
    | { assigned: true; lease: PanelRuntimeLease }
    | { assigned: false; reason: "no_default_cdp_host"; lease: PanelRuntimeLease } {
    const wasDefaultCdpLease = this.defaultCdpLeaseConnections.has(existing.connectionId);
    const client = this.getDefaultCdpHostClient(
      options,
      wasDefaultCdpLease ? undefined : existing.platform
    );
    if (!client || (!wasDefaultCdpLease && client.platform !== existing.platform)) {
      return { assigned: false, reason: "no_default_cdp_host", lease: existing };
    }
    this.defaultCdpLeaseConnections.delete(existing.connectionId);
    this.clearExpiry(existing.runtimeEntityId);
    this.leases.delete(existing.runtimeEntityId);
    this.reportedViews.delete(existing.runtimeEntityId);
    this.closeLeaseConnection(
      existing.runtimeEntityId,
      existing.connectionId,
      4091,
      "Panel runtime materialization retry"
    );
    this.emitChange(existing.runtimeEntityId, existing.slotId, existing, null, "revoked");
    return {
      assigned: true,
      lease: this.writeLease(
        runtimeEntityId,
        {
          slotId: existing.slotId,
          clientSessionId: client.clientSessionId,
          connectionId: `default-cdp-${existing.slotId}-${randomUUID()}`,
          hostConnectionId: client.hostConnectionId,
        },
        "acquired",
        { defaultCdpLease: wasDefaultCdpLease }
      ),
    };
  }

  private shouldReassignDefaultCdpLease(
    lease: PanelRuntimeLease,
    wasDefaultCdpLease = this.defaultCdpLeaseConnections.has(lease.connectionId)
  ): boolean {
    return wasDefaultCdpLease && lease.platform !== "headless";
  }

  private leaseForSlot(slotId: PanelSlotId): PanelRuntimeLease | null {
    for (const lease of this.leases.values()) {
      if (lease.slotId === slotId) return lease;
    }
    return null;
  }

  private clientForHostConnection(hostConnectionId: string): ClientSession | null {
    for (const client of this.clients.values()) {
      if ((client.hostConnectionId ?? client.clientSessionId) === hostConnectionId) return client;
    }
    return null;
  }

  private clearExpiry(runtimeEntityId: PanelEntityId): void {
    const timer = this.expiryTimers.get(runtimeEntityId);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(runtimeEntityId);
  }

  private closeLeaseConnection(
    runtimeEntityId: string,
    connectionId: string,
    code: number,
    reason: string
  ): void {
    try {
      this.closeConnection?.(runtimeEntityId, connectionId, code, reason);
    } catch (error) {
      this.deps.onError?.(error, `close ${runtimeEntityId}/${connectionId}`);
    }
  }

  private currentVersion(): RuntimeLeaseVersion {
    return { epoch: this.epoch, counter: this.counter };
  }

  private nextVersion(): RuntimeLeaseVersion {
    this.counter += 1;
    return this.currentVersion();
  }

  private nextSlotObservationVersion(slotId: PanelSlotId): RuntimeLeaseVersion {
    const counter = (this.slotObservationCounters.get(slotId) ?? 0) + 1;
    this.slotObservationCounters.set(slotId, counter);
    return { epoch: this.epoch, counter };
  }

  private emitChange(
    runtimeEntityId: PanelEntityId,
    slotId: PanelSlotId,
    previous: PanelRuntimeLease | null,
    next: PanelRuntimeLease | null,
    reason: PanelRuntimeLeaseChangedReason
  ): void {
    const event: PanelRuntimeLeaseChangedEvent = {
      type: "panel:runtimeLeaseChanged",
      version: this.nextVersion(),
      slotId,
      runtimeEntityId,
      previous,
      next,
      reason,
    };
    this.nextSlotObservationVersion(slotId);
    try {
      this.deps.eventService?.emit("panel:runtimeLeaseChanged", event);
    } catch (error) {
      this.deps.onError?.(error, `emit lease event for ${slotId}`);
    }
    for (const listener of this.leaseChangeListeners) {
      try {
        listener(event);
      } catch (error) {
        this.deps.onError?.(error, `notify lease listener for ${slotId}`);
      }
    }
    this.emitSlotObservationChanged(slotId);
  }

  private emitSlotObservationChanged(slotId: PanelSlotId): void {
    for (const listener of this.slotObservationListeners) {
      try {
        listener(slotId);
      } catch (error) {
        this.deps.onError?.(error, `notify observation listener for ${slotId}`);
      }
    }
  }
}
