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
import { classifyRuntimeLeaseChange } from "@vibestudio/shared/panel/leaseTracker";
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
import type { PanelPinStoreApi } from "./panelPinStore.js";
import { PanelResourcePolicy } from "./panelResourcePolicy.js";
import type { PanelBootObservation } from "@vibestudio/shared/panel/observation";

const log = createDevLogger("PanelRuntimeLeaseController");

export interface PanelRuntimeLeaseControllerDeps {
  registry: PanelRegistry;
  eventService: EventService;
  shellCore: PanelManager;
  callServer: (service: string, method: string, args: unknown[]) => Promise<unknown>;
  getPanelView: () => PanelViewLike | null;
  cdpHost: {
    registerTarget?(panelId: string, contentsId: number): void;
    cleanupPanelAccess(panelId: string): void;
    unregisterTarget?(panelId: string): void;
    getBootObservation?(panelId: string): Promise<PanelBootObservation>;
  };
  panelHttpServer: PanelHttpServerLike;
  sendPanelEvent: (panelId: string, event: string, payload: unknown) => void;
  gatewayPort: number;
  gatewayBasePath?: string;
  waitForBrowserSessionPartition: () => Promise<string>;
  pinStore?: PanelPinStoreApi;
  /**
   * Panel ids currently bound to native slots (resident in the shell's
   * column viewport); the GC protects them alongside the focused panel (§5.3).
   * Absent on hosts without native slots (headless), where it is empty.
   */
  getResidentPanelIds?: () => string[];
  client: Partial<PanelHostRegistration> & {
    maxAssignedPanelViews?: number;
    uiIdleUnloadMs?: number;
    uiIdleSweepMs?: number;
  };
}

export type PanelRuntimeReleaseTransition = "close" | "invalidate" | "lease-transfer" | "unload";

/**
 * Owns the complete lifecycle of native panel views and their server leases.
 * Tree reconciliation lives here because applying an authoritative tree and
 * reconciling the corresponding views/leases is one atomic responsibility.
 */
export class PanelRuntimeLeaseController {
  private readonly clientSessionId: string;
  private readonly clientLabel: string;
  private readonly clientPlatform: "desktop" | "headless" | "mobile";
  private readonly clientSupportsCdp: boolean;
  private readonly loadOnLeaseAssignment: boolean;
  private readonly resources: PanelResourcePolicy;
  private clientRegistered = false;
  private readonly connectionBySlot = new Map<
    string,
    { runtimeEntityId: string; connectionId: string }
  >();
  private readonly stateArgsPushUnsubs = new Map<string, () => void>();
  /** Slots whose lease is being acquired by a local load operation. */
  private readonly locallyLoadingSlots = new Set<string>();
  private readonly assignedLeaseMaterializationBySlot = new Map<
    string,
    { connectionId: string; promise: Promise<void> }
  >();
  private readonly explicitTitlePanelIds = new Set<string>();
  private readonly preparedViewConvergenceBySlot = new Map<string, Promise<void>>();
  private currentViewRevision = 0;
  private readonly panelRuntime = createTypedServiceClient(
    "panelRuntime",
    panelRuntimeMethods,
    (service, method, args) => this.deps.callServer(service, method, args)
  );

  constructor(private readonly deps: PanelRuntimeLeaseControllerDeps) {
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
      isPinned: (panelId) => this.deps.pinStore?.has(panelId) ?? false,
      isKeepLoaded: (panelId) => Boolean(this.deps.registry.getRuntimeLease(panelId)?.keepLoaded),
      panelExists: (panelId) => Boolean(this.deps.registry.getPanel(panelId)),
      unload: async (panelId) => {
        this.unloadPanel(panelId);
        this.deps.registry.notifyPanelTreeUpdate();
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
      | { isDestroyed(): boolean; getURL(): string; isLoading(): boolean }
      | null
      | undefined;
    if (!connection || !contents || contents.isDestroyed()) return;
    const boot = this.deps.cdpHost.getBootObservation
      ? await this.deps.cdpHost
          .getBootObservation(panelId)
          .catch(() => ({ phase: "unavailable" as const }))
      : ({ phase: "unavailable" } as const);
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

  async registerClient(): Promise<void> {
    await this.ensureClientRegistered();
    this.resources.start();
    await this.repairLeasesForExistingViews();
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
      await this.materializeAssignedLease(lease.slotId, lease);
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
    const disposition = classifyRuntimeLeaseChange(this.clientSessionId, event);
    if (disposition.kind === "unassigned") {
      const currentLease = this.connectionBySlot.get(slotId);
      if (
        currentLease &&
        (currentLease.runtimeEntityId !== disposition.previous.runtimeEntityId ||
          currentLease.connectionId !== disposition.previous.connectionId)
      ) {
        return;
      }
      const currentEntityId = await this.deps.shellCore
        .refreshSlotEntity(asPanelSlotId(slotId))
        .catch(() => null);
      if (currentEntityId && currentEntityId !== disposition.previous.runtimeEntityId) return;
      this.deps.sendPanelEvent(slotId, "runtime:connection-error", {
        code: 4001,
        reason: "This panel's runtime moved to another device.",
        source: "server",
      });
      this.unloadPanelIfPresent(slotId, "lease-transfer");
      return;
    }

    if (disposition.kind !== "assigned") return;
    await this.materializeAssignedLease(slotId, disposition.lease);
  }

  private async materializeAssignedLease(slotId: string, lease: PanelRuntimeLease): Promise<void> {
    const active = this.assignedLeaseMaterializationBySlot.get(slotId);
    if (active) {
      await active.promise;
      const current = this.connectionBySlot.get(slotId);
      const panel = this.deps.registry.getPanel(slotId);
      const view = this.deps.getPanelView();
      if (
        current?.runtimeEntityId === lease.runtimeEntityId &&
        current.connectionId === lease.connectionId &&
        panel?.artifacts.hostedRuntimeEntityId === lease.runtimeEntityId &&
        view?.hasView(slotId)
      ) {
        return;
      }
      return this.materializeAssignedLease(slotId, lease);
    }

    const promise = this.materializeAssignedLeaseOnce(slotId, lease).finally(() => {
      if (this.assignedLeaseMaterializationBySlot.get(slotId)?.promise === promise) {
        this.assignedLeaseMaterializationBySlot.delete(slotId);
      }
    });
    this.assignedLeaseMaterializationBySlot.set(slotId, {
      connectionId: lease.connectionId,
      promise,
    });
    return promise;
  }

  private async materializeAssignedLeaseOnce(
    slotId: string,
    lease: PanelRuntimeLease
  ): Promise<void> {
    const view = this.deps.getPanelView();
    // A local load owns view creation from lease acquisition through commit.
    // The broadcast is still applied to the registry, but must not start a
    // parallel creator for the same view.
    if (this.locallyLoadingSlots.has(slotId)) {
      this.connectionBySlot.set(slotId, {
        runtimeEntityId: lease.runtimeEntityId,
        connectionId: lease.connectionId,
      });
      return;
    }
    const durablePanel = await this.deps.shellCore.refreshPanel(asPanelSlotId(slotId));
    if (!view) return;
    // Lease delivery and query-first tree hydration are independent streams.
    // Hydrate the exact slot before deciding whether its native view is current.
    const panel = this.deps.registry.getPanel(slotId) ?? durablePanel;
    if (!panel) return;
    const hostsCurrentEntity =
      view.hasView(slotId) && panel.artifacts.hostedRuntimeEntityId === lease.runtimeEntityId;
    if (hostsCurrentEntity) {
      this.connectionBySlot.set(slotId, {
        runtimeEntityId: lease.runtimeEntityId,
        connectionId: lease.connectionId,
      });
      this.registerExistingCdpTarget(slotId);
      this.resources.track(slotId);
      return;
    }

    try {
      await this.loadAssignedLeaseIntoView(slotId, getCurrentSnapshot(panel), lease);
      this.resources.track(slotId);
      await this.resources.enforceCap(slotId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = this.connectionBySlot.get(slotId);
      // An intentional unload or a newer lease can destroy the WebContents
      // while Electron's original loadURL promise is still settling. That
      // commonly rejects as ERR_FAILED; it belongs to the superseded
      // lifecycle and must not poison the durable panel with a load error.
      if (
        !current ||
        current.runtimeEntityId !== lease.runtimeEntityId ||
        current.connectionId !== lease.connectionId
      ) {
        return;
      }
      log.warn(`[handleRuntimeLeaseChanged] Failed to load assigned panel ${slotId}: ${message}`);
      const reported = await this.reportPanelMaterializationFailure(slotId, lease, message);
      // Keep the failed server lease when the host accepted the failure
      // report. That gives observers a terminal host state and lets the next
      // ensureSlot call replace this failed host incarnation. If the lease
      // itself disappeared while loading, use the ordinary local release.
      if (reported) this.clearLocalPanelRuntime(slotId);
      else this.releaseLocalPanelRuntime(slotId, "unload");
      this.recordPanelViewFailure(slotId, message);
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
    this.deps.registry.notifyPanelTreeUpdate();
  }

  async loadPanelIntoView(
    panelId: string,
    leaseMode: "acquire" | "takeOver" = "acquire"
  ): Promise<void> {
    const panel = this.deps.registry.getPanel(panelId);
    if (!panel) throw new Error(`Panel not found: ${panelId}`);
    await this.loadSnapshotIntoView(panelId, getCurrentSnapshot(panel), leaseMode);
  }

  async loadSnapshotIntoView(
    panelId: string,
    snapshot: PanelSnapshot,
    leaseMode: "acquire" | "takeOver" = "acquire"
  ): Promise<void> {
    const view = this.deps.getPanelView();
    if (!view) return;
    const panel = this.deps.registry.getPanel(panelId);
    if (!panel) throw new Error(`Panel not found: ${panelId}`);
    this.locallyLoadingSlots.add(panelId);
    try {
      const browserPartition = snapshot.source.startsWith("browser:")
        ? await this.deps.waitForBrowserSessionPartition()
        : undefined;
      this.destroyViewIfPartitionChanged(view, panelId, snapshot, browserPartition);
      await this.acquireRuntimeLease(panelId, leaseMode);
      if (snapshot.source.startsWith("browser:")) {
        const url = snapshot.source.slice("browser:".length);
        if (!view.createViewForBrowser) {
          throw new Error("Panel host cannot create browser views");
        }
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
            this.connectionBySlot.get(panelId)?.runtimeEntityId ??
            panel.runtimeEntityId ??
            undefined,
          viewFailure: undefined,
        });
        this.deps.registry.notifyPanelTreeUpdate();
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
      await view.createViewForPanel(panelId, panelUrl, snapshot.contextId);
      this.recordViewMutation();
      this.updateWorkspacePanelArtifacts(panelId, snapshot, panelUrl);
      this.resources.track(panelId);
      await this.resources.enforceCap(panelId);
    } finally {
      this.locallyLoadingSlots.delete(panelId);
    }
  }

  async acquireRuntimeLease(panelId: string, leaseMode: "acquire" | "takeOver"): Promise<string> {
    await this.ensureClientRegistered();
    const runtimeEntityId = await this.deps.shellCore.getCurrentEntityId(asPanelSlotId(panelId));
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
      throw new Error(formatPanelRuntimeLeaseDeniedMessage(panelId, result.lease));
    }
    this.connectionBySlot.set(panelId, { runtimeEntityId, connectionId });
    return connectionId;
  }

  async ensureLeaseForExistingView(panelId: string): Promise<void> {
    const view = this.deps.getPanelView();
    if (!view?.hasView(panelId)) return;
    const lease = this.deps.registry.getRuntimeLease(panelId);
    if (lease?.clientSessionId === this.clientSessionId) {
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

    await this.convergePreparedPanelView(panelId);
  }

  /**
   * Materialize a locally owned panel only after the server has sealed the
   * incarnation's immutable execution identity. This transition belongs to
   * the native runtime host and never depends on a renderer effect.
   */
  async convergePreparedPanelView(
    panelId: string,
    options: { refreshPresentedIdentity?: boolean } = {}
  ): Promise<void> {
    const existing = this.preparedViewConvergenceBySlot.get(panelId);
    if (existing) {
      await existing;
      if (options.refreshPresentedIdentity) {
        await this.convergePreparedPanelViewOnce(panelId, options);
      }
      return;
    }
    const convergence = this.convergePreparedPanelViewOnce(panelId, options).finally(() => {
      if (this.preparedViewConvergenceBySlot.get(panelId) === convergence) {
        this.preparedViewConvergenceBySlot.delete(panelId);
      }
    });
    this.preparedViewConvergenceBySlot.set(panelId, convergence);
    return convergence;
  }

  private async convergePreparedPanelViewOnce(
    panelId: string,
    options: { refreshPresentedIdentity?: boolean }
  ): Promise<void> {
    const view = this.deps.getPanelView();
    const panel = this.deps.registry.getPanel(panelId);
    if (
      !view ||
      !panel ||
      panel.snapshot.source.startsWith("browser:") ||
      !this.hasCompleteExecutionIdentity(panel)
    ) {
      return;
    }
    const snapshot = getCurrentSnapshot(panel);
    if (
      panel.artifacts.htmlPath &&
      panel.artifacts.hostedRuntimeEntityId === panel.runtimeEntityId
    ) {
      if (options.refreshPresentedIdentity) {
        // An activation event can add the server-sealed authority manifest
        // after this exact build was presented. createViewForPanel is
        // idempotent for an existing view and refreshes the code identity used
        // to authorize direct Electron-local service calls.
        await view.createViewForPanel(panelId, panel.artifacts.htmlPath, snapshot.contextId);
      }
      return;
    }
    const connection = this.connectionBySlot.get(panelId);
    if (!connection || connection.runtimeEntityId !== panel.runtimeEntityId) return;

    const runtimeEntityId = panel.runtimeEntityId;
    const buildKey = panel.buildKey;
    const panelUrl = this.buildPanelUrl(panelId, snapshot);
    await view.createViewForPanel(panelId, panelUrl, snapshot.contextId);
    const current = this.deps.registry.getPanel(panelId);
    if (!current || current.runtimeEntityId !== runtimeEntityId || current.buildKey !== buildKey) {
      return;
    }
    this.recordViewMutation();
    this.updateWorkspacePanelArtifacts(panelId, snapshot, panelUrl);
    this.resources.track(panelId);
    await this.resources.enforceCap(panelId);
  }

  private clearLocalPanelRuntime(panelId: string): void {
    this.resources.clear(panelId);
    this.connectionBySlot.delete(panelId);
    this.deps.cdpHost.cleanupPanelAccess(panelId);
    this.deps.cdpHost.unregisterTarget?.(panelId);
    const view = this.deps.getPanelView();
    if (view?.hasView(panelId)) {
      view.destroyView(panelId);
      this.recordViewMutation();
    }
  }

  releaseLocalPanelRuntime(panelId: string, _transition: PanelRuntimeReleaseTransition): void {
    const lease = this.connectionBySlot.get(panelId);
    this.clearLocalPanelRuntime(panelId);
    if (lease) {
      void this.panelRuntime.release(lease.runtimeEntityId, lease.connectionId).catch(() => {});
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
        boot: {
          phase: "failed",
          runtimeEntityId: lease.runtimeEntityId,
          message,
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  unloadPanel(panelId: string, transition: "lease-transfer" | "unload" = "unload"): void {
    const panel = this.deps.registry.getPanel(panelId);
    if (!panel) return;
    this.releaseLocalPanelRuntime(panelId, transition);
    const hasBuildArtifacts = Boolean(panel.artifacts?.htmlPath || panel.artifacts?.bundlePath);
    if (panel.artifacts?.buildState === "pending" && !hasBuildArtifacts) return;
    this.deps.registry.updateArtifacts(panelId, {
      buildState: "pending",
      buildProgress: "Panel unloaded - will rebuild when focused",
    });
  }

  private unloadPanelIfPresent(panelId: string, transition: "unload" | "lease-transfer"): void {
    if (!this.deps.registry.getPanel(panelId)) return;
    this.unloadPanel(panelId, transition);
    this.deps.registry.notifyPanelTreeUpdate();
  }

  private async loadAssignedLeaseIntoView(
    panelId: string,
    snapshot: PanelSnapshot,
    lease: PanelRuntimeLease
  ): Promise<void> {
    const view = this.deps.getPanelView();
    if (!view) return;
    const browserPartition = snapshot.source.startsWith("browser:")
      ? await this.deps.waitForBrowserSessionPartition()
      : undefined;
    this.destroyViewIfPartitionChanged(view, panelId, snapshot, browserPartition);
    this.connectionBySlot.set(panelId, {
      runtimeEntityId: lease.runtimeEntityId,
      connectionId: lease.connectionId,
    });
    if (snapshot.source.startsWith("browser:")) {
      const url = snapshot.source.slice("browser:".length);
      if (view.createViewForBrowser) {
        await view.createViewForBrowser(
          panelId,
          url,
          snapshot.contextId,
          assertPresent(browserPartition)
        );
        this.recordViewMutation();
      }
      this.deps.registry.updateArtifacts(panelId, {
        buildState: "ready",
        htmlPath: url,
        hostedRuntimeEntityId: lease.runtimeEntityId,
        viewFailure: undefined,
      });
      this.deps.registry.notifyPanelTreeUpdate();
      await this.reportPanelViewTransition(panelId);
      return;
    }
    const panel = this.deps.registry.getPanel(panelId);
    if (!this.hasCompleteExecutionIdentity(panel)) {
      if (panel?.artifacts.buildState === "error") {
        this.recordPanelViewFailure(
          panelId,
          panel.artifacts.error ?? "Panel unavailable: its runtime image could not be prepared."
        );
        return;
      }
      return;
    }
    const panelUrl = this.buildPanelUrl(panelId, snapshot);
    await view.createViewForPanel(panelId, panelUrl, snapshot.contextId);
    this.recordViewMutation();
    this.updateWorkspacePanelArtifacts(panelId, snapshot, panelUrl);
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
    this.deps.registry.notifyPanelTreeUpdate();
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

  private pruneRemovedPanelLocally(panelId: string): void {
    this.stateArgsPushUnsubs.get(panelId)?.();
    this.stateArgsPushUnsubs.delete(panelId);
    this.explicitTitlePanelIds.delete(panelId);
    this.releaseLocalPanelRuntime(panelId, "close");
  }
}
