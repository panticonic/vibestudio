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
  AwaitPanelAttemptResult,
  AttemptFailureStage,
  AttemptPhase,
  AttemptReporter,
  PanelAttempt,
  PanelAttemptFailure,
  PanelAttemptRef,
  PanelBootProbeResult,
  PanelPageObservation,
  PanelSlotObservation,
  StopReason,
} from "@vibestudio/shared/panel/observation";

const LEASE_RECONNECT_GRACE_MS = 3000;

const ATTEMPT_HISTORY_LIMIT = 8;
const ATTEMPT_STALL_PROBE_MS = 1_000;
const ATTEMPT_STALL_ROUNDS = 12;
const PHASE_RANK: Record<Exclude<AttemptPhase, "failed">, number> = {
  pending: 0,
  loading: 1,
  booting: 2,
  ready: 3,
  stopped: 4,
};
const STOP_CLOSE: Record<StopReason, { code: number; reason: string }> = {
  superseded: { code: 4091, reason: "Panel attempt superseded" },
  retired: { code: 4093, reason: "Panel runtime entity retired" },
  unloaded: { code: 4094, reason: "Panel runtime unloaded" },
  "host-lost": { code: 4095, reason: "Panel runtime host lost" },
};

type AttemptProbe = (slotId: PanelSlotId) => Promise<{
  url: string;
  loading: boolean;
  boot: PanelBootProbeResult;
  failure?: { reporter: "build" | "materialization" | "host"; failure: PanelAttemptFailure };
} | null>;

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
  private attempts = new Map<string, PanelAttempt>();
  private currentAttemptBySlot = new Map<PanelSlotId, string>();
  private terminalHistoryBySlot = new Map<PanelSlotId, string[]>();
  private routeBindings = new Map<string, string>();
  private routeReachability = new Map<string, boolean>();
  private routeViews = new Map<string, PanelPageObservation>();
  private buildStates = new Map<PanelSlotId, PanelSlotObservation["build"]>();
  private attemptListeners = new Set<(attemptId: string) => void>();
  private attemptProbe: AttemptProbe | null = null;
  private supervisionTimers = new Map<string, ReturnType<typeof setInterval>>();
  private supervisionInFlight = new Set<string>();
  private supervisionRounds = new Map<
    string,
    { revision: number; rounds: number; valid: number; unobservable: number }
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

  onAttemptChanged(listener: (attemptId: string) => void): () => void {
    this.attemptListeners.add(listener);
    return () => this.attemptListeners.delete(listener);
  }

  setAttemptProbe(probe: AttemptProbe | null): void {
    this.attemptProbe = probe;
  }

  get epochId(): string {
    return this.epoch;
  }

  observationVersion(slotId: string): RuntimeLeaseVersion {
    const normalizedSlotId = asPanelSlotId(slotId);
    return {
      epoch: this.epoch,
      counter: this.slotObservationCounters.get(normalizedSlotId) ?? 0,
    };
  }

  commitAttempt(
    slotId: string,
    input: {
      runtimeEntityId: string;
      hostConnectionId?: string;
      connectionId?: string;
      buildKey?: string;
      effectiveVersion?: string;
    }
  ): PanelAttempt {
    const normalizedSlotId = asPanelSlotId(slotId);
    const runtimeEntityId = asPanelEntityId(input.runtimeEntityId);
    const previous = this.currentAttempt(normalizedSlotId);
    if (previous && previous.phase !== "failed" && previous.phase !== "stopped") {
      this.transitionAttempt(previous, {
        phase: "stopped",
        reporter: "coordinator",
        stopReason: "superseded",
      });
    }
    if (previous) {
      for (const [connectionId, boundAttemptId] of this.routeBindings) {
        if (boundAttemptId !== previous.attemptId) continue;
        this.detachRoute(connectionId);
        // A same-connection re-acquire hands its live connection to the new
        // attempt; closing it here would kill the successor's route at birth.
        if (connectionId === input.connectionId) continue;
        const wire = STOP_CLOSE.superseded;
        this.closeLeaseConnection(previous.runtimeEntityId, connectionId, wire.code, wire.reason);
      }
      this.rememberTerminal(previous);
      // The build axis describes what the slot's *current* attempt depends on;
      // carrying the predecessor's resolved state across a supersession would
      // show "build: ready" (with the old buildKey) for the whole rebuild.
      this.buildStates.delete(normalizedSlotId);
    }

    const attempt: PanelAttempt = {
      epoch: this.epoch,
      attemptId: randomUUID(),
      slotId: normalizedSlotId,
      runtimeEntityId,
      ...(input.buildKey ? { buildKey: input.buildKey } : {}),
      ...(input.effectiveVersion ? { effectiveVersion: input.effectiveVersion } : {}),
      ...(input.hostConnectionId ? { hostConnectionId: input.hostConnectionId } : {}),
      phase: "pending",
      revision: 0,
      reporter: "coordinator",
      updatedAt: Date.now(),
    };
    this.attempts.set(attempt.attemptId, attempt);
    this.currentAttemptBySlot.set(normalizedSlotId, attempt.attemptId);
    if (input.connectionId) {
      this.routeBindings.set(input.connectionId, attempt.attemptId);
      this.routeReachability.set(input.connectionId, false);
    }
    this.nextSlotObservationVersion(normalizedSlotId);
    this.emitSlotObservationChanged(normalizedSlotId);
    return attempt;
  }

  stopAttempt(attemptId: string, reason: StopReason): PanelAttempt | null {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) return null;
    if (attempt.phase !== "failed" && attempt.phase !== "stopped") {
      this.transitionAttempt(attempt, {
        phase: "stopped",
        reporter: "coordinator",
        stopReason: reason,
      });
    }
    this.rememberTerminal(attempt);
    return this.attempts.get(attemptId) ?? attempt;
  }

  getAttempt(ref: PanelAttemptRef): AwaitPanelAttemptResult {
    if (ref.epoch !== this.epoch) return { kind: "unknown-attempt", ref };
    const attempt = this.attempts.get(ref.attemptId);
    return attempt ? { kind: "report", attempt } : { kind: "unknown-attempt", ref };
  }

  currentAttemptForSlot(slotId: string): PanelAttempt | null {
    return this.currentAttempt(asPanelSlotId(slotId));
  }

  ensureAttemptForSlot(slotId: string, runtimeEntityId: string): PanelAttempt {
    const normalizedSlotId = asPanelSlotId(slotId);
    const entityId = asPanelEntityId(runtimeEntityId);
    const current = this.currentAttempt(normalizedSlotId);
    if (current && current.runtimeEntityId === entityId && current.phase !== "stopped")
      return current;
    return this.commitAttempt(normalizedSlotId, { runtimeEntityId: entityId });
  }

  observeSlotLifecycle(slotId: string): PanelSlotObservation {
    const normalizedSlotId = asPanelSlotId(slotId);
    const attempt = this.currentAttempt(normalizedSlotId);
    const lease = this.leaseForSlot(normalizedSlotId);
    const connectionId = lease?.connectionId;
    const view = attempt ? this.routeViews.get(attempt.attemptId)?.view : undefined;
    return {
      attempt,
      route: {
        reachable: Boolean(connectionId && this.routeReachability.get(connectionId)),
        ...(connectionId ? { connectionId } : {}),
        ...(lease
          ? {
              holderLabel: lease.holderLabel,
              platform: lease.platform,
              supportsCdp: lease.supportsCdp,
            }
          : {}),
        ...(view ? { view } : {}),
      },
      ...(this.buildStates.get(normalizedSlotId)
        ? { build: this.buildStates.get(normalizedSlotId) }
        : {}),
      version: this.observationVersion(normalizedSlotId),
    };
  }

  setBuildState(slotId: string, build: NonNullable<PanelSlotObservation["build"]>): void {
    const normalizedSlotId = asPanelSlotId(slotId);
    const previous = this.buildStates.get(normalizedSlotId);
    if (previous?.state === build.state && previous.buildKey === build.buildKey) return;
    this.buildStates.set(normalizedSlotId, build);
    const attempt = this.currentAttempt(normalizedSlotId);
    if (attempt && build.buildKey && !attempt.buildKey) {
      this.updateAttempt(attempt, { buildKey: build.buildKey });
    }
    this.resetSupervisionProgress(attempt);
    this.nextSlotObservationVersion(normalizedSlotId);
    this.emitSlotObservationChanged(normalizedSlotId);
  }

  reportAttemptPhase(
    attemptId: string,
    report: {
      phase: AttemptPhase;
      reporter: AttemptReporter;
      failure?: PanelAttemptFailure;
      stopReason?: StopReason;
      buildKey?: string;
      effectiveVersion?: string;
    }
  ): boolean {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || !this.reporterAuthorized(report)) {
      this.rejectReport(attemptId, report, attempt ? "unauthorized reporter" : "unknown attempt");
      return false;
    }
    if (!this.canAdvance(attempt, report.phase)) {
      this.rejectReport(attemptId, report, "non-monotonic or terminal transition");
      return false;
    }
    this.transitionAttempt(attempt, report);
    return true;
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
      const wasDefaultCdpLease = this.defaultCdpLeaseConnections.delete(lease.connectionId);
      this.stopRouteAttempt(lease, "host-lost", true);
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
    input: {
      url: string;
      loading: boolean;
      boot: PanelBootProbeResult;
      failure?: {
        reporter: "build" | "materialization" | "host";
        failure: PanelAttemptFailure;
      };
    },
    deliveryPrincipal: "renderer" | "host" = "host"
  ): boolean {
    const entityId = asPanelEntityId(runtimeEntityId);
    const lease = this.leases.get(entityId);
    if (!lease || lease.connectionId !== connectionId) {
      this.rejectReport(
        this.routeBindings.get(connectionId) ?? "unbound-route",
        input,
        lease ? "stale connection for leased entity" : "no lease for reporting entity"
      );
      return false;
    }
    const attemptId = this.routeBindings.get(connectionId);
    const attempt = attemptId ? this.attempts.get(attemptId) : undefined;
    if (!attempt || attempt.runtimeEntityId !== entityId || attempt.slotId !== lease.slotId) {
      this.rejectReport(
        attemptId ?? "unbound-route",
        input,
        "route is not bound to current attempt"
      );
      return false;
    }
    const wasReachable = this.routeReachability.get(connectionId) === true;
    const previousPage = this.routeViews.get(attempt.attemptId);
    const observedBoot =
      input.boot.kind === "observed" ? { ...input.boot.observation, updatedAt: Date.now() } : null;
    const nextPage: PanelPageObservation = {
      view: { url: input.url, loading: input.loading },
      boot: observedBoot
        ? { kind: "observed", observation: observedBoot }
        : { kind: "unavailable" },
    };
    const pageChanged =
      previousPage?.view.url !== nextPage.view.url ||
      previousPage?.view.loading !== nextPage.view.loading ||
      previousPage?.boot.kind !== nextPage.boot.kind ||
      (previousPage?.boot.kind === "observed" ? previousPage.boot.observation.phase : undefined) !==
        observedBoot?.phase ||
      (previousPage?.boot.kind === "observed"
        ? previousPage.boot.observation.runtimeEntityId
        : undefined) !== observedBoot?.runtimeEntityId ||
      (previousPage?.boot.kind === "observed"
        ? previousPage.boot.observation.source
        : undefined) !== observedBoot?.source ||
      (previousPage?.boot.kind === "observed"
        ? previousPage.boot.observation.contextId
        : undefined) !== observedBoot?.contextId ||
      (previousPage?.boot.kind === "observed"
        ? previousPage.boot.observation.effectiveVersion
        : undefined) !== observedBoot?.effectiveVersion ||
      (previousPage?.boot.kind === "observed"
        ? previousPage.boot.observation.buildKey
        : undefined) !== observedBoot?.buildKey ||
      (previousPage?.boot.kind === "observed"
        ? previousPage.boot.observation.message
        : undefined) !== observedBoot?.message ||
      (previousPage?.boot.kind === "observed"
        ? previousPage.boot.observation.errorName
        : undefined) !== observedBoot?.errorName ||
      (previousPage?.boot.kind === "observed" ? previousPage.boot.observation.stack : undefined) !==
        observedBoot?.stack ||
      (previousPage?.boot.kind === "observed"
        ? previousPage.boot.observation.failureStage
        : undefined) !== observedBoot?.failureStage;
    const previousBuild = this.buildStates.get(lease.slotId);
    const buildChanged = Boolean(
      observedBoot?.buildKey &&
      (previousBuild?.state !== "ready" || previousBuild.buildKey !== observedBoot.buildKey)
    );
    if (observedBoot?.buildKey) {
      this.buildStates.set(lease.slotId, { state: "ready", buildKey: observedBoot.buildKey });
    }
    this.routeReachability.set(connectionId, true);
    this.routeViews.set(attempt.attemptId, nextPage);
    // A host may originate its own typed failure (navigation, renderer crash)
    // alongside the observed page state. The renderer principal cannot: its
    // failures travel inside the boot record it owns.
    if (input.failure && deliveryPrincipal === "host") {
      const reported = this.reportAttemptPhase(attempt.attemptId, {
        phase: "failed",
        reporter: input.failure.reporter,
        failure: input.failure.failure,
      });
      if (reported && input.failure.failure.stage === "build") {
        this.setBuildState(attempt.slotId, { state: "failed" });
      }
      return reported;
    }
    let advanced = false;
    if (observedBoot && observedBoot.phase !== attempt.phase) {
      // Preserve the loader's failure taxonomy. Records predating the
      // failureStage tag default to entry — the historical common case.
      const bootFailureStage = observedBoot.failureStage ?? "entry";
      const failure =
        observedBoot.phase === "failed"
          ? {
              stage: bootFailureStage,
              code:
                bootFailureStage === "bundle-load"
                  ? ("asset_unavailable" as const)
                  : bootFailureStage === "config"
                    ? ("unknown_failure" as const)
                    : ("entry_threw" as const),
              ...(observedBoot.message ? { message: observedBoot.message } : {}),
              ...(observedBoot.stack ? { stack: observedBoot.stack } : {}),
            }
          : undefined;
      advanced = this.reportAttemptPhase(attempt.attemptId, {
        phase: observedBoot.phase,
        reporter: deliveryPrincipal,
        ...(failure ? { failure } : {}),
        ...(observedBoot.buildKey ? { buildKey: observedBoot.buildKey } : {}),
        ...(observedBoot.effectiveVersion
          ? { effectiveVersion: observedBoot.effectiveVersion }
          : {}),
      });
    }
    if (!advanced && (pageChanged || buildChanged || !wasReachable)) {
      this.nextSlotObservationVersion(lease.slotId);
      this.emitSlotObservationChanged(lease.slotId);
    }
    return true;
  }

  reportedViewForSlot(
    slotId: string
  ): { lease: PanelRuntimeLease; observation: PanelPageObservation } | null {
    const normalizedSlotId = asPanelSlotId(slotId);
    for (const lease of this.leases.values()) {
      if (lease.slotId !== normalizedSlotId) continue;
      const attemptId = this.routeBindings.get(lease.connectionId);
      const observation = attemptId ? this.routeViews.get(attemptId) : undefined;
      if (!observation) return null;
      return { lease, observation };
    }
    return null;
  }

  observeSlot(slotId: string): {
    lease: PanelRuntimeLease | null;
    observation: PanelPageObservation | null;
  } {
    const lease = this.leaseForSlot(asPanelSlotId(slotId));
    if (!lease) return { lease: null, observation: null };
    const attemptId = this.routeBindings.get(lease.connectionId);
    const observation = attemptId ? (this.routeViews.get(attemptId) ?? null) : null;
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
      const attempt = this.currentAttempt(normalizedSlotId);
      if (
        attempt?.runtimeEntityId === entityId &&
        attempt.phase === "failed" &&
        (this.defaultCdpLeaseConnections.has(existing.connectionId) ||
          existing.platform === "headless")
      ) {
        // A lease whose host has reported materialization failure no longer
        // satisfies ensureSlot. Reissue the host incarnation so the caller
        // gets one clean recovery attempt instead of waiting on a dead lease.
        return this.replaceCdpLease(entityId, existing, options, "prefer-default");
      }
      if (
        options.replaceUnavailableLease &&
        options.isHostAvailable &&
        !options.isHostAvailable(existing.hostConnectionId)
      ) {
        return this.replaceCdpLease(entityId, existing, options, "same-platform");
      }
      if (
        existing.loadOnLeaseAssignment &&
        this.defaultCdpLeaseConnections.has(existing.connectionId) &&
        !this.routeViews.has(attempt?.attemptId ?? "")
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
        return this.replaceCdpLease(entityId, lease, options, "same-platform");
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
    const wasDefaultCdpLease = this.defaultCdpLeaseConnections.delete(previous.connectionId);
    this.clearExpiry(previousEntityId);
    this.leases.delete(previousEntityId);
    this.stopRouteAttempt(previous, "superseded", true);

    const existingNext = this.leases.get(nextEntityId);
    if (existingNext) {
      this.emitChange(nextEntityId, normalizedSlotId, previous, existingNext, "acquired");
      return existingNext;
    }

    if (!previous.loadOnLeaseAssignment) {
      // Hosts such as mobile own their renderer lifecycle and cannot realize a
      // server-assigned connection id. Release the retired incarnation and let
      // that host acquire the new entity with its own connection after the
      // canonical tree update. Transferring a fabricated lease here strands
      // the host on an unregistered principal.
      this.commitAttempt(normalizedSlotId, { runtimeEntityId: nextEntityId });
      this.emitChange(nextEntityId, normalizedSlotId, previous, null, "released");
      return null;
    }
    return this.writeLease(
      nextEntityId,
      {
        slotId: normalizedSlotId,
        clientSessionId: previous.clientSessionId,
        connectionId: randomUUID(),
        hostConnectionId: previous.hostConnectionId,
      },
      "acquired",
      { defaultCdpLease: wasDefaultCdpLease }
    );
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
      this.stopRouteAttempt(existing, "superseded", true);
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
    const wasDefaultCdpLease = this.defaultCdpLeaseConnections.delete(existing.connectionId);
    this.stopRouteAttempt(existing, reason === "expired" ? "host-lost" : "unloaded", false);
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
      this.defaultCdpLeaseConnections.delete(lease.connectionId);
      this.stopRouteAttempt(lease, "unloaded", true);
      this.emitChange(entityId, lease.slotId, lease, null, "released");
      return lease;
    }
    const attempt = this.currentAttempt(normalizedSlotId);
    if (attempt) this.stopAttempt(attempt.attemptId, "unloaded");
    return null;
  }

  retireRuntimeEntity(runtimeEntityId: string): void {
    // Runs for EVERY retiring entity (panels, workers, DOs — see runtimeEntityCleanup). Only panel
    // entities can hold a panel lease, so a non-panel id has nothing to retire here — return, don't throw.
    if (!isPanelEntityId(runtimeEntityId)) return;
    const entityId = runtimeEntityId;
    const existing = this.leases.get(entityId);
    if (existing) {
      this.clearExpiry(entityId);
      this.leases.delete(entityId);
      this.defaultCdpLeaseConnections.delete(existing.connectionId);
      this.stopRouteAttempt(existing, "retired", true);
      this.emitChange(entityId, existing.slotId, existing, null, "retired");
    }
    for (const attemptId of this.currentAttemptBySlot.values()) {
      const attempt = this.attempts.get(attemptId);
      if (attempt?.runtimeEntityId === entityId) this.stopAttempt(attemptId, "retired");
    }
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
    const wasReachable = this.routeReachability.get(connectionId) === true;
    this.routeReachability.set(connectionId, true);
    const attemptId = this.routeBindings.get(connectionId);
    const attempt = attemptId ? this.attempts.get(attemptId) : undefined;
    if (attempt && (attempt.phase === "loading" || attempt.phase === "booting")) {
      this.ensureSupervision(attempt);
    }
    if (lease.expiresAt !== undefined) {
      const next = { ...lease };
      delete next.expiresAt;
      this.leases.set(entityId, next);
      this.emitChange(entityId, lease.slotId, lease, next, "acquired");
    } else if (!wasReachable) {
      this.nextSlotObservationVersion(lease.slotId);
      this.emitSlotObservationChanged(lease.slotId);
    }
  }

  markDisconnected(runtimeEntityId: string, connectionId: string): void {
    const entityId = asPanelEntityId(runtimeEntityId);
    const lease = this.leases.get(entityId);
    if (!lease || lease.connectionId !== connectionId) return;
    this.clearExpiry(entityId);
    this.routeReachability.set(connectionId, false);
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
    const sameRoute = previous?.connectionId === input.connectionId;
    if (previous && !sameRoute) this.detachRoute(previous.connectionId);
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
    const currentAttempt = this.currentAttempt(slotId);
    const reusesCurrentMaterialization = Boolean(
      currentAttempt &&
      currentAttempt.runtimeEntityId === runtimeEntityId &&
      currentAttempt.phase !== "failed" &&
      currentAttempt.phase !== "stopped" &&
      (sameRoute ||
        (!previous &&
          currentAttempt.phase === "pending" &&
          currentAttempt.hostConnectionId === undefined))
    );
    if (!reusesCurrentMaterialization) {
      this.commitAttempt(slotId, {
        runtimeEntityId,
        hostConnectionId: lease.hostConnectionId,
        connectionId: lease.connectionId,
      });
    } else {
      const reusedAttempt = currentAttempt!;
      this.updateAttempt(reusedAttempt, { hostConnectionId: lease.hostConnectionId });
      this.routeBindings.set(lease.connectionId, reusedAttempt.attemptId);
      if (!this.routeReachability.has(lease.connectionId)) {
        this.routeReachability.set(lease.connectionId, false);
      }
    }
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

  /**
   * Revoke a default-CDP lease and re-home its slot on a fresh default host.
   * `hostSelection` differs by trigger: an unavailable host must be replaced
   * like-for-like on platform; a failed boot on a default lease may re-home
   * anywhere (one clean recovery attempt), while a self-acquired host stays
   * platform-pinned.
   */
  private replaceCdpLease(
    runtimeEntityId: PanelEntityId,
    existing: PanelRuntimeLease,
    options: DefaultCdpHostOptions,
    hostSelection: "same-platform" | "prefer-default"
  ):
    | { assigned: true; lease: PanelRuntimeLease }
    | { assigned: false; reason: "no_default_cdp_host"; lease: PanelRuntimeLease } {
    const wasDefaultCdpLease = this.defaultCdpLeaseConnections.has(existing.connectionId);
    const client = this.getDefaultCdpHostClient(
      options,
      hostSelection === "prefer-default" && wasDefaultCdpLease ? undefined : existing.platform
    );
    if (!client || (!wasDefaultCdpLease && client.platform !== existing.platform)) {
      return { assigned: false, reason: "no_default_cdp_host", lease: existing };
    }
    this.defaultCdpLeaseConnections.delete(existing.connectionId);
    this.clearExpiry(existing.runtimeEntityId);
    this.leases.delete(existing.runtimeEntityId);
    this.stopRouteAttempt(existing, "superseded", true);
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

  private currentAttempt(slotId: PanelSlotId): PanelAttempt | null {
    const attemptId = this.currentAttemptBySlot.get(slotId);
    return attemptId ? (this.attempts.get(attemptId) ?? null) : null;
  }

  private reporterAuthorized(report: {
    phase: AttemptPhase;
    reporter: AttemptReporter;
    failure?: PanelAttemptFailure;
  }): boolean {
    if (report.reporter === "coordinator") {
      return (
        report.phase === "stopped" ||
        (report.phase === "failed" && report.failure?.stage === "boot-stall")
      );
    }
    if (report.reporter === "build") {
      return report.phase === "failed" && report.failure?.stage === "build";
    }
    if (report.reporter === "materialization") {
      return report.phase === "failed" && report.failure?.stage === "materialization";
    }
    if (report.reporter === "renderer") {
      return (
        report.phase === "loading" ||
        report.phase === "booting" ||
        report.phase === "ready" ||
        (report.phase === "failed" &&
          (report.failure?.stage === "bundle-load" ||
            report.failure?.stage === "config" ||
            report.failure?.stage === "entry"))
      );
    }
    return (
      report.phase === "loading" ||
      report.phase === "booting" ||
      report.phase === "ready" ||
      (report.phase === "failed" &&
        (report.failure?.stage === "bundle-load" ||
          report.failure?.stage === "config" ||
          report.failure?.stage === "entry" ||
          report.failure?.stage === "navigation" ||
          report.failure?.stage === "renderer-crash"))
    );
  }

  private canAdvance(attempt: PanelAttempt, next: AttemptPhase): boolean {
    if (attempt.phase === "failed" || attempt.phase === "stopped") return false;
    if (next === "failed") return attempt.phase !== "ready";
    if (next === "stopped") return true;
    if (attempt.phase === "ready") return false;
    return PHASE_RANK[next] > PHASE_RANK[attempt.phase];
  }

  private transitionAttempt(
    attempt: PanelAttempt,
    report: {
      phase: AttemptPhase;
      reporter: AttemptReporter;
      failure?: PanelAttemptFailure;
      stopReason?: StopReason;
      buildKey?: string;
      effectiveVersion?: string;
    }
  ): PanelAttempt {
    const next: PanelAttempt = {
      ...attempt,
      phase: report.phase,
      reporter: report.reporter,
      revision: attempt.revision + 1,
      updatedAt: Date.now(),
      ...(report.buildKey ? { buildKey: report.buildKey } : {}),
      ...(report.effectiveVersion ? { effectiveVersion: report.effectiveVersion } : {}),
      ...(report.failure ? { failure: report.failure } : {}),
      ...(report.stopReason ? { stopReason: report.stopReason } : {}),
    };
    this.attempts.set(next.attemptId, next);
    if ((next.phase === "loading" || next.phase === "booting") && this.hasReachableRoute(next)) {
      this.ensureSupervision(next);
    } else if (next.phase === "failed" || next.phase === "stopped" || next.phase === "ready") {
      this.stopSupervision(next.attemptId);
    }
    this.emitAttemptChanged(next.attemptId);
    const slotId = asPanelSlotId(next.slotId);
    this.nextSlotObservationVersion(slotId);
    this.emitSlotObservationChanged(slotId);
    return next;
  }

  private updateAttempt(attempt: PanelAttempt, attributes: Partial<PanelAttempt>): PanelAttempt {
    const next = { ...attempt, ...attributes, updatedAt: Date.now() };
    this.attempts.set(next.attemptId, next);
    return next;
  }

  private stopRouteAttempt(lease: PanelRuntimeLease, reason: StopReason, close: boolean): void {
    const boundAttemptId = this.routeBindings.get(lease.connectionId);
    const current = this.currentAttempt(lease.slotId);
    const attemptId =
      boundAttemptId ??
      (current?.runtimeEntityId === lease.runtimeEntityId ? current.attemptId : undefined);
    if (attemptId) this.stopAttempt(attemptId, reason);
    this.detachRoute(lease.connectionId);
    if (close) {
      const wire = STOP_CLOSE[reason];
      this.closeLeaseConnection(lease.runtimeEntityId, lease.connectionId, wire.code, wire.reason);
    }
  }

  private detachRoute(connectionId: string): void {
    this.routeBindings.delete(connectionId);
    this.routeReachability.delete(connectionId);
  }

  private rememberTerminal(attempt: PanelAttempt): void {
    const stored = this.attempts.get(attempt.attemptId) ?? attempt;
    if (stored.phase !== "failed" && stored.phase !== "stopped") return;
    const slotId = asPanelSlotId(stored.slotId);
    const history = this.terminalHistoryBySlot.get(slotId) ?? [];
    const next = [stored.attemptId, ...history.filter((id) => id !== stored.attemptId)];
    const evicted = next.splice(ATTEMPT_HISTORY_LIMIT);
    this.terminalHistoryBySlot.set(slotId, next);
    for (const attemptId of evicted) {
      if (this.currentAttemptBySlot.get(slotId) === attemptId) continue;
      this.attempts.delete(attemptId);
      this.routeViews.delete(attemptId);
      this.stopSupervision(attemptId);
      this.emitAttemptChanged(attemptId);
    }
  }

  private ensureSupervision(attempt: PanelAttempt): void {
    if (!this.supervisionTimers.has(attempt.attemptId)) {
      this.startSupervision(attempt);
      return;
    }
    this.resetSupervisionProgress(attempt);
  }

  private hasReachableRoute(attempt: PanelAttempt): boolean {
    const lease = this.leaseForSlot(asPanelSlotId(attempt.slotId));
    return Boolean(
      lease &&
      this.routeBindings.get(lease.connectionId) === attempt.attemptId &&
      this.routeReachability.get(lease.connectionId) === true
    );
  }

  private emitAttemptChanged(attemptId: string): void {
    for (const listener of this.attemptListeners) {
      try {
        listener(attemptId);
      } catch (error) {
        this.deps.onError?.(error, `notify attempt listener for ${attemptId}`);
      }
    }
  }

  private startSupervision(attempt: PanelAttempt): void {
    this.stopSupervision(attempt.attemptId);
    this.supervisionRounds.set(attempt.attemptId, {
      revision: attempt.revision,
      rounds: 0,
      valid: 0,
      unobservable: 0,
    });
    const timer = setInterval(
      () => void this.superviseAttempt(attempt.attemptId),
      ATTEMPT_STALL_PROBE_MS
    );
    timer.unref?.();
    this.supervisionTimers.set(attempt.attemptId, timer);
  }

  private stopSupervision(attemptId: string): void {
    const timer = this.supervisionTimers.get(attemptId);
    if (timer) clearInterval(timer);
    this.supervisionTimers.delete(attemptId);
    this.supervisionRounds.delete(attemptId);
  }

  private resetSupervisionProgress(attempt: PanelAttempt | null | undefined): void {
    if (!attempt) return;
    const state = this.supervisionRounds.get(attempt.attemptId);
    if (!state) return;
    state.revision = attempt.revision;
    state.rounds = 0;
    state.valid = 0;
    state.unobservable = 0;
  }

  private async superviseAttempt(attemptId: string): Promise<void> {
    const attempt = this.attempts.get(attemptId);
    const state = this.supervisionRounds.get(attemptId);
    if (
      !attempt ||
      !state ||
      attempt.phase === "ready" ||
      attempt.phase === "failed" ||
      attempt.phase === "stopped"
    ) {
      this.stopSupervision(attemptId);
      return;
    }
    // A probe slower than the cadence must not overlap itself: overlapping
    // completions would count as extra rounds and reach the stall threshold
    // in less wall time than the cadence promises.
    if (this.supervisionInFlight.has(attemptId)) return;
    this.supervisionInFlight.add(attemptId);
    try {
      await this.superviseAttemptRound(attemptId, attempt, state);
    } finally {
      this.supervisionInFlight.delete(attemptId);
    }
  }

  private async superviseAttemptRound(
    attemptId: string,
    attempt: PanelAttempt,
    state: { revision: number; rounds: number; valid: number; unobservable: number }
  ): Promise<void> {
    let observed = false;
    if (this.attemptProbe) {
      try {
        const report = await this.attemptProbe(asPanelSlotId(attempt.slotId));
        // A probe that answers with no boot record is a renderer that isn't
        // talking, not a valid observation — count it on the unobservable side.
        observed = report?.boot.kind === "observed";
        if (report?.failure) {
          this.reportAttemptPhase(attemptId, {
            phase: "failed",
            reporter: report.failure.reporter,
            failure: report.failure.failure,
          });
          if (report.failure.failure.stage === "build") {
            this.setBuildState(attempt.slotId, { state: "failed" });
          }
          return;
        }
        const lease = this.leaseForSlot(asPanelSlotId(attempt.slotId));
        if (report && lease && this.routeBindings.get(lease.connectionId) === attemptId) {
          this.reportView(attempt.runtimeEntityId, lease.connectionId, report, "host");
        }
      } catch (error) {
        this.deps.onError?.(error, `probe panel attempt ${attemptId}`);
      }
    }
    const current = this.attempts.get(attemptId);
    if (!current || current.revision > state.revision) {
      if (current) this.resetSupervisionProgress(current);
      return;
    }
    state.rounds += 1;
    if (observed) state.valid += 1;
    else state.unobservable += 1;
    if (state.rounds < ATTEMPT_STALL_ROUNDS) return;
    this.reportAttemptPhase(attemptId, {
      phase: "failed",
      reporter: "coordinator",
      failure: {
        stage: "boot-stall",
        code: "boot_stalled",
        message: "Panel boot made no progress",
        detail: state.unobservable > state.valid ? "unobservable" : "no-progress",
        diagnostics: {
          rounds: state.rounds,
          valid: state.valid,
          unobservable: state.unobservable,
          lastObservation: this.routeViews.get(attemptId) ?? null,
        },
      },
    });
  }

  private rejectReport(attemptId: string, report: unknown, reason: string): void {
    const error = Object.assign(new Error(`Rejected panel attempt report: ${reason}`), {
      attemptId,
      report,
      attempt: this.attempts.get(attemptId) ?? null,
    });
    this.deps.onError?.(error, `reject panel attempt report ${attemptId}`);
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
