/**
 * PanelOrchestrator — Thin Electron coordinator.
 *
 * Replaces PanelLifecycle on the Electron side. All backend work (tokens,
 * persistence, FS context) goes through server RPCs. This class handles
 * only: server RPC → registry update → view management.
 */

import { createDevLogger } from "@vibestudio/dev-log";
import type {
  Panel,
  PanelFocusResult,
  PanelLifecycleResult,
  PanelNavigationState,
  PanelPlacementHint,
  PanelRecoverySnapshot,
  ThemeConfig,
} from "@vibestudio/shared/types";
import type { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import type { EventService } from "@vibestudio/shared/eventsService";
import type { ScopedServerCaller, ServerClient } from "./serverClient.js";
import type { PanelManager } from "@vibestudio/shell-core/panelManager";
import type { PanelOperationClients } from "@vibestudio/shell-core/panelManager";
import {
  createRuntimeClient,
  createWorkspaceStateClient,
} from "@vibestudio/shell-core/createShellCore";
import type {
  PanelHost,
  PanelHostRegistration,
  PanelRuntimeLeaseChangedEvent,
} from "@vibestudio/shared/panel/panelLease";
import type {
  BridgePanelLifecycle,
  PanelViewLike,
  PanelHttpServerLike,
  PanelCreateOptions,
  PanelInitialLoadPolicy,
} from "@vibestudio/shared/panelInterfaces";
import { shouldMaterializePanelOnCreate } from "@vibestudio/shared/panelInterfaces";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import type { PanelRestorePolicy } from "@vibestudio/workspace-contracts/types";
import { buildPanelUrl } from "@vibestudio/shared/panelFactory";
import { browserUrlFromPanelSource, isOpenPanelBrowserUrl } from "@vibestudio/shared/panelChrome";
import { asPanelSlotId } from "@vibestudio/shared/panel/ids";
import type { PanelPinStoreApi } from "./panelPinStore.js";
import {
  getCurrentSnapshot,
  getPanelSource,
  getPanelContextId,
  getPanelRef,
} from "@vibestudio/shared/panel/accessors";
import { assertPresent } from "../lintHelpers";
import { PanelRuntimeLeaseController } from "./panelRuntimeLeaseController.js";
import type {
  PanelBootProbeResult,
  PanelFailureCode,
  PanelFailureStage,
  PanelHostObservation,
} from "@vibestudio/shared/panel/observation";

const log = createDevLogger("PanelOrchestrator");
export interface PanelOrchestratorDeps {
  registry: PanelRegistry;
  eventService: EventService;
  serverClient: ServerClient;
  shellCore: PanelManager;

  getPanelView?: () => PanelViewLike | null;
  cdpHost: {
    registerTarget?(panelId: string, contentsId: number): void;
    cleanupPanelAccess(panelId: string): void;
    unregisterTarget?(panelId: string): void;
    getAccessibilityTree?(panelId: string): Promise<unknown[]>;
  };
  panelHttpServer: PanelHttpServerLike;
  externalHost: string;
  protocol: "http" | "https";
  gatewayPort: number;
  gatewayBasePath?: string;
  waitForBrowserSessionPartition?: () => Promise<string>;

  /**
   * Send an event to a panel. In IPC mode, this calls
   * webContents.send("vibestudio:event", event, payload).
   */
  sendPanelEvent: (panelId: string, event: string, payload: unknown) => void;
  workspaceConfig?: WorkspaceConfig;
  runtimeClient?: Partial<PanelHostRegistration> & {
    maxAssignedPanelViews?: number;
    /**
     * Idle threshold for the UI GC sweep. When set, a periodic sweep unloads
     * panels inactive for this long via the shared GC selectors. Used by both
     * desktop (1h) and the in-app headless host (5m) — there is one idle
     * mechanism, not a separate per-panel-timer path.
     */
    uiIdleUnloadMs?: number;
    /** Sweep cadence; defaults to PANEL_UI_IDLE_SWEEP_MS. Headless uses a finer one. */
    uiIdleSweepMs?: number;
    restorePolicy?: PanelRestorePolicy;
  };
  /**
   * Client-local pin store (desktop). Absent on headless, where pins don't
   * apply; GC then treats every panel as unpinned.
   */
  pinStore?: PanelPinStoreApi;
  /**
   * Panel ids currently bound to native slots (resident panes). Protected by
   * the GC alongside the focused panel (§5.3). Absent on headless hosts.
   */
  getResidentPanelIds?: () => string[];
}

export class PanelOrchestrator implements BridgePanelLifecycle, PanelHost {
  private readonly deps: PanelOrchestratorDeps;
  private currentTheme: "light" | "dark" = "dark";
  /** App-wide theme identity, broadcast to panels alongside appearance. */
  private currentThemeConfig: ThemeConfig = {
    accentColor: "violet",
    grayColor: "mauve",
    radius: "medium",
    scaling: "100%",
    panelBackground: "translucent",
  };
  private readonly runtime: PanelRuntimeLeaseController;
  private readonly restorePolicy: PanelRestorePolicy;

  constructor(deps: PanelOrchestratorDeps) {
    this.deps = deps;
    this.runtime = new PanelRuntimeLeaseController({
      registry: deps.registry,
      eventService: deps.eventService,
      shellCore: deps.shellCore,
      callServer: (service, method, args) => deps.serverClient.call(service, method, args),
      getPanelView: () => deps.getPanelView?.() ?? null,
      cdpHost: deps.cdpHost,
      panelHttpServer: deps.panelHttpServer,
      sendPanelEvent: deps.sendPanelEvent,
      gatewayPort: deps.gatewayPort,
      gatewayBasePath: deps.gatewayBasePath,
      waitForBrowserSessionPartition:
        deps.waitForBrowserSessionPartition ??
        (() => Promise.reject(new Error("Browser environment is unavailable"))),
      pinStore: deps.pinStore,
      ...(deps.getResidentPanelIds ? { getResidentPanelIds: deps.getResidentPanelIds } : {}),
      client: deps.runtimeClient ?? {},
    });
    this.restorePolicy =
      deps.runtimeClient?.restorePolicy ?? deps.workspaceConfig?.panelRestorePolicy ?? "focused";
  }

  // Convenience accessors
  private get registry() {
    return this.deps.registry;
  }
  private get eventService() {
    return this.deps.eventService;
  }
  private get serverClient() {
    return this.deps.serverClient;
  }
  private get shellCore() {
    return this.deps.shellCore;
  }
  private get externalHost() {
    return this.deps.externalHost;
  }
  private getPanelView() {
    return this.deps.getPanelView?.() ?? null;
  }
  private get panelHttpServer() {
    return this.deps.panelHttpServer;
  }
  private operationClients(caller?: ScopedServerCaller): PanelOperationClients | undefined {
    if (!caller) return undefined;
    const call = (service: string, method: string, args: unknown[]) =>
      this.serverClient.callAs(caller, service, method, args);
    return {
      workspaceState: createWorkspaceStateClient(call),
      runtime: createRuntimeClient(call),
    };
  }

  // =========================================================================
  // Panel creation
  // =========================================================================

  /**
   * Create through the product runtime, then attach the native presentation
   * once the query projection observes the committed slot.
   */
  private async createViaProductRuntime(
    execution:
      | { surface: "code"; source: string; ref?: string }
      | { surface: "external"; url: string },
    createOpts: {
      parentId?: string | null;
      title?: string;
      slug?: string;
      name?: string;
      contextId?: string;
      stateArgs?: Record<string, unknown>;
      placement?: PanelPlacementHint;
      focus?: boolean;
      initialLoad?: PanelInitialLoadPolicy;
    },
    caller?: ScopedServerCaller
  ): Promise<{ id: string; title: string }> {
    const interactionStartedAt = performance.now();
    const result = await this.shellCore.createExecution(
      execution,
      {
        parentId: createOpts.parentId ? asPanelSlotId(createOpts.parentId) : undefined,
        title: createOpts.title,
        slug: createOpts.slug,
        contextId: createOpts.contextId,
        stateArgs: createOpts.stateArgs,
        placement: createOpts.placement,
        isRoot: createOpts.parentId == null,
        addAsRoot: createOpts.parentId == null,
      },
      this.operationClients(caller)
    );
    // Slot creation is the authoritative interaction boundary. The shell can
    // place this real, durable panel while its runtime image is still preparing;
    // neither activation nor the bounded query projection may delay feedback.
    this.eventService.emit("panel-created", {
      panelId: result.panelId,
      parentId: createOpts.parentId ?? null,
      focus: createOpts.focus === true,
      ...(createOpts.placement ? { placement: createOpts.placement } : {}),
    });
    if (log.isVerbose()) {
      log.verbose(
        `[responsiveness] panel-created panel=${result.panelId} ` +
          `committedMs=${(performance.now() - interactionStartedAt).toFixed(1)}`
      );
    }

    // The supervisor takes ownership synchronously so a fast rejection can
    // never become unhandled. It yields one turn before doing readiness/view
    // work, allowing this RPC response to reach the renderer first.
    void this.superviseCreatedPanel(
      result,
      {
        focus: createOpts.focus,
        materialize: shouldMaterializePanelOnCreate(createOpts.initialLoad),
      },
      interactionStartedAt
    );
    return { id: result.panelId, title: result.title };
  }

  private async superviseCreatedPanel(
    result: {
      panelId: string;
      title: string;
      contextId: string;
      source: string;
      preparation?: Promise<unknown>;
    },
    opts: { focus?: boolean; materialize: boolean },
    interactionStartedAt: number
  ): Promise<void> {
    const preparationOutcome = result.preparation
      ? result.preparation.then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error })
        )
      : Promise.resolve({ ok: true as const });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const outcome = await preparationOutcome;
    if (!outcome.ok) {
      const error = outcome.error;
      const message = error instanceof Error ? error.message : String(error);
      const panel = this.registry.getPanel(result.panelId);
      if (panel) {
        this.registry.updateArtifacts(result.panelId, {
          ...panel.artifacts,
          buildState: "error",
          buildProgress: message,
          error: message,
        });
        this.registry.notifyPanelTreeUpdate(result.panelId);
      }
      log.warn(
        `[responsiveness] panel preparation failed panel=${result.panelId} ` +
          `elapsedMs=${(performance.now() - interactionStartedAt).toFixed(1)}: ${message}`
      );
      return;
    }

    const preparedMs = performance.now() - interactionStartedAt;
    if (opts.materialize) {
      try {
        await this.attachCreatedPanel(result, { focus: opts.focus });
      } catch (error) {
        // attachCreatedPanel records the distinct viewFailure state and releases
        // any partial local runtime. The durable slot remains authoritative.
        const message = error instanceof Error ? error.message : String(error);
        log.warn(
          `[responsiveness] panel view attachment failed panel=${result.panelId} ` +
            `elapsedMs=${(performance.now() - interactionStartedAt).toFixed(1)}: ${message}`
        );
        return;
      }
    }
    if (log.isVerbose()) {
      log.verbose(
        `[responsiveness] panel-ready panel=${result.panelId} ` +
          `preparedMs=${preparedMs.toFixed(1)} ` +
          `totalMs=${(performance.now() - interactionStartedAt).toFixed(1)}`
      );
    }
  }

  async createPanel(
    callerId: string,
    source: string,
    options?: PanelCreateOptions,
    stateArgs?: Record<string, unknown>,
    scopedCaller?: ScopedServerCaller
  ): Promise<{ id: string; title: string }> {
    // App callers (the shell's test API, app-view links) create under their own
    // capability-gated authority via a scoped connection. Panel-hosted links
    // pass no scoped caller and are translated by the trusted host (see
    // panelView). The source view becomes the parent slot when it's a panel,
    // otherwise this is a new root panel.
    const caller = this.registry.getPanel(callerId);
    return this.createViaProductRuntime(
      {
        surface: "code",
        source,
        ...(options?.ref ? { ref: options.ref } : {}),
      },
      {
        parentId: options?.isRoot ? null : caller ? asPanelSlotId(callerId) : null,
        title: options?.title,
        slug: options?.slug,
        contextId: options?.contextId,
        stateArgs,
        ...(options?.placement ? { placement: options.placement } : {}),
        focus: options?.focus !== false,
        ...(options?.initialLoad ? { initialLoad: options.initialLoad } : {}),
      },
      scopedCaller
    );
  }

  async navigatePanel(
    panelId: string,
    source: string,
    options: {
      contextId?: string;
      env?: Record<string, string>;
      ref?: string;
      stateArgs?: Record<string, unknown>;
    } = {},
    scopedCaller?: ScopedServerCaller
  ): Promise<{ id: string; title: string } | null> {
    if (!this.registry.getPanel(panelId)) throw new Error(`Panel not found: ${panelId}`);
    // Panel navigation is host-mediated (trusted chrome) by default; an app
    // caller may still drive it under its own authority via a scoped connection.
    const result = await this.shellCore.navigate(
      asPanelSlotId(panelId),
      source,
      options,
      this.operationClients(scopedCaller)
    );
    if (!result) return null;
    return { id: result.panelId, title: result.title };
  }

  async navigatePanelHistory(
    panelId: string,
    delta: -1 | 1,
    caller?: ScopedServerCaller
  ): Promise<{ id: string; title: string } | null> {
    const result = await this.shellCore.navigateHistory(
      asPanelSlotId(panelId),
      delta,
      this.operationClients(caller)
    );
    if (!result) return null;
    return { id: result.id, title: result.title };
  }

  async createBrowserUrlPanel(
    callerId: string,
    url: string,
    options?: {
      title?: string;
      slug?: string;
      focus?: boolean;
      initialLoad?: PanelInitialLoadPolicy;
      placement?: "child" | "sibling";
    },
    caller?: ScopedServerCaller
  ): Promise<{ id: string; title: string }> {
    if (typeof url !== "string" || !isOpenPanelBrowserUrl(url)) {
      throw new Error(`Invalid browser panel URL: ${String(url)}`);
    }
    const callerPanel = this.registry.getPanel(callerId);
    const parentId =
      callerPanel && options?.placement !== "sibling"
        ? asPanelSlotId(callerId)
        : this.registry.findParentId(callerId);
    return this.createViaProductRuntime(
      { surface: "external", url },
      {
        parentId,
        title: options?.title,
        slug: options?.slug,
        focus: options?.focus !== false,
        ...(options?.initialLoad ? { initialLoad: options.initialLoad } : {}),
      },
      caller
    );
  }

  // =========================================================================
  // Panel destruction
  // =========================================================================

  async closePanel(panelId: string, caller?: ScopedServerCaller): Promise<PanelLifecycleResult> {
    const panel = this.registry.getPanel(panelId);
    if (!panel) throw new Error(`Panel not found: ${panelId}`);
    const result = this.lifecycleResult(panelId, "close", "closed", {
      loaded: false,
      reloaded: false,
    });

    // Determine sibling to focus before removal
    const parentId = this.registry.findParentId(panelId);
    const parent = parentId ? this.registry.getPanel(parentId) : null;
    const focusedPanelId = this.registry.getFocusedPanelId();
    const focusedPanelWillClose = Boolean(
      focusedPanelId &&
      (focusedPanelId === panelId || this.registry.isDescendantOf(focusedPanelId, panelId))
    );
    let siblingToFocus: string | null = null;
    if (focusedPanelWillClose && parent) {
      const siblings = parent.children.filter((c) => c.id !== panelId);
      siblingToFocus =
        siblings.length > 0 ? assertPresent(siblings[siblings.length - 1]).id : parentId;
    } else if (focusedPanelWillClose && !parentId) {
      const roots = this.registry.getRootPanels();
      const rootIndex = roots.findIndex((p) => p.id === panelId);
      const nextRoot = rootIndex >= 0 ? (roots[rootIndex + 1] ?? roots[rootIndex - 1]) : undefined;
      siblingToFocus = nextRoot?.id ?? null;
    }

    // Server authority closes the subtree + emits; the desktop reactively tears
    // down views/leases for removed panels (tree invalidation →
    // pruneRemovedPanelLocally).
    await (caller
      ? this.serverClient.callAs(caller, "workspace-state", "slot.close", [panelId])
      : this.serverClient.call("workspace-state", "slot.close", [panelId]));

    if (siblingToFocus) {
      this.eventService.emit("navigate-to-panel", { panelId: siblingToFocus });
    }
    return result;
  }

  // =========================================================================
  // Build lifecycle
  // =========================================================================

  async reloadPanel(panelId: string): Promise<PanelLifecycleResult> {
    const view = this.getPanelView();
    if (view?.hasView(panelId)) {
      const reloaded = await view.reloadView(panelId);
      return this.lifecycleResult(panelId, "reload", "reloaded", {
        loaded: reloaded,
        reloaded,
      });
    }
    const result = await this.ensureLoaded(panelId);
    return this.lifecycleResult(panelId, "reload", result.status, {
      loaded: result.loaded,
      reloaded: result.loaded,
    });
  }

  async rebuildUnloadedPanel(
    panelId: string,
    options: { force?: boolean } = {}
  ): Promise<PanelLifecycleResult> {
    const panel = this.registry.getPanel(panelId);
    if (!panel) throw new Error(`Panel not found: ${panelId}`);
    if (!options.force && panel.artifacts?.buildState !== "pending") {
      return this.lifecycleResult(panelId, "rebuild", "skipped_not_pending", {
        loaded: this.hasPanelView(panelId),
      });
    }

    // Re-registers the panel principal and issues a fresh connection grant.
    await this.shellCore.getPanelInit(asPanelSlotId(panelId));

    // Browser panels skip the workspace build, but loading is still owned by
    // the operation that acquires the runtime lease. Lease broadcasts reflect
    // remote assignments; they are not a completion signal for local work.
    if (getPanelSource(panel).startsWith("browser:")) {
      await this.runtime.loadPanelIntoView(panelId);
      return this.lifecycleResult(panelId, "rebuild", "browser_loaded", {
        loaded: Boolean(this.getPanelView()?.hasView(panelId)),
      });
    }

    this.registry.updateArtifacts(panelId, {
      buildState: "building",
      buildProgress: "Rebuilding panel...",
    });
    this.registry.notifyPanelTreeUpdate(panelId);

    this.panelHttpServer?.invalidateBuild(getPanelSource(panel));

    await this.runtime.loadPanelIntoView(panelId);
    const refreshed = this.registry.getPanel(panelId);
    if (refreshed?.artifacts.buildState === "building") {
      this.registry.updateArtifacts(panelId, {
        ...refreshed.artifacts,
        buildProgress: "Rebuilding panel...",
      });
      this.registry.notifyPanelTreeUpdate(panelId);
    }
    return this.lifecycleResult(panelId, "rebuild", "rebuild_requested", {
      loaded: Boolean(this.getPanelView()?.hasView(panelId)),
      rebuilt: true,
    });
  }

  invalidateReadyPanels(): void {
    const focusedPanelId = this.registry.getFocusedPanelId();
    let focusedWasReset = false;
    const changedPanelIds: string[] = [];

    for (const entry of this.registry.listPanels()) {
      const panel = this.registry.getPanel(entry.panelId);
      if (!panel) continue;
      const buildState = panel.artifacts?.buildState;
      if (buildState === "ready" || buildState === "error") {
        if (getPanelSource(panel).startsWith("browser:")) continue;
        this.panelHttpServer?.invalidateBuild(getPanelSource(panel));
        this.runtime.releaseLocalPanelRuntime(entry.panelId, "invalidate");
        this.registry.updateArtifacts(entry.panelId, {
          buildState: "pending",
          buildProgress: "Build cache cleared - will rebuild when focused",
        });
        changedPanelIds.push(entry.panelId);
        if (entry.panelId === focusedPanelId) focusedWasReset = true;
      }
    }

    if (changedPanelIds.length > 0) this.registry.notifyPanelTreeUpdate(changedPanelIds);
    if (focusedWasReset && focusedPanelId) {
      void this.rebuildUnloadedPanel(focusedPanelId).catch((e) =>
        console.warn(`[PanelOrchestrator] Failed to rebuild ${focusedPanelId}:`, e)
      );
    }
  }

  async rebuildPanel(panelId: string): Promise<PanelLifecycleResult> {
    return this.rebuildUnloadedPanel(panelId, { force: true });
  }

  applyBuildComplete(source: string, error?: string): void {
    const changedPanelIds: string[] = [];
    for (const entry of this.registry.listPanels()) {
      const panel = this.registry.getPanel(entry.panelId);
      if (!panel || getPanelSource(panel) !== source) continue;
      changedPanelIds.push(entry.panelId);
      if (error) {
        this.registry.updateArtifacts(entry.panelId, {
          ...panel.artifacts,
          buildState: "error",
          buildRevision: this.runtime.getBuildRevision(source),
          error,
          buildProgress: error,
        });
      } else {
        // A source build completing does not select an immutable runtime image
        // for every slot that references that source. The authoritative tree
        // supplies that identity, and createViewForPanel's completed navigation
        // is the readiness signal. Treating this broadcast as activation both
        // fabricated "ready" state for unloaded slots and tried to reconstruct
        // URLs before their sealed buildKey had reached the desktop.
        this.registry.updateArtifacts(entry.panelId, {
          ...panel.artifacts,
          buildRevision: this.runtime.getBuildRevision(source),
          buildProgress:
            panel.artifacts.buildState === "ready"
              ? undefined
              : "Build complete — waiting for runtime activation",
          error: undefined,
        });
      }
    }
    if (changedPanelIds.length > 0) this.registry.notifyPanelTreeUpdate(changedPanelIds);
  }

  // =========================================================================
  // Bootstrap config
  // =========================================================================

  async getBootstrapConfig(callerId: string): Promise<unknown> {
    const config = await this.shellCore.getPanelInit(asPanelSlotId(callerId));
    const lease = this.runtime.getConnection(callerId);
    if (!lease || !config || typeof config !== "object") return config;
    return {
      ...(config as Record<string, unknown>),
      connectionId: lease.connectionId,
      clientLabel: "Desktop",
    };
  }

  /**
   * The runtime entity id + lease connectionId for a panel, so the host can open
   * a panel-principal server session on that exact lease (ipcDispatcher relay).
   * Undefined until the panel's runtime lease is acquired.
   */
  getPanelRuntimeConnection(
    panelId: string
  ): { runtimeEntityId: string; connectionId: string } | undefined {
    return this.runtime.getConnection(panelId);
  }

  listRuntimePanels(parentId?: string | null) {
    return parentId ? this.registry.getChildren(parentId) : this.registry.listPanels();
  }

  snapshot(panelId: string): unknown {
    const panel = this.registry.getPanel(panelId);
    if (!panel) throw new Error(`Panel not found: ${panelId}`);
    return getCurrentSnapshot(panel);
  }

  async replaceCurrentSnapshot(
    panelId: string,
    contextId: string,
    source?: string,
    stateArgs?: Record<string, unknown>
  ): Promise<void> {
    await this.shellCore.replaceCurrentSnapshot(asPanelSlotId(panelId), {
      contextId,
      ...(source !== undefined && { source }),
      ...(stateArgs !== undefined && { stateArgs }),
    });
  }

  async updatePanelTitle(panelId: string, title: string): Promise<void> {
    if (this.runtime.isTitleExplicit(panelId)) return;
    await this.shellCore.updateTitle(asPanelSlotId(panelId), title);
  }

  async updatePanelState(panelId: string, state: PanelNavigationState): Promise<void> {
    await this.shellCore.updatePanelState(asPanelSlotId(panelId), state);
  }

  /** Generic server RPC call — exposes server access without leaking serverClient reference. */
  callServer(service: string, method: string, args: unknown[]): Promise<unknown> {
    return this.serverClient.call(service, method, args);
  }

  // =========================================================================
  // Focus
  // =========================================================================

  async focusPanel(
    targetPanelId: string,
    opts: {
      loadIfNeeded?: boolean;
      anchorPanelId?: string;
      placement?: import("@vibestudio/shared/types").PanelPlacementHint;
    } = {}
  ): Promise<PanelFocusResult> {
    const result = await this.focusPanelLocally(targetPanelId, opts);
    if (result.focused) {
      this.eventService.emit("navigate-to-panel", {
        panelId: targetPanelId,
        ...(opts.anchorPanelId ? { anchorPanelId: opts.anchorPanelId } : {}),
        ...(opts.placement ? { hint: opts.placement } : {}),
      });
    }
    return result;
  }

  /**
   * Apply host focus mechanics without inventing a shell presentation event.
   * Authoritative panel creation calls this after panelTree.create has already
   * published its panel-created fact.
   */
  private async focusPanelLocally(
    targetPanelId: string,
    opts: { loadIfNeeded?: boolean } = {}
  ): Promise<PanelFocusResult> {
    let panel = this.registry.getPanel(targetPanelId);
    if (!panel) {
      // Query-first tree browsers can present a durable slot before this
      // host's bounded runtime projection contains it. The native-load
      // boundary hydrates that exact slot on demand; lease delivery order must
      // not decide whether a visible panel can be focused.
      await this.shellCore.getPanel(asPanelSlotId(targetPanelId));
      panel = this.registry.getPanel(targetPanelId);
    }
    if (!panel) {
      log.warn(`Cannot focus panel - not found: ${targetPanelId}`);
      return {
        panelId: targetPanelId,
        status: "missing",
        focused: false,
        loaded: false,
        message: `Panel not found: ${targetPanelId}`,
      };
    }

    // Capture the outgoing panel before focus moves. "Inactive" means "1h since
    // you last *viewed* it", so the panel we're leaving restarts its idle
    // countdown now. The newly focused panel needs no bump — while focused it's
    // protected by the sweep's protectedIds.
    const previousFocused = this.registry.getFocusedPanelId();

    const changedSelectionPanelIds = this.registry.updateSelectedPath(targetPanelId);
    if (changedSelectionPanelIds.length > 0) {
      this.registry.notifyPanelTreeUpdate(changedSelectionPanelIds);
    }

    if (previousFocused && previousFocused !== targetPanelId) {
      this.runtime.refreshActivity(previousFocused);
    }

    // Persist focus to the server fire-and-forget: it's pure bookkeeping and
    // must not add an RPC round trip before an already-loaded view is shown.
    void this.shellCore.notifyFocused(asPanelSlotId(targetPanelId)).catch(() => {});

    const view = this.getPanelView();
    if (view?.hasView(targetPanelId)) {
      try {
        await this.runtime.ensureLeaseForExistingView(targetPanelId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const lease = this.registry.getRuntimeLease(targetPanelId);
        const isLeaseFailure = /running on|leased by/i.test(message);
        if (isLeaseFailure) this.runtime.releaseLocalPanelRuntime(targetPanelId, "lease-transfer");
        return {
          panelId: targetPanelId,
          status: isLeaseFailure ? "leased_elsewhere" : "view_creation_failed",
          focused: true,
          loaded: false,
          message,
          holderLabel: lease?.holderLabel,
        };
      }
      view.setViewVisible?.(targetPanelId, true);
      this.runtime.recordViewMutation();
      this.sendPanelEvent(targetPanelId, { type: "focus" });
      return {
        panelId: targetPanelId,
        status: "loaded",
        focused: true,
        loaded: true,
      };
    }

    if (panel.artifacts.buildState === "error") {
      return {
        panelId: targetPanelId,
        status: "build_failed",
        focused: true,
        loaded: false,
        message: panel.artifacts.error ?? panel.artifacts.buildProgress ?? "Panel build failed",
      };
    }

    if (opts.loadIfNeeded) {
      try {
        await this.runtime.loadPanelIntoView(targetPanelId);
        const nextView = this.getPanelView();
        if (nextView?.hasView(targetPanelId)) {
          nextView.setViewVisible?.(targetPanelId, true);
          this.runtime.recordViewMutation();
          this.sendPanelEvent(targetPanelId, { type: "focus" });
          return {
            panelId: targetPanelId,
            status: "loaded",
            focused: true,
            loaded: true,
          };
        }
        const preparing = !this.runtime.hasExecutablePanel(targetPanelId);
        if (preparing) {
          return {
            panelId: targetPanelId,
            status: "preparing",
            focused: true,
            loaded: false,
            message: "Panel runtime is preparing",
          };
        }
        this.runtime.recordPanelViewFailure(targetPanelId, "Panel view was not created");
        return {
          panelId: targetPanelId,
          status: "view_creation_failed",
          focused: true,
          loaded: false,
          message: "Panel view was not created",
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const lease = this.registry.getRuntimeLease(targetPanelId);
        const isLeaseFailure = /running on|leased by/i.test(message);
        if (!isLeaseFailure) this.runtime.recordPanelViewFailure(targetPanelId, message);
        return {
          panelId: targetPanelId,
          status: isLeaseFailure ? "leased_elsewhere" : "view_creation_failed",
          focused: true,
          loaded: false,
          message,
          holderLabel: lease?.holderLabel,
        };
      }
    }

    return {
      panelId: targetPanelId,
      status: "focused",
      focused: true,
      loaded: false,
    };
  }

  async ensureLoaded(panelId: string): Promise<PanelFocusResult> {
    let panel = this.registry.getPanel(panelId);
    if (!panel) {
      // The query-first shell is authoritative for discovery, while the local
      // registry is only a bounded native-runtime projection. Materialize the
      // requested slot at the point where a native view is actually needed.
      await this.shellCore.getPanel(asPanelSlotId(panelId));
      panel = this.registry.getPanel(panelId);
    }
    if (!panel) {
      return {
        panelId,
        status: "missing",
        focused: false,
        loaded: false,
        message: `Panel not found: ${panelId}`,
      };
    }

    const view = this.getPanelView();
    if (view?.hasView(panelId)) {
      try {
        await this.runtime.ensureLeaseForExistingView(panelId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const lease = this.registry.getRuntimeLease(panelId);
        const isLeaseFailure = /running on|leased by/i.test(message);
        if (isLeaseFailure) this.runtime.releaseLocalPanelRuntime(panelId, "lease-transfer");
        return {
          panelId,
          status: isLeaseFailure ? "leased_elsewhere" : "view_creation_failed",
          focused: false,
          loaded: false,
          message,
          holderLabel: lease?.holderLabel,
        };
      }
      return {
        panelId,
        status: "loaded",
        focused: false,
        loaded: true,
      };
    }

    if (panel.artifacts.buildState === "error") {
      return {
        panelId,
        status: "build_failed",
        focused: false,
        loaded: false,
        message: panel.artifacts.error ?? panel.artifacts.buildProgress ?? "Panel build failed",
      };
    }

    try {
      await this.runtime.loadPanelIntoView(panelId);
      const nextView = this.getPanelView();
      const loaded = Boolean(nextView?.hasView(panelId));
      if (!loaded && !this.runtime.hasExecutablePanel(panelId)) {
        return {
          panelId,
          status: "preparing",
          focused: false,
          loaded: false,
          message: "Panel runtime is preparing",
        };
      }
      if (!loaded) this.runtime.recordPanelViewFailure(panelId, "Panel view was not created");
      return {
        panelId,
        status: loaded ? "loaded" : "view_creation_failed",
        focused: false,
        loaded,
        ...(loaded ? {} : { message: "Panel view was not created" }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const lease = this.registry.getRuntimeLease(panelId);
      const isLeaseFailure = /running on|leased by/i.test(message);
      if (!isLeaseFailure) this.runtime.recordPanelViewFailure(panelId, message);
      return {
        panelId,
        status: isLeaseFailure ? "leased_elsewhere" : "view_creation_failed",
        focused: false,
        loaded: false,
        message,
        holderLabel: lease?.holderLabel,
      };
    }
  }

  // =========================================================================
  // Tree initialization
  // =========================================================================

  async initializePanelTree(options: { seedInitialPanels?: boolean } = {}): Promise<void> {
    if (options.seedInitialPanels !== false) {
      const initialPanels = this.deps.workspaceConfig?.initPanels ?? [];
      for (const [index, initial] of initialPanels.entries()) {
        // The registry is only a bounded local mirror and is empty at the
        // beginning of a warm launch. Ask durable query state before seeding;
        // otherwise each process creates another copy of the manifest root.
        const existing =
          this.registry.getRootPanels().some((panel) => getPanelSource(panel) === initial.source) ||
          (await this.shellCore.hasRootPanelSource(initial.source));
        if (existing) continue;
        await this.createViaProductRuntime(
          { surface: "code", source: initial.source },
          {
            stateArgs: initial.stateArgs,
            initialLoad: "eager",
            focus: index === 0,
          }
        );
      }
    }
    await this.runtime.syncLeaseSnapshot().catch((error: unknown) => {
      log.warn(
        `[initializePanelTree] Failed to sync runtime leases: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
    log.verbose("[initializePanelTree] Synchronized runtime lease snapshot");

    log.info("[initializePanelTree] Query-first panel tree initialized");
  }

  // =========================================================================
  // Theme
  // =========================================================================

  setCurrentTheme(theme: "light" | "dark"): void {
    this.currentTheme = theme;
    this.shellCore.setCurrentTheme(theme);
    this.registry.setCurrentTheme(theme);
  }

  setCurrentThemeConfig(config: ThemeConfig): void {
    this.currentThemeConfig = config;
  }

  getThemeConfig(): ThemeConfig {
    return this.currentThemeConfig;
  }

  broadcastTheme(theme: "light" | "dark"): void {
    // The theme identity rides on the same event so panels converge appearance
    // AND accent/radius in one push.
    for (const entry of this.registry.listPanels()) {
      if (this.getPanelView()?.hasView(entry.panelId)) {
        this.deps.sendPanelEvent(entry.panelId, "runtime:theme", {
          theme,
          config: this.currentThemeConfig,
        });
      }
    }
  }

  /** Re-broadcast the current appearance + the (just-updated) theme identity. */
  broadcastThemeConfig(): void {
    this.broadcastTheme(this.currentTheme);
  }

  // =========================================================================
  // Queries
  // =========================================================================

  getInfo(panelId: string): unknown {
    return this.registry.getInfo(panelId);
  }

  listPanels() {
    return this.registry.listPanels();
  }

  // =========================================================================
  // Panel operations
  // =========================================================================

  async unloadPanel(
    panelId: string,
    transition: "unload" | "lease-transfer" = "unload"
  ): Promise<PanelLifecycleResult> {
    const panel = this.registry.getPanel(panelId);
    if (!panel) throw new Error(`Panel not found: ${panelId}`);

    this.runtime.unloadPanel(panelId, transition);
    this.registry.notifyPanelTreeUpdate(panelId);
    return this.lifecycleResult(
      panelId,
      "unload",
      transition === "unload" ? "unloaded" : "lease_transferred",
      {
        loaded: false,
      }
    );
  }

  getRuntimeClientSessionId(): string {
    return this.runtime.sessionId;
  }

  get registration(): PanelHostRegistration {
    return this.runtime.registration;
  }

  async registerRuntimeClient(): Promise<void> {
    await this.runtime.registerClient();
  }

  async unregisterRuntimeClient(): Promise<void> {
    await this.runtime.unregisterClient();
  }

  getFocusedPanelId(): string | null {
    return this.registry.getFocusedPanelId();
  }

  /**
   * Record shell layout focus without a load/lease side effect: updates the
   * registry mirror (so getFocusedPanelId reflects it) and persists the
   * focused path server-side for restore (§5.2 of the layout plan).
   */
  async setFocusedPanelId(panelId: string): Promise<void> {
    if (!this.registry.getPanel(panelId)) {
      // Presentation and query-first discovery are independent streams. A
      // panel-created event can focus a durable slot before this host's
      // bounded projection has observed it, so hydrate that exact slot at the
      // focus-persistence boundary.
      await this.shellCore.getPanel(asPanelSlotId(panelId));
      if (!this.registry.getPanel(panelId)) {
        log.warn(`Cannot set focused panel - not found: ${panelId}`);
        return;
      }
    }
    const changedSelectionPanelIds = this.registry.updateSelectedPath(panelId);
    if (changedSelectionPanelIds.length > 0) {
      this.registry.notifyPanelTreeUpdate(changedSelectionPanelIds);
    }
    this.persistFocusedPath(panelId);
  }

  async getCurrentRuntimeEntityId(panelId: string): Promise<string> {
    return this.shellCore.getCurrentEntityId(asPanelSlotId(panelId));
  }

  async takeOverPanel(panelId: string): Promise<PanelFocusResult> {
    await this.runtime.loadPanelIntoView(panelId, "takeOver");
    return this.focusPanel(panelId);
  }

  async syncRuntimeLeaseSnapshot(): Promise<void> {
    await this.runtime.syncLeaseSnapshot();
  }

  applyServerPanelTitleUpdate(update: {
    panelId: string;
    title: string | null;
    explicit?: boolean;
  }): Promise<void> {
    return this.runtime.applyServerPanelTitleUpdate(update);
  }

  applyServerPanelStateArgsUpdate(update: {
    panelId: string;
    stateArgs: Record<string, unknown>;
  }): void {
    this.shellCore.applyStateArgsProjection(asPanelSlotId(update.panelId), update.stateArgs);
  }

  async recoverShellSnapshot(
    opts: { loadFocusedView?: boolean } = {}
  ): Promise<PanelRecoverySnapshot> {
    await this.runtime.recoverClientRegistration();
    const { collapsedIds } = await this.shellCore.loadViewState();
    await this.runtime.syncLeaseSnapshot();
    await this.runtime.repairLeasesForExistingViews();

    const currentFocusedPanelId = this.registry.getFocusedPanelId();
    const roots = this.registry.getRootPanels();
    const focusedPanelId =
      currentFocusedPanelId && this.registry.getPanel(currentFocusedPanelId)
        ? currentFocusedPanelId
        : (roots[0]?.id ?? null);
    const shouldLoadFocusedView =
      opts.loadFocusedView ?? (this.restorePolicy === "focused" && Boolean(focusedPanelId));
    const focus = focusedPanelId
      ? await this.focusPanel(focusedPanelId, { loadIfNeeded: shouldLoadFocusedView })
      : undefined;

    const treeSnapshot = this.registry.getPanelTreeSnapshot();
    const treeRootPanels = treeSnapshot.forest.flatMap((group) => group.rootPanels);
    this.eventService.emit("panel:snapshot", {
      revision: treeSnapshot.revision,
      viewRevision: this.runtime.viewRevision,
      rootPanels: treeRootPanels,
      collapsedIds,
      focusedPanelId,
      focus,
    });
    return {
      revision: treeSnapshot.revision,
      viewRevision: this.runtime.viewRevision,
      rootPanels: treeRootPanels,
      collapsedIds,
      focusedPanelId,
      focus,
    };
  }

  async handleRuntimeLeaseChanged(event: PanelRuntimeLeaseChangedEvent): Promise<void> {
    await this.runtime.handleLeaseChanged(event);
  }

  // =========================================================================
  // WS event helpers
  // =========================================================================

  sendPanelEvent(panelId: string, payload: unknown): void {
    const data = payload as Record<string, unknown>;
    if (data["type"] === "focus") {
      this.deps.sendPanelEvent(panelId, "runtime:focus", null);
    } else if (data["type"] === "theme") {
      this.deps.sendPanelEvent(panelId, "runtime:theme", {
        theme: data["theme"],
        config: this.currentThemeConfig,
      });
    } else if (data["type"] === "child-created") {
      this.deps.sendPanelEvent(panelId, "runtime:child-created", {
        childId: data["childId"],
        url: data["url"],
      });
    } else if (data["type"] === "child-creation-error") {
      this.deps.sendPanelEvent(panelId, "runtime:child-creation-error", {
        url: data["url"],
        error: data["error"],
      });
    }
  }

  // =========================================================================
  // Persistence delegation (server-first)
  // =========================================================================

  async setCollapsed(panelId: string, collapsed: boolean): Promise<void> {
    await this.shellCore.setCollapsed(asPanelSlotId(panelId), collapsed);
  }

  async expandIds(panelIds: string[]): Promise<void> {
    await this.shellCore.expandIds(panelIds);
  }

  async getCollapsedIds(): Promise<string[]> {
    return this.shellCore.getCollapsedIds();
  }

  persistFocusedPath(panelId: string): void {
    void this.shellCore.notifyFocused(asPanelSlotId(panelId)).catch(() => {});
  }

  // =========================================================================
  // URL helpers
  // =========================================================================

  getPanelUrl(panelId: string): string | null {
    return this.getPanelUrlForId(panelId);
  }

  hasPanelView(panelId: string): boolean {
    return this.getPanelView()?.hasView(panelId) ?? false;
  }

  getPanelViewRevision(): number {
    return this.runtime.viewRevision;
  }

  reportPanelViewTransition(panelId: string): Promise<void> {
    return this.runtime.reportPanelViewTransition(panelId);
  }

  async refreshPanelProjection(panelId: string): Promise<Panel | null> {
    const slotId = asPanelSlotId(panelId);
    if (!this.registry.getPanel(panelId)) {
      await this.shellCore.getPanel(slotId);
    }
    await this.runtime.convergePreparedPanelView(panelId);
    return this.registry.getPanel(panelId) ?? null;
  }

  async applyPanelExecutionActivated(
    event: import("@vibestudio/shared/events").EventPayloads["panel:executionActivated"]
  ): Promise<void> {
    if (!this.registry.applyExecutionIdentity(event.panelId, event)) return;
    await this.runtime.convergePreparedPanelView(event.panelId, {
      refreshPresentedIdentity: true,
    });
  }

  /**
   * The host's exact presentation observation for the current slot. This is
   * consumed by the server's canonical panel observation; the shell UI and
   * agent therefore diagnose the same failure instead of maintaining separate
   * notions of readiness.
   */
  getPanelHostObservation(
    panelId: string,
    boot: PanelBootProbeResult = { kind: "unavailable" }
  ): PanelHostObservation {
    const panel = this.registry.getPanel(panelId);
    const contents = this.getPanelView()?.getWebContents(panelId) as
      | {
          isDestroyed(): boolean;
          getURL(): string;
          isLoading(): boolean;
        }
      | null
      | undefined;
    const viewExists = Boolean(contents && !contents.isDestroyed());
    const lease = this.registry.getRuntimeLease(panelId);
    const buildError = panel?.artifacts.error;
    const viewFailure = panel?.artifacts.viewFailure;
    let failure:
      | {
          code: PanelFailureCode;
          stage: PanelFailureStage;
          message: string;
          details?: Record<string, unknown>;
        }
      | undefined;
    if (viewFailure) {
      failure = {
        code: viewFailure.code,
        stage: "load",
        message: viewFailure.message,
        details: {
          buildState: panel?.artifacts.buildState ?? null,
          buildProgress: panel?.artifacts.buildProgress ?? null,
        },
      };
    } else if (buildError) {
      const unitMissing = /unknown (?:runtime )?build unit|unknown build unit/iu.test(buildError);
      failure = {
        code: unitMissing ? "unit_not_found" : "compile_failed",
        stage: unitMissing ? "resolve" : "build",
        message: buildError,
        details: {
          buildState: panel?.artifacts.buildState ?? null,
          buildProgress: panel?.artifacts.buildProgress ?? null,
        },
      };
    }
    return {
      ...(lease?.holderLabel ? { holderLabel: lease.holderLabel } : {}),
      ...(lease?.platform ? { platform: lease.platform } : {}),
      ...(lease ? { supportsInspection: lease.supportsCdp } : {}),
      viewRevision: this.runtime.viewRevision,
      view: {
        exists: viewExists,
        ...(viewExists ? { url: contents!.getURL(), loading: contents!.isLoading() } : {}),
      },
      boot,
      ...(failure ? { failure } : {}),
    };
  }

  private getPanelUrlForId(panelId: string): string | null {
    const panel = this.registry.getPanel(panelId);
    if (!panel) return null;

    const source = getPanelSource(panel);
    const browserUrl = browserUrlFromPanelSource(source);
    if (browserUrl !== null) {
      return browserUrl;
    }

    return buildPanelUrl({
      source,
      contextId: getPanelContextId(panel),
      buildKey: panel.buildKey ?? null,
      ref: getPanelRef(panel),
      gatewayPort: this.deps.gatewayPort,
      basePath: this.deps.gatewayBasePath,
    });
  }

  private async attachCreatedPanel(
    result: {
      panelId: string;
      title: string;
      contextId?: string;
      source?: string;
      options?: Record<string, unknown>;
    },
    opts: { focus?: boolean } = {}
  ): Promise<void> {
    this.runtime.ensureStateArgsPush(result.panelId);
    try {
      await this.runtime.loadPanelIntoView(result.panelId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/running on|leased by/i.test(message))
        this.runtime.recordPanelViewFailure(result.panelId, message);
      this.runtime.releaseLocalPanelRuntime(result.panelId, "unload");
      throw error;
    }
    if (opts.focus) {
      // `panel-created` above is the sole creation-placement fact. Complete
      // the host-side focus/load mechanics without emitting the existing-panel
      // `navigate-to-panel` event as a second placement request.
      await this.focusPanelLocally(result.panelId);
    }
  }

  private lifecycleResult(
    panelId: string,
    operation: PanelLifecycleResult["operation"],
    status: string,
    flags: Partial<Pick<PanelLifecycleResult, "loaded" | "rebuilt" | "reloaded">> = {}
  ): PanelLifecycleResult {
    const panel = this.registry.getPanel(panelId);
    const source = panel ? getPanelSource(panel) : undefined;
    const ref = panel ? getPanelRef(panel) : undefined;
    return {
      panelId,
      operation,
      status,
      loaded: flags.loaded ?? Boolean(this.getPanelView()?.hasView(panelId)),
      rebuilt: flags.rebuilt ?? false,
      reloaded: flags.reloaded ?? false,
      buildRevision: source ? this.runtime.getBuildRevision(source, ref) : undefined,
      effectiveVersion: panel?.effectiveVersion ?? null,
    };
  }

  // Client-local pins feed the required retention-policy collaborator above;
  // their persistence remains independent from whether a panel is loaded.

  /** Toggle the client-local pin for a slot id; returns the new pinned state. */
  togglePanelPin(panelId: string): boolean {
    return this.deps.pinStore?.toggle(panelId) ?? false;
  }

  isPanelPinned(panelId: string): boolean {
    return this.deps.pinStore?.has(panelId) ?? false;
  }

  listPinnedPanelIds(): string[] {
    return this.deps.pinStore?.list() ?? [];
  }
}
