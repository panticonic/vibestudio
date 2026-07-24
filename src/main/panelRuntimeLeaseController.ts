import { randomUUID } from "crypto";
import { createDevLogger } from "@vibestudio/dev-log";
import type {
  Panel,
  PanelArtifacts,
  PanelSnapshot,
  PanelTreeSnapshot,
} from "@vibestudio/shared/types";
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
import { getCurrentSnapshot, getPanelSource } from "@vibestudio/shared/panel/accessors";
import { asPanelSlotId } from "@vibestudio/shared/panel/ids";
import { assertPresent } from "../lintHelpers";
import type { PanelPinStoreApi } from "./panelPinStore.js";
import { PanelResourcePolicy } from "./panelResourcePolicy.js";

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
  private readonly explicitTitlePanelIds = new Set<string>();
  private lastAppliedServerPanelTreeRevision = 0;
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
        this.unloadPanelTree(panelId);
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

  async applyServerPanelTreeSnapshot(snapshot: PanelTreeSnapshot): Promise<void> {
    if (snapshot.revision <= this.lastAppliedServerPanelTreeRevision) return;
    this.lastAppliedServerPanelTreeRevision = snapshot.revision;
    const rootPanels = this.preserveExplicitTitlesInSnapshot(
      snapshot.forest.flatMap((group) => group.rootPanels)
    );
    if (this.panelTreesMatchSemantically(this.deps.registry.getRootPanels(), rootPanels)) return;
    if (this.panelTreesMatchIgnoringTitles(this.deps.registry.getRootPanels(), rootPanels)) {
      this.applyPanelTitlesFromSnapshot(rootPanels);
      return;
    }

    const beforeIds = new Set(this.deps.registry.listPanels().map((panel) => panel.panelId));
    const view = this.deps.getPanelView();
    const hostedBefore = new Map<
      string,
      {
        source: string;
        contextId: string;
        stateArgsJson: string;
        buildKey: string | null;
        artifacts: PanelArtifacts;
      }
    >();
    if (view) {
      for (const { panelId } of this.deps.registry.listPanels()) {
        if (!view.hasView(panelId)) continue;
        const panel = this.deps.registry.getPanel(panelId);
        if (!panel) continue;
        const current = getCurrentSnapshot(panel);
        hostedBefore.set(panelId, {
          source: current.source,
          contextId: current.contextId,
          stateArgsJson: JSON.stringify(current.stateArgs ?? {}),
          buildKey: panel.buildKey ?? null,
          artifacts: { ...panel.artifacts },
        });
      }
    }

    this.deps.registry.repopulate(rootPanels);
    this.deps.shellCore.syncEntityCachesFromRegistry();
    for (const panelId of beforeIds) {
      if (!this.deps.registry.getPanel(panelId)) this.pruneRemovedPanelLocally(panelId);
    }
    this.deps.pinStore?.prune(this.deps.registry.listPanels().map((panel) => panel.panelId));

    for (const [panelId, before] of hostedBefore) {
      const panel = this.deps.registry.getPanel(panelId);
      if (!panel || !view?.hasView(panelId)) continue;
      const current = getCurrentSnapshot(panel);
      const stateArgsJson = JSON.stringify(current.stateArgs ?? {});
      const executionIdentityUnchanged =
        current.source === before.source &&
        current.contextId === before.contextId &&
        (panel.buildKey ?? null) === before.buildKey;
      if (executionIdentityUnchanged) {
        // Tree snapshots carry semantic panel state, but renderer artifacts are
        // host-local lifecycle state. A structural or state-args update must
        // not regress a live hosted view back to the server's stale `pending`
        // projection when its immutable execution identity did not change.
        this.deps.registry.updateArtifacts(panelId, before.artifacts);
      }
      if (stateArgsJson !== before.stateArgsJson) {
        this.deps.sendPanelEvent(panelId, "runtime:stateArgsChanged", current.stateArgs ?? {});
      }
      const runtimeImageBecameReady =
        before.buildKey !== (panel.buildKey ?? null) && this.hasCompleteExecutionIdentity(panel);
      if (executionIdentityUnchanged && !runtimeImageBecameReady) {
        continue;
      }
      if (current.source.startsWith("browser:") || before.source.startsWith("browser:")) continue;
      this.explicitTitlePanelIds.delete(panelId);
      this.ensureStateArgsPush(panelId);
      await this.loadSnapshotIntoView(panelId, current).catch((error: unknown) => {
        log.warn(
          `[applyServerPanelTreeSnapshot] view reload after navigate failed for ${panelId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
    }

    const focusedPanelId = this.deps.registry.getFocusedPanelId();
    if (focusedPanelId && beforeIds.has(focusedPanelId) && view && !view.hasView(focusedPanelId)) {
      const panel = this.deps.registry.getPanel(focusedPanelId);
      if (panel && !getPanelSource(panel).startsWith("browser:")) {
        await this.loadSnapshotIntoView(focusedPanelId, getCurrentSnapshot(panel)).catch(
          (error: unknown) => {
            log.warn(
              `[applyServerPanelTreeSnapshot] focused view recovery failed for ${focusedPanelId}: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        );
      }
    }
    await this.syncLeaseSnapshot().catch((error: unknown) => {
      log.warn(
        `[applyServerPanelTreeSnapshot] Failed to sync runtime leases: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
  }

  applyServerPanelTitleUpdate(update: {
    panelId: string;
    title: string;
    explicit?: boolean;
  }): void {
    const panel = this.deps.registry.getPanel(update.panelId);
    if (!panel) return;
    if (!update.explicit && this.explicitTitlePanelIds.has(update.panelId)) return;
    if (update.explicit) this.explicitTitlePanelIds.add(update.panelId);
    if (panel.title !== update.title) this.deps.registry.updateTitle(update.panelId, update.title);
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
    const lease = disposition.lease;
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
    if (view && !view.hasView(slotId)) {
      try {
        const panel = this.deps.registry.getPanel(slotId);
        if (panel) {
          await this.loadAssignedLeaseIntoView(slotId, getCurrentSnapshot(panel), lease);
          this.resources.track(slotId);
          await this.resources.enforceCap(slotId);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn(`[handleRuntimeLeaseChanged] Failed to load assigned panel ${slotId}: ${message}`);
        this.releaseLocalPanelRuntime(slotId, "unload");
        this.markPanelLoadError(slotId, message);
      }
    } else if (view?.hasView(slotId)) {
      this.connectionBySlot.set(slotId, {
        runtimeEntityId: lease.runtimeEntityId,
        connectionId: lease.connectionId,
      });
      this.registerExistingCdpTarget(slotId);
      this.resources.track(slotId);
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

  markPanelLoadError(panelId: string, message: string): void {
    const panel = this.deps.registry.getPanel(panelId);
    if (!panel) return;
    this.deps.registry.updateArtifacts(panelId, {
      ...panel.artifacts,
      buildState: "error",
      error: message,
      buildProgress: message,
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
        this.deps.registry.updateArtifacts(panelId, { buildState: "ready", htmlPath: url });
        this.deps.registry.notifyPanelTreeUpdate();
        this.resources.track(panelId);
        await this.resources.enforceCap(panelId);
        return;
      }

      const panel = this.deps.registry.getPanel(panelId);
      if (!this.hasCompleteExecutionIdentity(panel)) {
        if (panel?.artifacts.buildState === "error") {
          throw new Error(
            panel.artifacts.error ?? "Panel unavailable: its runtime image could not be prepared."
          );
        }
        await this.loadPreparingPanelView(panelId, snapshot);
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
      return;
    }
    const current = this.connectionBySlot.get(panelId);
    const runtimeEntityId = await this.deps.shellCore.getCurrentEntityId(asPanelSlotId(panelId));
    if (
      current?.runtimeEntityId === runtimeEntityId &&
      lease?.connectionId === current.connectionId
    ) {
      this.registerExistingCdpTarget(panelId);
      return;
    }
    await this.acquireRuntimeLease(panelId, "acquire");
    this.registerExistingCdpTarget(panelId);
  }

  releaseLocalPanelRuntime(panelId: string, _transition: PanelRuntimeReleaseTransition): void {
    this.resources.clear(panelId);
    const lease = this.connectionBySlot.get(panelId);
    this.connectionBySlot.delete(panelId);
    if (lease) {
      void this.panelRuntime.release(lease.runtimeEntityId, lease.connectionId).catch(() => {});
    }
    this.deps.cdpHost.cleanupPanelAccess(panelId);
    this.deps.cdpHost.unregisterTarget?.(panelId);
    const view = this.deps.getPanelView();
    if (view?.hasView(panelId)) {
      view.destroyView(panelId);
      this.recordViewMutation();
    }
  }

  unloadPanelTree(panelId: string, transition: "lease-transfer" | "unload" = "unload"): void {
    const panel = this.deps.registry.getPanel(panelId);
    if (!panel) return;
    for (const child of panel.children) this.unloadPanelTree(child.id, transition);
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
    this.unloadPanelTree(panelId, transition);
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
      this.deps.registry.updateArtifacts(panelId, { buildState: "ready", htmlPath: url });
      this.deps.registry.notifyPanelTreeUpdate();
      return;
    }
    const panel = this.deps.registry.getPanel(panelId);
    if (!this.hasCompleteExecutionIdentity(panel)) {
      if (panel?.artifacts.buildState === "error") {
        this.markPanelLoadError(
          panelId,
          panel.artifacts.error ?? "Panel unavailable: its runtime image could not be prepared."
        );
        return;
      }
      await this.loadPreparingPanelView(panelId, snapshot);
      return;
    }
    const panelUrl = this.buildPanelUrl(panelId, snapshot);
    await view.createViewForPanel(panelId, panelUrl, snapshot.contextId);
    this.recordViewMutation();
    this.updateWorkspacePanelArtifacts(panelId, snapshot, panelUrl);
  }

  /**
   * Materialize the native host immediately while the server seals the runtime
   * image. The same view is navigated to the immutable build URL when the
   * panel-tree snapshot publishes its build identity.
   */
  private async loadPreparingPanelView(panelId: string, snapshot: PanelSnapshot): Promise<void> {
    const view = this.deps.getPanelView();
    if (!view) return;
    await view.createViewForPanel(panelId, "about:blank", snapshot.contextId);
    this.recordViewMutation();
    const panel = this.deps.registry.getPanel(panelId);
    if (!panel) return;
    this.deps.registry.updateArtifacts(panelId, {
      ...panel.artifacts,
      htmlPath: "about:blank",
      buildState: "building",
      buildProgress: "Preparing panel runtime...",
      error: undefined,
    });
    this.deps.registry.notifyPanelTreeUpdate();
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
      buildState: "ready",
      buildRevision: this.getBuildRevision(snapshot.source, snapshot.options.ref),
      buildProgress: undefined,
      error: undefined,
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

  private panelTreesMatchSemantically(
    current: readonly Panel[],
    incoming: readonly Panel[]
  ): boolean {
    if (current.length !== incoming.length) return false;
    return current.every((panel, index) =>
      this.panelsMatchSemantically(panel, assertPresent(incoming[index]))
    );
  }

  private panelsMatchSemantically(current: Panel, incoming: Panel): boolean {
    return (
      current.id === incoming.id &&
      current.title === incoming.title &&
      (current.runtimeEntityId ?? null) === (incoming.runtimeEntityId ?? null) &&
      (current.buildKey ?? null) === (incoming.buildKey ?? null) &&
      (current.executionDigest ?? null) === (incoming.executionDigest ?? null) &&
      (current.owner ?? null) === (incoming.owner ?? null) &&
      (current.positionId ?? null) === (incoming.positionId ?? null) &&
      (current.selectedChildId ?? null) === (incoming.selectedChildId ?? null) &&
      this.panelSnapshotsMatchSemantically(current, incoming) &&
      this.panelTreesMatchSemantically(current.children, incoming.children)
    );
  }

  private panelTreesMatchIgnoringTitles(
    current: readonly Panel[],
    incoming: readonly Panel[]
  ): boolean {
    if (current.length !== incoming.length) return false;
    return current.every((panel, index) =>
      this.panelsMatchIgnoringTitle(panel, assertPresent(incoming[index]))
    );
  }

  private panelsMatchIgnoringTitle(current: Panel, incoming: Panel): boolean {
    return (
      current.id === incoming.id &&
      (current.runtimeEntityId ?? null) === (incoming.runtimeEntityId ?? null) &&
      (current.buildKey ?? null) === (incoming.buildKey ?? null) &&
      (current.executionDigest ?? null) === (incoming.executionDigest ?? null) &&
      (current.owner ?? null) === (incoming.owner ?? null) &&
      (current.positionId ?? null) === (incoming.positionId ?? null) &&
      (current.selectedChildId ?? null) === (incoming.selectedChildId ?? null) &&
      this.panelSnapshotsMatchSemantically(current, incoming) &&
      this.panelTreesMatchIgnoringTitles(current.children, incoming.children)
    );
  }

  private applyPanelTitlesFromSnapshot(panels: readonly Panel[]): void {
    for (const panel of panels) {
      this.applyServerPanelTitleUpdate({ panelId: panel.id, title: panel.title });
      this.applyPanelTitlesFromSnapshot(panel.children);
    }
  }

  private preserveExplicitTitlesInSnapshot(panels: readonly Panel[]): Panel[] {
    let changed = false;
    const preserve = (panel: Panel): Panel => {
      const children = panel.children.map(preserve);
      const childrenChanged = children.some((child, index) => child !== panel.children[index]);
      const currentPanel = this.explicitTitlePanelIds.has(panel.id)
        ? this.deps.registry.getPanel(panel.id)
        : null;
      const title = currentPanel?.title ?? panel.title;
      if (!childrenChanged && title === panel.title) return panel;
      changed = true;
      return { ...panel, title, children };
    };
    const next = panels.map(preserve);
    return changed ? next : (panels as Panel[]);
  }

  private panelSnapshotsMatchSemantically(current: Panel, incoming: Panel): boolean {
    try {
      const currentSnapshot = getCurrentSnapshot(current);
      const incomingSnapshot = getCurrentSnapshot(incoming);
      return (
        currentSnapshot.source === incomingSnapshot.source &&
        currentSnapshot.contextId === incomingSnapshot.contextId &&
        currentSnapshot.options.ref === incomingSnapshot.options.ref &&
        JSON.stringify(currentSnapshot.stateArgs ?? null) ===
          JSON.stringify(incomingSnapshot.stateArgs ?? null)
      );
    } catch {
      return false;
    }
  }
}
