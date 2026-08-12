import {
  PANEL_HOST_PROTOCOL_VERSION,
  type DesiredPanelSurface,
  type ObservedPanelSurface,
  type PanelHostApplyResult,
  type PanelHostDesiredSnapshot,
  type PanelHostEffect,
  type PanelHostEffectReceipt,
  type PanelHostEffectRequest,
  type PanelHostEffectResult,
  type PanelHostEndowment,
  type PanelHostHandshakeResult,
  type PanelHostObservedSnapshot,
  type PanelHostRejectionReason,
  type PanelShellHello,
} from "./index.js";

export type ReferencePanelHostProfile = "electron" | "headless" | "react-native";

export interface PanelHostAdapterConformanceHarness {
  connect(hello: PanelShellHello): PanelHostHandshakeResult;
  applyDesired(snapshot: PanelHostDesiredSnapshot): PanelHostApplyResult;
  executeEffect(request: PanelHostEffectRequest): PanelHostEffectResult;
  observation(): PanelHostObservedSnapshot;
  disconnect(shellGeneration: string, now: number): void;
  expireDisconnectedShell(now: number): void;
  crash(surfaceId: string, reason: string): void;
  observeNavigation(surfaceId: string, url: string): void;
  operationCounts(): Readonly<Record<"create" | "destroy" | "effect" | "update", number>>;
}

interface ReadySurfaceState {
  state: "ready";
  nativeSurfaceId: string;
  desired: DesiredPanelSurface;
  navigationUrl?: string;
}

interface CrashedSurfaceState {
  state: "crashed";
  surfaceId: string;
  occurrence: number;
  reason: string;
}

type SurfaceState = ReadySurfaceState | CrashedSurfaceState;

const PROFILE_ENDOWMENTS: Record<ReferencePanelHostProfile, readonly PanelHostEndowment[]> = {
  electron: ["cdp", "devtools", "downloads", "find", "native-navigation", "print", "session-data"],
  headless: ["cdp", "native-navigation", "session-data"],
  "react-native": ["find", "native-navigation"],
};

const EFFECT_ENDOWMENT: Record<PanelHostEffect["kind"], PanelHostEndowment> = {
  download: "downloads",
  find: "find",
  "open-devtools": "devtools",
  print: "print",
};

/**
 * A deterministic reference adapter for the A0 conformance suite. It models
 * protocol state only; it is not a production adapter and performs no native
 * effect.
 */
export class InMemoryPanelHostAdapter implements PanelHostAdapterConformanceHarness {
  private readonly endowments: readonly PanelHostEndowment[];
  private readonly surfaces = new Map<string, SurfaceState>();
  private readonly effectReceipts = new Map<
    string,
    { fingerprint: string; receipt: PanelHostEffectReceipt }
  >();
  private readonly counts = { create: 0, destroy: 0, effect: 0, update: 0 };
  private shellSerial = 0;
  private currentShellGeneration = "unclaimed";
  private desiredRevision: number | null = null;
  private desiredFingerprint: string | null = null;
  private observationRevision = 0;
  private nativeSurfaceSerial = 0;
  private crashSerial = 0;
  private teardownAt: number | null = null;

  constructor(
    readonly profile: ReferencePanelHostProfile,
    private readonly config: {
      hostGeneration?: string;
      retentionTimeoutMs?: number;
      endowments?: readonly PanelHostEndowment[];
    } = {}
  ) {
    this.endowments = [...new Set(config.endowments ?? PROFILE_ENDOWMENTS[profile])].sort();
  }

  get hostGeneration(): string {
    return this.config.hostGeneration ?? `host:${this.profile}:1`;
  }

  connect(hello: PanelShellHello): PanelHostHandshakeResult {
    if (!hello.supportedProtocolVersions.includes(PANEL_HOST_PROTOCOL_VERSION)) {
      return { accepted: false, reason: "unsupported-protocol" };
    }
    this.shellSerial += 1;
    this.currentShellGeneration = `shell:${this.shellSerial}`;
    this.desiredRevision = null;
    this.desiredFingerprint = null;
    this.observationRevision += 1;
    return {
      accepted: true,
      handshake: {
        protocolVersion: PANEL_HOST_PROTOCOL_VERSION,
        hostGeneration: this.hostGeneration,
        shellGeneration: this.currentShellGeneration,
        sealedLaunchIdentity: hello.sealedLaunchIdentity,
        endowments: [...this.endowments],
      },
    };
  }

  applyDesired(snapshot: PanelHostDesiredSnapshot): PanelHostApplyResult {
    const envelopeRejection = this.validateEnvelope(snapshot);
    if (envelopeRejection) return { accepted: false, reason: envelopeRejection };
    if (this.desiredRevision !== null && snapshot.revision < this.desiredRevision) {
      return { accepted: false, reason: "stale-revision" };
    }

    const normalized = normalizeSurfaces(snapshot.surfaces);
    if (!normalized) return { accepted: false, reason: "invalid-desired-state" };
    const desiredFingerprint = JSON.stringify(normalized);
    if (
      snapshot.revision === this.desiredRevision &&
      this.desiredFingerprint !== desiredFingerprint
    ) {
      return { accepted: false, reason: "revision-conflict" };
    }
    const endowmentRejection = this.validateDesiredEndowments(normalized);
    if (endowmentRejection) return { accepted: false, reason: endowmentRejection };

    let changed = false;
    const desiredIds = new Set(normalized.map((surface) => surface.surfaceId));
    for (const surfaceId of this.surfaces.keys()) {
      if (desiredIds.has(surfaceId)) continue;
      this.surfaces.delete(surfaceId);
      this.counts.destroy += 1;
      changed = true;
    }

    for (const desired of normalized) {
      const current = this.surfaces.get(desired.surfaceId);
      if (!current || current.state === "crashed") {
        this.nativeSurfaceSerial += 1;
        this.surfaces.set(desired.surfaceId, {
          state: "ready",
          nativeSurfaceId: `native:${this.profile}:${this.nativeSurfaceSerial}`,
          desired: cloneSurface(desired),
          ...(desired.navigation ? { navigationUrl: desired.navigation.url } : {}),
        });
        this.counts.create += 1;
        changed = true;
        continue;
      }
      const currentFingerprint = JSON.stringify(current.desired);
      const nextFingerprint = JSON.stringify(desired);
      if (currentFingerprint === nextFingerprint) {
        if (desired.navigation && current.navigationUrl !== desired.navigation.url) {
          current.navigationUrl = desired.navigation.url;
          this.counts.update += 1;
          changed = true;
        }
        continue;
      }
      current.desired = cloneSurface(desired);
      if (desired.navigation) current.navigationUrl = desired.navigation.url;
      else delete current.navigationUrl;
      this.counts.update += 1;
      changed = true;
    }

    const acceptedNewRevision = snapshot.revision !== this.desiredRevision;
    this.desiredRevision = snapshot.revision;
    this.desiredFingerprint = desiredFingerprint;
    this.teardownAt = null;
    if (changed || acceptedNewRevision) this.observationRevision += 1;
    return { accepted: true, observation: this.observation() };
  }

  executeEffect(request: PanelHostEffectRequest): PanelHostEffectResult {
    const envelopeRejection = this.validateEnvelope(request);
    if (envelopeRejection) return { accepted: false, reason: envelopeRejection };
    const surface = this.surfaces.get(request.surfaceId);
    if (!surface || surface.state !== "ready") {
      return { accepted: false, reason: "surface-unavailable" };
    }
    const required = EFFECT_ENDOWMENT[request.effect.kind];
    if (!this.endowments.includes(required)) {
      return { accepted: false, reason: "unsupported-endowment" };
    }
    const fingerprint = JSON.stringify({
      surfaceId: request.surfaceId,
      effect: request.effect,
    });
    const previous = this.effectReceipts.get(request.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        return { accepted: false, reason: "request-conflict" };
      }
      return { accepted: true, receipt: previous.receipt, replayed: true };
    }
    const receipt: PanelHostEffectReceipt = {
      requestId: request.requestId,
      surfaceId: request.surfaceId,
      effect: request.effect.kind,
      outcome: "succeeded",
    };
    this.effectReceipts.set(request.requestId, { fingerprint, receipt });
    this.counts.effect += 1;
    return { accepted: true, receipt, replayed: false };
  }

  observation(): PanelHostObservedSnapshot {
    const surfaces = [...this.surfaces.values()]
      .map((surface): ObservedPanelSurface => {
        if (surface.state === "crashed") {
          return {
            surfaceId: surface.surfaceId,
            state: "crashed",
            nativeSurfaceId: null,
            lastCrash: { occurrence: surface.occurrence, reason: surface.reason },
          };
        }
        return {
          surfaceId: surface.desired.surfaceId,
          state: "ready",
          nativeSurfaceId: surface.nativeSurfaceId,
          materialization: surface.desired.materialization
            ? { ...surface.desired.materialization }
            : null,
          visible: surface.desired.visible,
          focused: surface.desired.focused,
          bounds: surface.desired.bounds ? { ...surface.desired.bounds } : null,
          ...(surface.navigationUrl ? { navigationUrl: surface.navigationUrl } : {}),
        };
      })
      .sort((left, right) => left.surfaceId.localeCompare(right.surfaceId));
    return {
      protocolVersion: PANEL_HOST_PROTOCOL_VERSION,
      hostGeneration: this.hostGeneration,
      shellGeneration: this.currentShellGeneration,
      desiredRevision: this.desiredRevision,
      observationRevision: this.observationRevision,
      endowments: [...this.endowments],
      surfaces,
    };
  }

  disconnect(shellGeneration: string, now: number): void {
    if (shellGeneration !== this.currentShellGeneration) return;
    this.teardownAt = now + (this.config.retentionTimeoutMs ?? 30_000);
  }

  expireDisconnectedShell(now: number): void {
    if (this.teardownAt === null || now < this.teardownAt) return;
    this.counts.destroy += this.surfaces.size;
    this.surfaces.clear();
    this.teardownAt = null;
    this.observationRevision += 1;
  }

  crash(surfaceId: string, reason: string): void {
    const current = this.surfaces.get(surfaceId);
    if (!current || current.state !== "ready") return;
    this.crashSerial += 1;
    this.surfaces.set(surfaceId, {
      state: "crashed",
      surfaceId,
      occurrence: this.crashSerial,
      reason,
    });
    this.observationRevision += 1;
  }

  observeNavigation(surfaceId: string, url: string): void {
    const current = this.surfaces.get(surfaceId);
    if (!current || current.state !== "ready" || current.navigationUrl === url) return;
    current.navigationUrl = url;
    this.observationRevision += 1;
  }

  operationCounts() {
    return { ...this.counts };
  }

  private validateEnvelope(envelope: {
    protocolVersion: number;
    hostGeneration: string;
    shellGeneration: string;
  }): PanelHostRejectionReason | null {
    if (envelope.protocolVersion !== PANEL_HOST_PROTOCOL_VERSION) return "unsupported-protocol";
    if (envelope.hostGeneration !== this.hostGeneration) return "foreign-host-generation";
    if (envelope.shellGeneration !== this.currentShellGeneration) {
      return "stale-shell-generation";
    }
    return null;
  }

  private validateDesiredEndowments(
    surfaces: readonly DesiredPanelSurface[]
  ): "unsupported-endowment" | null {
    for (const surface of surfaces) {
      if (surface.navigation && !this.endowments.includes("native-navigation")) {
        return "unsupported-endowment";
      }
      if (surface.sessionData && !this.endowments.includes("session-data")) {
        return "unsupported-endowment";
      }
    }
    return null;
  }
}

function normalizeSurfaces(input: readonly DesiredPanelSurface[]): DesiredPanelSurface[] | null {
  const ids = new Set<string>();
  let focused = 0;
  const result: DesiredPanelSurface[] = [];
  for (const surface of input) {
    if (!surface.surfaceId || ids.has(surface.surfaceId)) return null;
    if (surface.focused) focused += 1;
    if (focused > 1) return null;
    if (surface.bounds && (surface.bounds.width < 0 || surface.bounds.height < 0)) return null;
    ids.add(surface.surfaceId);
    result.push(cloneSurface(surface));
  }
  return result.sort((left, right) => left.surfaceId.localeCompare(right.surfaceId));
}

function cloneSurface(surface: DesiredPanelSurface): DesiredPanelSurface {
  return {
    ...surface,
    materialization: surface.materialization ? { ...surface.materialization } : null,
    bounds: surface.bounds ? { ...surface.bounds } : null,
    ...(surface.navigation ? { navigation: { ...surface.navigation } } : {}),
    ...(surface.sessionData ? { sessionData: { ...surface.sessionData } } : {}),
  };
}
