import { randomUUID } from "crypto";
import { createDevLogger } from "@vibestudio/dev-log";
import type { Panel, PanelSnapshot } from "@vibestudio/shared/types";
import type { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import type { EventService } from "@vibestudio/shared/eventsService";
import type { PanelManager } from "@vibestudio/shell-core/panelManager";
import type {
  PanelHostRegistration,
  PanelRuntimeLease,
  PanelRuntimeLeaseChangedEvent,
} from "@vibestudio/shared/panel/panelLease";
import {
  createPanelHostRegistration,
  createPanelRuntimeLeaseRequest,
  formatPanelRuntimeLeaseDeniedMessage,
} from "@vibestudio/shared/panel/panelLease";
import type { PanelHttpServerLike, PanelViewLike } from "@vibestudio/shared/panelInterfaces";
import { contextIdToPartition } from "@vibestudio/shared/contextIdToPartition";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { panelRuntimeMethods } from "@vibestudio/service-schemas/panelRuntime";
import { buildPanelUrl } from "@vibestudio/shared/panelFactory";
import {
  PANEL_UI_IDLE_SWEEP_MS,
  PANEL_UI_IDLE_SWEEP_MS_HEADLESS,
  PANEL_UI_IDLE_UNLOAD_MS_HEADLESS,
  PANEL_UI_MAX_LOADED_HEADLESS,
} from "@vibestudio/shared/constants";
import { getCurrentSnapshot } from "@vibestudio/shared/panel/accessors";
import { asPanelEntityId, asPanelSlotId } from "@vibestudio/shared/panel/ids";
import { assertPresent } from "../lintHelpers";
import { PanelResourcePolicy } from "./panelResourcePolicy.js";
import type {
  PanelBootObservation,
  PanelBootProbeResult,
} from "@vibestudio/shared/panel/observation";
import type {
  PanelPresentation,
  PanelPresentationSnapshot,
  PanelPresentationStage,
} from "@vibestudio/shared/panel/presentation";
import { summarizePresentationLease } from "@vibestudio/shared/panel/presentation";

const log = createDevLogger("PanelPresentationController");

export interface PanelPresentationControllerDeps {
  registry: PanelRegistry;
  eventService: EventService;
  shellCore: PanelManager;
  callServer: (service: string, method: string, args: unknown[]) => Promise<unknown>;
  getPanelView: () => PanelViewLike | null;
  cdpHost: {
    registerTarget?(panelId: string, contentsId: number): void;
    cleanupPanelAccess(panelId: string): void;
    unregisterTarget?(panelId: string): void;
    getBootObservation?(panelId: string): Promise<PanelBootProbeResult>;
  };
  panelHttpServer: PanelHttpServerLike;
  sendPanelEvent: (panelId: string, event: string, payload: unknown) => void;
  gatewayPort: number;
  gatewayBasePath?: string;
  waitForBrowserSessionPartition: () => Promise<string>;
  /** Product-owned intent to retain a panel's native runtime resources. */
  hasRetentionIntent?: (panelId: string) => boolean;
  /**
   * Panel ids currently bound to native slots (resident in the shell's
   * column viewport); the GC protects them alongside the focused panel (§5.3).
   * Absent on hosts without native slots (headless), where it is empty.
   */
  getResidentPanelIds?: () => string[];
  getNativeBinding?: (panelId: string) => { nativeSlotId: string } | null;
  attachNativeBinding?: (panelId: string) => { nativeSlotId: string } | null;
  publishPresentation?: (snapshot: PanelPresentationSnapshot) => void;
  client: Partial<PanelHostRegistration> & {
    maxAssignedPanelViews?: number;
    uiIdleUnloadMs?: number;
    uiIdleSweepMs?: number;
  };
}

export type PanelRuntimeReleaseTransition = "close" | "invalidate" | "lease-transfer" | "unload";

interface PresentationAttempt {
  readonly token: object;
  readonly slotId: string;
  readonly attemptId: string;
  readonly targetKey: string;
  status: "active" | "ready" | "unavailable" | "failed" | "cancelled";
  stage: PanelPresentationStage;
  completion: Promise<PresentationAttemptResult>;
  resolve: (result: PresentationAttemptResult) => void;
}

type PresentationAttemptResult =
  | Extract<PanelPresentation, { state: "ready" | "unavailable" | "failed" }>
  | { state: "cancelled"; slotId: string; attemptId: string };

class LeaseUnavailableError extends Error {
  constructor(
    readonly lease: PanelRuntimeLease,
    message: string
  ) {
    super(message);
    this.name = "LeaseUnavailableError";
  }
}

/**
 * Owns the complete lifecycle of native panel views and their server leases.
 * Tree reconciliation lives here because applying an authoritative tree and
 * reconciling the corresponding views/leases is one atomic responsibility.
 */
export class PanelPresentationController {
  private readonly clientSessionId: string;
  private readonly clientLabel: string;
  private readonly clientPlatform: "desktop" | "headless" | "mobile";
  private readonly clientSupportsCdp: boolean;
  private readonly loadOnLeaseAssignment: boolean;
  private readonly resources: PanelResourcePolicy;
  private clientRegistered = false;
  private readonly connectionBySlot = new Map<
    string,
    { runtimeEntityId: string; connectionId: string; ownerToken?: object }
  >();
  private readonly stateArgsPushUnsubs = new Map<string, () => void>();
  private readonly explicitTitlePanelIds = new Set<string>();
  private readonly attemptBySlot = new Map<string, PresentationAttempt>();
  private readonly progressBySlot = new Map<string, Promise<void>>();
  private readonly presentationBySlot = new Map<string, PanelPresentationSnapshot>();
  private readonly documentRevisionBySlot = new Map<string, number>();
  private readonly crashHistoryBySlot = new Map<string, number[]>();
  private readonly bootEvidenceBySlot = new Map<
    string,
    { webContentsId: number; observation: PanelBootObservation }
  >();
  private presentationRevision = 0;
  private currentViewRevision = 0;
  private readonly panelRuntime = createTypedServiceClient(
    "panelRuntime",
    panelRuntimeMethods,
    (service, method, args) => this.deps.callServer(service, method, args)
  );

  constructor(private readonly deps: PanelPresentationControllerDeps) {
    this.clientPlatform = deps.client.platform ?? "desktop";
    this.clientSessionId = deps.client.clientSessionId ?? `${this.clientPlatform}-${randomUUID()}`;
    this.clientLabel =
      deps.client.label ?? (this.clientPlatform === "headless" ? "Headless" : "Desktop");
    this.clientSupportsCdp = deps.client.supportsCdp ?? this.clientPlatform !== "mobile";
    this.loadOnLeaseAssignment = deps.client.loadOnLeaseAssignment ?? false;

    const headlessAutoload = this.clientPlatform === "headless" && this.loadOnLeaseAssignment;
    this.resources = new PanelResourcePolicy({
      tracksAssignedResources: this.loadOnLeaseAssignment,
      maximumLoadedPanels:
        deps.client.maxAssignedPanelViews ??
        (headlessAutoload ? PANEL_UI_MAX_LOADED_HEADLESS : null),
      idleUnloadMs:
        deps.client.uiIdleUnloadMs ?? (headlessAutoload ? PANEL_UI_IDLE_UNLOAD_MS_HEADLESS : null),
      idleSweepIntervalMs:
        deps.client.uiIdleSweepMs ??
        (this.clientPlatform === "headless"
          ? PANEL_UI_IDLE_SWEEP_MS_HEADLESS
          : PANEL_UI_IDLE_SWEEP_MS),
      now: () => Date.now(),
      getFocusedPanelId: () => this.deps.registry.getFocusedPanelId(),
      getResidentPanelIds: () => this.deps.getResidentPanelIds?.() ?? [],
      hasRetentionIntent: (panelId) => this.deps.hasRetentionIntent?.(panelId) ?? false,
      isKeepLoaded: (panelId) => Boolean(this.deps.registry.getRuntimeLease(panelId)?.keepLoaded),
      panelExists: (panelId) => Boolean(this.deps.registry.getPanel(panelId)),
      unload: async (panelId) => {
        this.unloadPanel(panelId);
        this.deps.registry.notifyPanelTreeUpdate(panelId);
      },
      reportUnloadError: (panelId, reason, error) => {
        log.warn(
          `[assignedPanelResource] Failed to unload ${panelId} after ${reason}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      },
    });
  }

  get sessionId(): string {
    return this.clientSessionId;
  }

  get registration(): PanelHostRegistration {
    return createPanelHostRegistration({
      clientSessionId: this.clientSessionId,
      label: this.clientLabel,
      platform: this.clientPlatform,
      supportsCdp: this.clientSupportsCdp,
      loadOnLeaseAssignment: this.loadOnLeaseAssignment,
    });
  }

  get viewRevision(): number {
    return this.currentViewRevision;
  }

  getPresentation(panelId: string): PanelPresentationSnapshot {
    return (
      this.presentationBySlot.get(panelId) ?? {
        revision: this.presentationRevision,
        presentation: { state: "idle", slotId: panelId },
      }
    );
  }

  private publish(presentation: PanelPresentation): PanelPresentationSnapshot {
    const snapshot = { revision: ++this.presentationRevision, presentation };
    this.presentationBySlot.set(presentation.slotId, snapshot);
    this.deps.publishPresentation?.(snapshot);
    return snapshot;
  }

  private setAttemptStage(attempt: PresentationAttempt, stage: PanelPresentationStage): void {
    if (this.attemptBySlot.get(attempt.slotId) !== attempt || attempt.status !== "active") {
      return;
    }
    attempt.stage = stage;
    this.publish({
      state: "loading",
      slotId: attempt.slotId,
      attemptId: attempt.attemptId,
      stage,
      enteredAt: Date.now(),
    });
  }

  private createAttempt(
    panelId: string,
    targetKey: string,
    stage: PanelPresentationStage
  ): PresentationAttempt {
    let resolve!: (result: PresentationAttemptResult) => void;
    const completion = new Promise<PresentationAttemptResult>((settle) => {
      resolve = settle;
    });
    const attempt: PresentationAttempt = {
      token: {},
      slotId: panelId,
      attemptId: randomUUID(),
      targetKey,
      status: "active",
      stage,
      completion,
      resolve,
    };
    const previous = this.attemptBySlot.get(panelId);
    this.attemptBySlot.set(panelId, attempt);
    const retainedConnection = this.connectionBySlot.get(panelId);
    if (retainedConnection) retainedConnection.ownerToken = attempt.token;
    if (previous?.status === "active") {
      previous.status = "cancelled";
      previous.resolve({ state: "cancelled", slotId: panelId, attemptId: previous.attemptId });
    }
    this.publish({
      state: "loading",
      slotId: panelId,
      attemptId: attempt.attemptId,
      stage,
      enteredAt: Date.now(),
    });
    return attempt;
  }

  private isCurrent(panelId: string, attempt: PresentationAttempt): boolean {
    return this.attemptBySlot.get(panelId) === attempt && attempt.status === "active";
  }

  private trackProgress(panelId: string, progress: Promise<void>): void {
    this.progressBySlot.set(panelId, progress);
    const clear = () => {
      if (this.progressBySlot.get(panelId) === progress) this.progressBySlot.delete(panelId);
    };
    void progress.then(clear, clear);
  }

  private settleAttempt(
    attempt: PresentationAttempt,
    presentation: Extract<PanelPresentation, { state: "ready" | "unavailable" | "failed" }>
  ): void {
    const panelId = attempt.slotId;
    if (!this.isCurrent(panelId, attempt)) return;
    attempt.status =
      presentation.state === "ready"
        ? "ready"
        : presentation.state === "unavailable"
          ? "unavailable"
          : presentation.state === "failed"
            ? "failed"
            : "cancelled";
    this.publish(presentation);
    attempt.resolve(presentation);
  }

  recordViewMutation(): number {
    this.currentViewRevision += 1;
    return this.currentViewRevision;
  }

  getConnection(panelId: string): { runtimeEntityId: string; connectionId: string } | undefined {
    return this.connectionBySlot.get(panelId);
  }

  isTitleExplicit(panelId: string): boolean {
    return this.explicitTitlePanelIds.has(panelId);
  }

  refreshActivity(panelId: string): void {
    this.resources.refreshActivity(panelId);
  }

  getBuildRevision(source: string, ref?: string): number | undefined {
    return this.deps.panelHttpServer.getBuildRevision?.(source, ref);
  }

  /** Publish a native view transition to the canonical server observation. */
  async reportPanelViewTransition(panelId: string): Promise<void> {
    const connection = this.connectionBySlot.get(panelId);
    const contents = this.deps.getPanelView()?.getWebContents(panelId) as
      | { id: number; isDestroyed(): boolean; getURL(): string; isLoading(): boolean }
      | null
      | undefined;
    if (!connection || !contents || contents.isDestroyed()) return;
    const boot = this.deps.cdpHost.getBootObservation
      ? await this.deps.cdpHost.getBootObservation(panelId).catch((error: unknown) => {
          log.warn(
            `[reportPanelViewTransition] Boot probe failed for ${panelId}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          return { kind: "unavailable" as const };
        })
      : ({ kind: "unavailable" } as const);
    if (this.connectionBySlot.get(panelId) !== connection) return;
    await this.panelRuntime.reportView(
      asPanelEntityId(connection.runtimeEntityId),
      connection.connectionId,
      {
        url: contents.getURL(),
        loading: contents.isLoading(),
        boot,
      }
    );
  }

  /**
   * Advance external-document identity at the one authoritative boundary:
   * Electron's main-frame commit event. Network load start/stop events are not
   * document identity and must never bump this revision.
   */
  handleExternalDocumentCommitted(panelId: string, url: string): boolean {
    const current = this.getPresentation(panelId).presentation;
    const binding = this.deps.getNativeBinding?.(panelId);
    const contents = this.deps.getPanelView()?.getWebContents(panelId) as
      | { id?: unknown; isDestroyed?: () => boolean; getURL?: () => string }
      | null
      | undefined;
    if (
      current.state !== "ready" ||
      current.surface !== "external" ||
      !binding ||
      !contents ||
      contents.isDestroyed?.() ||
      typeof contents.id !== "number"
    ) {
      return false;
    }
    if (current.url === url) return false;
    const documentRevision =
      (this.documentRevisionBySlot.get(panelId) ?? current.documentRevision) + 1;
    this.documentRevisionBySlot.set(panelId, documentRevision);
    this.createAttempt(
      panelId,
      `${current.runtimeEntityId}|document:${documentRevision}|${url}`,
      "resolving"
    );
    return true;
  }

  handlePanelBoot(panelId: string, webContentsId: number, observation: PanelBootObservation): void {
    const attempt = this.attemptBySlot.get(panelId);
    const connection = this.connectionBySlot.get(panelId);
    const contents = this.deps.getPanelView()?.getWebContents(panelId) as
      | { id?: unknown; isDestroyed?: () => boolean }
      | null
      | undefined;
    if (
      !attempt ||
      attempt.status !== "active" ||
      !connection ||
      !contents ||
      contents.isDestroyed?.() ||
      contents.id !== webContentsId ||
      observation.runtimeEntityId !== connection.runtimeEntityId
    ) {
      return;
    }
    this.bootEvidenceBySlot.set(panelId, { webContentsId, observation });
    if (observation.phase === "ready") {
      if (attempt.stage === "booting" || attempt.stage === "waiting-for-slot") {
        this.publishReadyIfAttached(panelId, attempt);
      }
    } else if (observation.phase === "failed") {
      this.settleAttempt(attempt, {
        state: "failed",
        slotId: panelId,
        attemptId: attempt.attemptId,
        stage: "booting",
        code: "renderer_boot_failed",
        message: observation.message ?? "Panel renderer failed during boot.",
        enteredAt: Date.now(),
      });
    } else {
      this.setAttemptStage(attempt, "booting");
    }
  }

  /** Revoke a ready claim as soon as its shell-owned native slot disappears. */
  handleNativeSlotCleared(panelId: string): void {
    const current = this.getPresentation(panelId).presentation;
    if (current.state !== "ready") return;
    if (this.deps.getNativeBinding?.(panelId)) return;
    const panel = this.deps.registry.getPanel(panelId);
    if (!panel || !this.deps.getPanelView()?.hasView(panelId)) {
      this.attemptBySlot.delete(panelId);
      this.publish({ state: "idle", slotId: panelId });
      return;
    }
    this.createAttempt(panelId, this.targetKeyFor(panel), "waiting-for-slot");
  }

  async registerClient(): Promise<void> {
    await this.ensureClientRegistered();
    this.resources.start();
    await this.repairLeasesForExistingViews();
  }

  /**
   * Re-establish process-local registration after the server transport has
   * recovered. The remote coordinator may be a fresh process even though this
   * controller and its renderers survived, so the local registration cache is
   * not evidence about remote state.
   */
  async recoverClientRegistration(): Promise<void> {
    await this.panelRuntime.registerClient(this.registration);
    this.clientRegistered = true;
  }

  async unregisterClient(): Promise<void> {
    this.resources.stop();
    if (!this.clientRegistered) return;
    this.clientRegistered = false;
    await this.panelRuntime.unregisterClient(this.clientSessionId);
  }

  async syncLeaseSnapshot(): Promise<void> {
    const snapshot = await this.panelRuntime.getSnapshot();
    this.deps.registry.applyRuntimeLeaseSnapshot(snapshot);
    if (!this.loadOnLeaseAssignment) return;
    for (const lease of snapshot.leases) {
      if (lease.clientSessionId !== this.clientSessionId || !lease.loadOnLeaseAssignment) continue;
      this.connectionBySlot.set(lease.slotId, {
        runtimeEntityId: lease.runtimeEntityId,
        connectionId: lease.connectionId,
      });
      await this.deps.shellCore.refreshPanel(asPanelSlotId(lease.slotId));
      void this.present(lease.slotId, "acquire", false, lease);
      await this.progressBySlot.get(lease.slotId);
    }
  }

  async repairLeasesForExistingViews(): Promise<void> {
    const view = this.deps.getPanelView();
    if (!view) return;
    for (const { panelId } of this.deps.registry.listPanels()) {
      if (!view.hasView(panelId)) continue;
      try {
        await this.ensureLeaseForExistingView(panelId);
      } catch (error) {
        log.warn(
          `[repairRuntimeLeasesForExistingViews] Failed to repair ${panelId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }

  applyServerPanelTitleUpdate(update: {
    panelId: string;
    title: string | null;
    explicit?: boolean;
  }): Promise<void> {
    const panel = this.deps.registry.getPanel(update.panelId);
    if (!panel) return Promise.resolve();
    if (!update.explicit && this.explicitTitlePanelIds.has(update.panelId)) {
      return Promise.resolve();
    }
    if (update.title === null) {
      if (update.explicit) this.explicitTitlePanelIds.delete(update.panelId);
      return this.deps.shellCore
        .refreshSlotEntity(asPanelSlotId(update.panelId))
        .then(() => undefined);
    }
    if (update.explicit) this.explicitTitlePanelIds.add(update.panelId);
    if (panel.title !== update.title) this.deps.registry.updateTitle(update.panelId, update.title);
    return Promise.resolve();
  }

  async handleLeaseChanged(event: PanelRuntimeLeaseChangedEvent): Promise<void> {
    const slotId = event.slotId;
    if (!slotId) return;
    this.deps.registry.applyRuntimeLeaseChanged(event);
    this.deps.eventService.emit("panel:runtimeLeaseChanged", event);
    const currentLease = this.connectionBySlot.get(slotId);
    const previousWasOurs = event.previous?.clientSessionId === this.clientSessionId;
    const trackedLeaseMatches =
      !currentLease ||
      (event.previous?.runtimeEntityId === currentLease.runtimeEntityId &&
        event.previous.connectionId === currentLease.connectionId);
    const lostOwnedLease =
      previousWasOurs &&
      trackedLeaseMatches &&
      event.next?.connectionId !== event.previous?.connectionId;
    if (lostOwnedLease) {
      const currentEntityId = await this.deps.shellCore
        .refreshSlotEntity(asPanelSlotId(slotId))
        .catch(() => null);
      if (currentEntityId && currentEntityId !== event.previous?.runtimeEntityId) return;
      // Residency is shell-owned presentation demand, which exists before a
      // native binding can commit. Using attachment as the recovery predicate
      // turns a normal next:null lease event during startup into an unload and
      // leaves the declared pane permanently idle.
      const resident =
        this.deps.getResidentPanelIds?.().includes(slotId) ??
        Boolean(this.deps.getNativeBinding?.(slotId));
      this.deps.sendPanelEvent(slotId, "runtime:connection-error", {
        code: 4001,
        reason: "This panel's runtime moved to another device.",
        source: "server",
      });
      this.clearLocalPanelRuntime(slotId);
      this.markUnloadedArtifacts(slotId);
      if (event.next) {
        const attempt = this.createAttempt(slotId, event.next.runtimeEntityId, "leasing");
        this.settleAttempt(attempt, {
          state: "unavailable",
          slotId,
          attemptId: attempt.attemptId,
          reason: "leased-elsewhere",
          lease: summarizePresentationLease(event.next),
          enteredAt: Date.now(),
        });
      } else if (resident && this.deps.registry.getPanel(slotId)) {
        void this.present(slotId, "acquire", true).catch((error) => {
          log.warn(
            `[handleLeaseChanged] Failed to recover ${slotId}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        });
      } else {
        this.attemptBySlot.delete(slotId);
        this.publish({ state: "idle", slotId });
      }
      return;
    }
    if (event.next?.clientSessionId !== this.clientSessionId) return;
    const activeAttempt = this.attemptBySlot.get(slotId);
    this.connectionBySlot.set(slotId, {
      runtimeEntityId: event.next.runtimeEntityId,
      connectionId: event.next.connectionId,
      ...(activeAttempt?.status === "active" ? { ownerToken: activeAttempt.token } : {}),
    });
    if (this.loadOnLeaseAssignment) {
      await this.deps.shellCore.refreshPanel(asPanelSlotId(slotId));
      void this.present(slotId, "acquire", false, event.next);
      await this.progressBySlot.get(slotId);
    }
  }

  ensureStateArgsPush(panelId: string): void {
    if (this.stateArgsPushUnsubs.has(panelId)) return;
    this.stateArgsPushUnsubs.set(
      panelId,
      this.deps.shellCore.onStateArgsChanged(asPanelSlotId(panelId), (stateArgs) => {
        this.deps.sendPanelEvent(panelId, "runtime:stateArgsChanged", stateArgs);
      })
    );
  }

  recordPanelViewFailure(panelId: string, message: string): void {
    const panel = this.deps.registry.getPanel(panelId);
    if (!panel) return;
    this.deps.registry.updateArtifacts(panelId, {
      ...panel.artifacts,
      // A failed materialization has no live view. Never leave the previous
      // incarnation's URL/identity behind as contradictory readiness state.
      htmlPath: undefined,
      hostedRuntimeEntityId: undefined,
      viewFailure: {
        code: "navigation_failed",
        message,
      },
    });
    this.deps.registry.notifyPanelTreeUpdate(panelId);
    const current = this.attemptBySlot.get(panelId);
    if (current?.status === "active") {
      this.settleAttempt(current, {
        state: "failed",
        slotId: panelId,
        attemptId: current.attemptId,
        stage: current.stage,
        code: "view_failure",
        message,
        enteredAt: Date.now(),
      });
    }
  }

  recordPanelPreparationFailure(panelId: string, message: string): void {
    const current = this.attemptBySlot.get(panelId);
    if (!current || current.status !== "active") return;
    this.settleAttempt(current, {
      state: "failed",
      slotId: panelId,
      attemptId: current.attemptId,
      stage: current.stage,
      code: "preparation_failed",
      message,
      enteredAt: Date.now(),
    });
  }

  async loadPanelIntoView(
    panelId: string,
    leaseMode: "acquire" | "takeOver" = "acquire",
    force = leaseMode === "takeOver"
  ): Promise<void> {
    const panel = this.deps.registry.getPanel(panelId);
    if (!panel) throw new Error(`Panel not found: ${panelId}`);
    void this.present(panelId, leaseMode, force);
    await this.progressBySlot.get(panelId);
    const presentation = this.getPresentation(panelId).presentation;
    if (presentation.state === "failed") throw new Error(presentation.message);
    if (presentation.state === "unavailable") {
      throw new Error(formatPanelRuntimeLeaseDeniedMessage(panelId, presentation.lease));
    }
  }

  async reloadPanelView(panelId: string): Promise<boolean> {
    const panel = this.deps.registry.getPanel(panelId);
    if (!panel) throw new Error(`Panel not found: ${panelId}`);
    const view = this.deps.getPanelView();
    if (!view?.hasView(panelId)) {
      await this.loadPanelIntoView(panelId, "acquire", true);
      return Boolean(view?.hasView(panelId));
    }

    const previousProgress = this.progressBySlot.get(panelId);
    const attempt = this.createAttempt(panelId, this.targetKeyFor(panel), "navigating");
    if (!panel.snapshot.source.startsWith("browser:")) this.bootEvidenceBySlot.delete(panelId);
    const progress = (async () => {
      await previousProgress?.catch(() => undefined);
      if (!this.isCurrent(panelId, attempt)) return;
      try {
        const reloaded = await view.reloadView(panelId);
        if (!this.isCurrent(panelId, attempt)) return;
        if (reloaded) {
          this.publishReadyIfAttached(panelId, attempt);
          return;
        }
      } catch (error) {
        if (!this.isCurrent(panelId, attempt)) return;
        log.warn(
          `[reloadPanelView] Reload failed for ${panelId}; recreating: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }

      if (!this.isCurrent(panelId, attempt)) return;
      if (view.hasView(panelId)) {
        view.destroyView(panelId);
        this.recordViewMutation();
      }
      await this.runPresentationAttempt(attempt, getCurrentSnapshot(panel), "acquire");
    })();
    this.trackProgress(panelId, progress);
    const result = await attempt.completion;
    return result.state === "ready";
  }

  async present(
    panelId: string,
    leaseMode: "acquire" | "takeOver" = "acquire",
    force = false,
    ownedLease?: PanelRuntimeLease
  ): Promise<PresentationAttemptResult> {
    const panel = this.deps.registry.getPanel(panelId);
    if (!panel) throw new Error(`Panel not found: ${panelId}`);
    const targetKey = this.targetKeyFor(panel, ownedLease?.runtimeEntityId);
    const currentAttempt = this.attemptBySlot.get(panelId);
    const currentSnapshot = this.getPresentation(panelId).presentation;
    if (!force && currentAttempt?.status === "active" && currentAttempt.targetKey === targetKey) {
      return currentAttempt.completion;
    }
    if (
      !force &&
      currentAttempt?.targetKey === targetKey &&
      (currentSnapshot.state === "ready" ||
        currentSnapshot.state === "unavailable" ||
        currentSnapshot.state === "failed")
    ) {
      return currentSnapshot;
    }

    const previousProgress = this.progressBySlot.get(panelId);
    const attempt = this.createAttempt(panelId, targetKey, "resolving");
    const progress = (async () => {
      await previousProgress?.catch(() => undefined);
      if (!this.isCurrent(panelId, attempt)) return;
      await this.runPresentationAttempt(
        attempt,
        getCurrentSnapshot(panel),
        leaseMode,
        Boolean(ownedLease)
      );
    })();
    this.trackProgress(panelId, progress);
    return attempt.completion;
  }

  private targetKeyFor(
    panel: Panel,
    runtimeEntityId = panel.runtimeEntityId ?? "preparing"
  ): string {
    return `${runtimeEntityId}|${panel.buildKey ?? ""}|${panel.snapshot.source}`;
  }

  private async runPresentationAttempt(
    attempt: PresentationAttempt,
    snapshot: PanelSnapshot,
    leaseMode: "acquire" | "takeOver",
    reuseOwnedLease = false
  ): Promise<void> {
    try {
      this.setAttemptStage(attempt, "leasing");
      await this.performLoadSnapshotIntoView(
        attempt.slotId,
        snapshot,
        leaseMode,
        attempt,
        reuseOwnedLease
      );
      if (!this.isCurrent(attempt.slotId, attempt)) return;
      if (!this.deps.getPanelView()?.hasView(attempt.slotId)) {
        this.setAttemptStage(attempt, "booting");
        return;
      }
      const panel = this.deps.registry.getPanel(attempt.slotId);
      if (panel && !panel.snapshot.source.startsWith("browser:")) {
        this.setAttemptStage(attempt, "booting");
        if (!this.deps.cdpHost.getBootObservation) {
          this.publishReadyIfAttached(attempt.slotId, attempt);
          return;
        }
        const contents = this.deps.getPanelView()?.getWebContents(attempt.slotId) as
          | { id?: unknown }
          | null
          | undefined;
        const evidence = this.bootEvidenceBySlot.get(attempt.slotId);
        if (
          evidence &&
          evidence.webContentsId === contents?.id &&
          evidence.observation.phase === "ready"
        ) {
          this.publishReadyIfAttached(attempt.slotId, attempt);
          return;
        }
        const boot = await this.deps.cdpHost
          .getBootObservation(attempt.slotId)
          .catch(() => ({ kind: "unavailable" as const }));
        if (!this.isCurrent(attempt.slotId, attempt)) return;
        if (boot.kind === "observed" && typeof contents?.id === "number") {
          this.handlePanelBoot(attempt.slotId, contents.id, boot.observation);
        }
        return;
      }
      this.publishReadyIfAttached(attempt.slotId, attempt);
    } catch (error) {
      if (!this.isCurrent(attempt.slotId, attempt)) return;
      if (error instanceof LeaseUnavailableError) {
        this.settleAttempt(attempt, {
          state: "unavailable",
          slotId: attempt.slotId,
          attemptId: attempt.attemptId,
          reason: "leased-elsewhere",
          lease: summarizePresentationLease(error.lease),
          enteredAt: Date.now(),
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const lease = this.deps.registry.getRuntimeLease(attempt.slotId);
      if (lease?.clientSessionId === this.clientSessionId) {
        await this.reportPanelMaterializationFailure(attempt.slotId, lease, message);
      }
      this.clearLocalPanelRuntime(attempt.slotId);
      if (lease?.clientSessionId === this.clientSessionId) {
        await this.panelRuntime
          .release(lease.runtimeEntityId, lease.connectionId)
          .catch((releaseError) => {
            log.warn(
              `[runPresentationAttempt] Failed to release failed ${attempt.slotId}: ${
                releaseError instanceof Error ? releaseError.message : String(releaseError)
              }`
            );
          });
      }
      this.recordPanelViewFailure(attempt.slotId, message);
      if (!this.isCurrent(attempt.slotId, attempt)) return;
      this.settleAttempt(attempt, {
        state: "failed",
        slotId: attempt.slotId,
        attemptId: attempt.attemptId,
        stage: attempt.stage,
        code: "presentation_failed",
        message,
        enteredAt: Date.now(),
      });
    }
  }

  private publishReadyIfAttached(panelId: string, attempt = this.attemptBySlot.get(panelId)): void {
    if (!attempt || !this.isCurrent(panelId, attempt)) return;
    const view = this.deps.getPanelView();
    const contents = view?.getWebContents(panelId) as
      | { id?: unknown; isDestroyed?: () => boolean; getURL?: () => string }
      | null
      | undefined;
    if (!view?.hasView(panelId) || !contents || contents.isDestroyed?.()) return;
    const connection = this.connectionBySlot.get(panelId);
    if (!connection || typeof contents.id !== "number") {
      // Native attachment is the commit point, not a speculative step. A view
      // can outlive its lease during replacement or transport recovery; never
      // attach it while its retained runtime connection is absent. Install a
      // fresh attempt so lease acquisition and attachment run as one ordered
      // transaction.
      void this.present(panelId, "acquire", true).catch((error) => {
        log.warn(
          `[publishReadyIfAttached] Failed to recover presentation authority for ${panelId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
      return;
    }
    const panel = this.deps.registry.getPanel(panelId);
    if (
      panel &&
      !panel.snapshot.source.startsWith("browser:") &&
      this.deps.cdpHost.getBootObservation
    ) {
      const evidence = this.bootEvidenceBySlot.get(panelId);
      if (
        evidence?.webContentsId !== contents.id ||
        evidence.observation.phase !== "ready" ||
        evidence.observation.runtimeEntityId !== connection.runtimeEntityId
      ) {
        this.setAttemptStage(attempt, "booting");
        return;
      }
    }
    const binding = this.deps.attachNativeBinding
      ? this.deps.attachNativeBinding(panelId)
      : this.deps.getNativeBinding
        ? this.deps.getNativeBinding(panelId)
        : { nativeSlotId: "headless" };
    if (!binding) {
      this.setAttemptStage(attempt, "waiting-for-slot");
      return;
    }
    this.setAttemptStage(attempt, "attaching");
    const documentRevision = (this.documentRevisionBySlot.get(panelId) ?? 0) + 1;
    this.documentRevisionBySlot.set(panelId, documentRevision);
    this.settleAttempt(attempt, {
      state: "ready",
      slotId: panelId,
      attemptId: attempt.attemptId,
      surface: panel?.snapshot.source.startsWith("browser:") ? "external" : "code",
      runtimeEntityId: connection.runtimeEntityId,
      webContentsId: contents.id,
      nativeSlotId: binding.nativeSlotId,
      documentRevision,
      url: contents.getURL?.() ?? "",
      enteredAt: Date.now(),
    });
  }

  onNativeSlotDeclared(panelId: string): void {
    const attempt = this.attemptBySlot.get(panelId);
    if (attempt?.status === "active") {
      // A declaration may race lease acquisition or navigation while an old
      // WebContents still exists. Only the post-navigation waiting stage may
      // use the declaration to complete attachment; every earlier stage will
      // attach from runPresentationAttempt after its own view work finishes.
      if (attempt.stage === "waiting-for-slot") this.publishReadyIfAttached(panelId, attempt);
      return;
    }
    const presentation = this.presentationBySlot.get(panelId)?.presentation;
    const view = this.deps.getPanelView();
    const contents = view?.getWebContents(panelId) as
      | { id?: unknown; isDestroyed?: () => boolean; getURL?: () => string }
      | null
      | undefined;
    const connection = this.connectionBySlot.get(panelId);
    if (
      presentation?.state === "ready" &&
      view?.hasView(panelId) &&
      contents &&
      !contents.isDestroyed?.() &&
      connection &&
      typeof contents.id === "number"
    ) {
      const activeBinding = this.deps.getNativeBinding?.(panelId);
      if (activeBinding?.nativeSlotId === presentation.nativeSlotId) return;
      const binding = this.deps.attachNativeBinding?.(panelId);
      if (binding) {
        this.publish({
          ...presentation,
          runtimeEntityId: connection.runtimeEntityId,
          webContentsId: contents.id,
          nativeSlotId: binding.nativeSlotId,
          url: contents.getURL?.() ?? presentation.url,
          enteredAt: Date.now(),
        });
        return;
      }
    }
    if (view?.hasView(panelId)) {
      void this.present(panelId, "acquire", true).catch((error) => {
        log.warn(`[onNativeSlotDeclared] Failed to present ${panelId}: ${String(error)}`);
      });
      return;
    }
    void this.present(panelId).catch((error) => {
      log.warn(`[onNativeSlotDeclared] Failed to materialize ${panelId}: ${String(error)}`);
    });
  }

  handleViewCrash(panelId: string, reason: string): Promise<void> {
    const panel = this.deps.registry.getPanel(panelId);
    if (!panel) return Promise.resolve();
    const now = Date.now();
    const crashes = (this.crashHistoryBySlot.get(panelId) ?? []).filter(
      (timestamp) => now - timestamp < 60_000
    );
    crashes.push(now);
    this.crashHistoryBySlot.set(panelId, crashes);
    const previousProgress = this.progressBySlot.get(panelId);
    const attempt = this.createAttempt(
      panelId,
      `${panel.runtimeEntityId ?? "recovering"}|${panel.snapshot.source}`,
      "recovering"
    );
    if (!panel.snapshot.source.startsWith("browser:")) this.bootEvidenceBySlot.delete(panelId);
    if (crashes.length > 3) {
      this.settleAttempt(attempt, {
        state: "failed",
        slotId: panelId,
        attemptId: attempt.attemptId,
        stage: "recovering",
        code: "renderer_crash_loop",
        message: `Panel renderer crashed repeatedly (last reason: ${reason}).`,
        enteredAt: now,
      });
      return Promise.resolve();
    }
    const progress = (async () => {
      await previousProgress?.catch(() => undefined);
      if (!this.isCurrent(panelId, attempt)) return;
      const view = this.deps.getPanelView();
      try {
        const reloaded = view?.hasView(panelId) ? await view.reloadView(panelId) : false;
        if (!this.isCurrent(panelId, attempt)) return;
        if (reloaded) {
          this.publishReadyIfAttached(panelId, attempt);
          return;
        }
        if (view?.hasView(panelId)) {
          view.destroyView(panelId);
          this.recordViewMutation();
        }
        await this.runPresentationAttempt(attempt, getCurrentSnapshot(panel), "acquire");
      } catch (error) {
        if (!this.isCurrent(panelId, attempt)) return;
        this.settleAttempt(attempt, {
          state: "failed",
          slotId: panelId,
          attemptId: attempt.attemptId,
          stage: "recovering",
          code: "renderer_crashed",
          message: `Panel renderer crashed (${reason}): ${error instanceof Error ? error.message : String(error)}`,
          enteredAt: Date.now(),
        });
      }
    })();
    this.trackProgress(panelId, progress);
    return progress;
  }

  private async performLoadSnapshotIntoView(
    panelId: string,
    snapshot: PanelSnapshot,
    leaseMode: "acquire" | "takeOver" = "acquire",
    attempt?: PresentationAttempt,
    reuseOwnedLease = false
  ): Promise<void> {
    const view = this.deps.getPanelView();
    if (!view) return;
    const panel = this.deps.registry.getPanel(panelId);
    if (!panel) throw new Error(`Panel not found: ${panelId}`);
    const browserPartition = snapshot.source.startsWith("browser:")
      ? await this.deps.waitForBrowserSessionPartition()
      : undefined;
    if (attempt && !this.isCurrent(panelId, attempt)) {
      if (this.getPresentation(panelId).presentation.state === "idle") {
        this.markUnloadedArtifacts(panelId);
      }
      return;
    }
    this.destroyViewIfPartitionChanged(view, panelId, snapshot, browserPartition);
    const desiredRuntimeEntityId = await this.deps.shellCore.getCurrentEntityId(
      asPanelSlotId(panelId)
    );
    const ownedLease = this.connectionBySlot.get(panelId);
    if (!reuseOwnedLease && ownedLease?.runtimeEntityId !== desiredRuntimeEntityId) {
      await this.acquireRuntimeLease(panelId, leaseMode, attempt?.token, desiredRuntimeEntityId);
    }
    if (attempt && !this.isCurrent(panelId, attempt)) {
      this.cleanupAttemptLease(attempt);
      return;
    }
    if (attempt) this.setAttemptStage(attempt, "creating-view");
    const connection = this.connectionBySlot.get(panelId);
    const retainedViewMatches =
      view.hasView(panelId) &&
      connection?.runtimeEntityId === desiredRuntimeEntityId &&
      panel.artifacts.hostedRuntimeEntityId === desiredRuntimeEntityId;
    if (retainedViewMatches) {
      if (!snapshot.source.startsWith("browser:")) view.updatePanelCodeIdentity(panelId);
      this.registerExistingCdpTarget(panelId);
      await this.reportPanelViewTransition(panelId);
      this.resources.track(panelId);
      await this.resources.enforceCap(panelId);
      return;
    }
    if (snapshot.source.startsWith("browser:")) {
      const url = snapshot.source.slice("browser:".length);
      if (!view.createViewForBrowser) {
        throw new Error("Panel host cannot create browser views");
      }
      if (attempt) this.setAttemptStage(attempt, "navigating");
      await view.createViewForBrowser(
        panelId,
        url,
        snapshot.contextId,
        assertPresent(browserPartition)
      );
      this.recordViewMutation();
      this.deps.registry.updateArtifacts(panelId, {
        buildState: "ready",
        htmlPath: url,
        hostedRuntimeEntityId:
          this.connectionBySlot.get(panelId)?.runtimeEntityId ?? panel.runtimeEntityId ?? undefined,
        viewFailure: undefined,
      });
      this.deps.registry.notifyPanelTreeUpdate(panelId);
      await this.reportPanelViewTransition(panelId);
      this.resources.track(panelId);
      await this.resources.enforceCap(panelId);
      return;
    }

    const preparedPanel = this.deps.registry.getPanel(panelId);
    if (!this.hasCompleteExecutionIdentity(preparedPanel)) {
      if (preparedPanel?.artifacts.buildState === "error") {
        throw new Error(
          preparedPanel.artifacts.error ??
            "Panel unavailable: its runtime image could not be prepared."
        );
      }
      this.resources.track(panelId);
      await this.resources.enforceCap(panelId);
      return;
    }

    const panelUrl = this.buildPanelUrl(panelId, snapshot);
    this.bootEvidenceBySlot.delete(panelId);
    if (attempt) this.setAttemptStage(attempt, "navigating");
    await view.createViewForPanel(panelId, panelUrl, snapshot.contextId);
    this.recordViewMutation();
    this.updateWorkspacePanelArtifacts(panelId, snapshot, panelUrl);
    await this.reportPanelViewTransition(panelId);
    this.resources.track(panelId);
    await this.resources.enforceCap(panelId);
  }

  async acquireRuntimeLease(
    panelId: string,
    leaseMode: "acquire" | "takeOver",
    ownerToken?: object,
    resolvedRuntimeEntityId?: string
  ): Promise<string> {
    await this.ensureClientRegistered();
    const runtimeEntityId =
      resolvedRuntimeEntityId ??
      (await this.deps.shellCore.getCurrentEntityId(asPanelSlotId(panelId)));
    const connectionId = `${this.clientPlatform}-${panelId}-${randomUUID()}`;
    const lease = createPanelRuntimeLeaseRequest({
      slotId: panelId,
      clientSessionId: this.clientSessionId,
      connectionId,
    });
    const result = await (leaseMode === "acquire"
      ? this.panelRuntime.acquire(runtimeEntityId, lease)
      : this.panelRuntime.takeOver(runtimeEntityId, lease));
    if (!result.acquired) {
      throw new LeaseUnavailableError(
        result.lease,
        formatPanelRuntimeLeaseDeniedMessage(panelId, result.lease)
      );
    }
    // Lease acquisition joins server-side execution activation. Rehydrate the
    // exact durable slot at that boundary so startup remains correct even when
    // executionActivated was published before this host connected.
    await this.deps.shellCore.refreshPanel(asPanelSlotId(panelId));
    // Acquire is idempotent when this host already owns the entity (notably
    // after an automatic replacement transfer). The returned lease is the
    // authority; the proposed connection id may never have been installed.
    this.connectionBySlot.set(panelId, {
      runtimeEntityId: result.lease.runtimeEntityId,
      connectionId: result.lease.connectionId,
      ...(ownerToken ? { ownerToken } : {}),
    });
    return result.lease.connectionId;
  }

  async ensureLeaseForExistingView(panelId: string): Promise<void> {
    const view = this.deps.getPanelView();
    if (!view?.hasView(panelId)) return;
    const lease = this.deps.registry.getRuntimeLease(panelId);
    let ownedLease: PanelRuntimeLease | undefined;
    if (lease?.clientSessionId === this.clientSessionId) {
      ownedLease = lease;
      this.connectionBySlot.set(panelId, {
        runtimeEntityId: lease.runtimeEntityId,
        connectionId: lease.connectionId,
      });
      this.registerExistingCdpTarget(panelId);
    } else {
      const current = this.connectionBySlot.get(panelId);
      const runtimeEntityId = await this.deps.shellCore.getCurrentEntityId(asPanelSlotId(panelId));
      if (
        current?.runtimeEntityId === runtimeEntityId &&
        lease?.connectionId === current.connectionId
      ) {
        this.registerExistingCdpTarget(panelId);
      } else {
        await this.acquireRuntimeLease(panelId, "acquire");
        this.registerExistingCdpTarget(panelId);
      }
    }
    void this.present(panelId, "acquire", true, ownedLease);
    await this.progressBySlot.get(panelId);
    const presentation = this.getPresentation(panelId).presentation;
    if (presentation.state === "failed") throw new Error(presentation.message);
    if (presentation.state === "unavailable") {
      throw new Error(formatPanelRuntimeLeaseDeniedMessage(panelId, presentation.lease));
    }
  }

  private clearLocalPanelRuntime(panelId: string): void {
    this.resources.clear(panelId);
    this.bootEvidenceBySlot.delete(panelId);
    this.connectionBySlot.delete(panelId);
    this.deps.cdpHost.cleanupPanelAccess(panelId);
    this.deps.cdpHost.unregisterTarget?.(panelId);
    const view = this.deps.getPanelView();
    if (view?.hasView(panelId)) {
      view.destroyView(panelId);
      this.recordViewMutation();
    }
  }

  private cleanupAttemptLease(attempt: PresentationAttempt): void {
    const connection = this.connectionBySlot.get(attempt.slotId);
    if (!connection || connection.ownerToken !== attempt.token) return;
    this.connectionBySlot.delete(attempt.slotId);
    void this.panelRuntime
      .release(connection.runtimeEntityId, connection.connectionId)
      .catch((error) => {
        log.warn(
          `[cleanupAttemptLease] Failed to release stale ${attempt.slotId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
  }

  releaseLocalPanelRuntime(panelId: string, _transition: PanelRuntimeReleaseTransition): void {
    const lease = this.connectionBySlot.get(panelId);
    this.clearLocalPanelRuntime(panelId);
    const attempt = this.attemptBySlot.get(panelId);
    if (attempt?.status === "active") {
      attempt.status = "cancelled";
      attempt.resolve({ state: "cancelled", slotId: panelId, attemptId: attempt.attemptId });
    }
    this.attemptBySlot.delete(panelId);
    this.crashHistoryBySlot.delete(panelId);
    this.publish({ state: "idle", slotId: panelId });
    if (lease) {
      void this.panelRuntime.release(lease.runtimeEntityId, lease.connectionId).catch((error) => {
        log.warn(
          `[releaseLocalPanelRuntime] Failed to release ${panelId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
    }
  }

  private async reportPanelMaterializationFailure(
    panelId: string,
    lease: PanelRuntimeLease,
    message: string
  ): Promise<boolean> {
    const current = this.connectionBySlot.get(panelId);
    if (
      !current ||
      current.runtimeEntityId !== lease.runtimeEntityId ||
      current.connectionId !== lease.connectionId
    ) {
      return false;
    }
    try {
      await this.panelRuntime.reportView(lease.runtimeEntityId, lease.connectionId, {
        url: "",
        loading: false,
        boot: { kind: "unavailable" },
        // Host-originated fact: the renderer never got far enough to report,
        // so this must not be flattened into a renderer boot failure.
        failure: {
          reporter: "host",
          failure: { stage: "navigation", code: "navigation_failed", message },
        },
      });
      return true;
    } catch (error) {
      log.warn(
        `[reportPanelMaterializationFailure] Failed to publish ${panelId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return false;
    }
  }

  unloadPanel(panelId: string, transition: "lease-transfer" | "unload" = "unload"): void {
    const panel = this.deps.registry.getPanel(panelId);
    if (!panel) return;
    this.releaseLocalPanelRuntime(panelId, transition);
    this.markUnloadedArtifacts(panelId);
  }

  private markUnloadedArtifacts(panelId: string): void {
    const panel = this.deps.registry.getPanel(panelId);
    if (!panel) return;
    this.deps.registry.updateArtifacts(panelId, {
      buildState: "pending",
      buildProgress: "Panel unloaded - will rebuild when focused",
    });
  }

  private updateWorkspacePanelArtifacts(
    panelId: string,
    snapshot: PanelSnapshot,
    panelUrl: string
  ): void {
    const panel = this.deps.registry.getPanel(panelId);
    if (!panel) return;

    // createViewForPanel resolves only after the requested URL has finished
    // loading. That observable load is the authoritative completion signal for
    // both cache hits and fresh builds; remote/local panel-server facades cannot
    // synchronously inspect the server's build cache. A build:error event may
    // have arrived while navigation was pending, so preserve it instead of
    // reporting a failed build as ready.
    if (panel.artifacts.buildState === "error") return;
    this.deps.registry.updateArtifacts(panelId, {
      ...panel.artifacts,
      htmlPath: panelUrl,
      hostedRuntimeEntityId:
        this.connectionBySlot.get(panelId)?.runtimeEntityId ?? panel.runtimeEntityId ?? undefined,
      buildState: "ready",
      buildRevision: this.getBuildRevision(snapshot.source, snapshot.options.ref),
      buildProgress: undefined,
      error: undefined,
      viewFailure: undefined,
    });
    this.deps.registry.notifyPanelTreeUpdate(panelId);
  }

  private hasCompleteExecutionIdentity(panel: Panel | null | undefined): boolean {
    return Boolean(
      panel?.buildKey &&
      /^[0-9a-f]{64}$/.test(panel.buildKey) &&
      panel.executionDigest &&
      /^[0-9a-f]{64}$/.test(panel.executionDigest) &&
      panel.authorityRequests
    );
  }

  hasExecutablePanel(panelId: string): boolean {
    const panel = this.deps.registry.getPanel(panelId);
    return Boolean(
      panel?.snapshot.source.startsWith("browser:") || this.hasCompleteExecutionIdentity(panel)
    );
  }

  private buildPanelUrl(panelId: string, snapshot: PanelSnapshot): string {
    const buildKey = this.deps.registry.getPanel(panelId)?.buildKey ?? null;
    return buildPanelUrl({
      source: snapshot.source,
      contextId: snapshot.contextId,
      buildKey,
      ref: snapshot.options.ref,
      gatewayPort: this.deps.gatewayPort,
      basePath: this.deps.gatewayBasePath,
    });
  }

  private destroyViewIfPartitionChanged(
    view: PanelViewLike,
    panelId: string,
    snapshot: PanelSnapshot,
    browserPartition?: string
  ): void {
    if (!view.hasView(panelId)) return;
    const target = snapshot.source.startsWith("browser:")
      ? assertPresent(browserPartition)
      : snapshot.contextId
        ? contextIdToPartition(snapshot.contextId)
        : undefined;
    if (view.getViewPartition(panelId) === target) return;
    view.destroyView(panelId);
    this.recordViewMutation();
  }

  private async ensureClientRegistered(): Promise<void> {
    if (this.clientRegistered) return;
    await this.panelRuntime.registerClient(this.registration);
    this.clientRegistered = true;
  }

  private registerExistingCdpTarget(panelId: string): void {
    const contents = this.deps.getPanelView()?.getWebContents(panelId) as
      | { id?: unknown; isDestroyed?: () => boolean }
      | null
      | undefined;
    if (!contents || typeof contents.id !== "number" || contents.isDestroyed?.()) return;
    this.deps.cdpHost.registerTarget?.(panelId, contents.id);
  }

}
