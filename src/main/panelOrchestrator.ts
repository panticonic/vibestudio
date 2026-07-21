/**
 * PanelOrchestrator — Thin Electron coordinator.
 *
 * Replaces PanelLifecycle on the Electron side. All backend work (tokens,
 * persistence, FS context) goes through server RPCs. This class handles
 * only: server RPC → registry update → view management.
 */

import { createDevLogger } from "@vibestudio/dev-log";
import type {
  PanelFocusResult,
  PanelLifecycleResult,
  PanelNavigationState,
  PanelRecoverySnapshot,
  PanelSnapshot,
  PanelTreeSnapshot,
  PaletteCommand,
  ThemeConfig,
} from "@vibestudio/shared/types";
import type { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import type { EventService } from "@vibestudio/shared/eventsService";
import type { ScopedServerCaller, ServerClient } from "./serverClient.js";
import type { PanelManager } from "@vibestudio/shell-core/panelManager";
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
} from "@vibestudio/shared/panelInterfaces";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import type { PanelRestorePolicy } from "@vibestudio/workspace-contracts/types";
import { buildPanelUrl } from "@vibestudio/shared/panelFactory";
import { asPanelSlotId } from "@vibestudio/shared/panel/ids";
import type { PanelPinStoreApi } from "./panelPinStore.js";
import { getPanelSource, getPanelContextId, getPanelRef } from "@vibestudio/shared/panel/accessors";
import { assertPresent } from "../lintHelpers";
import { PanelRuntimeLeaseController } from "./panelRuntimeLeaseController.js";

const log = createDevLogger("PanelOrchestrator");
type PanelTreeCall = (method: string, args: unknown[]) => Promise<unknown>;

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
}

export class PanelOrchestrator implements BridgePanelLifecycle, PanelHost {
  private readonly deps: PanelOrchestratorDeps;
  private currentTheme: "light" | "dark" = "dark";
  /** App-wide theme identity, broadcast to panels alongside appearance. */
  private currentThemeConfig: ThemeConfig = {
    accentColor: "amber",
    grayColor: "slate",
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
      pinStore: deps.pinStore,
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
  private callPanelTreeAs(
    caller: ScopedServerCaller,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    return this.serverClient.callAs(caller, "panelTree", method, args);
  }

  private callPanelTreeAsServer(method: string, args: unknown[]): Promise<unknown> {
    return this.serverClient.call("panelTree", method, args);
  }

  private panelTreeCallAs(caller: ScopedServerCaller): PanelTreeCall {
    return (method, args) => this.callPanelTreeAs(caller, method, args);
  }

  private panelTreeCallAsServer(): PanelTreeCall {
    return (method, args) => this.callPanelTreeAsServer(method, args);
  }

  // =========================================================================
  // Panel creation
  // =========================================================================

  /**
   * Route a tree-creating mutation through the panelTree authority, then build
   * the local view from the response. The server is the sole writer; it
   * broadcasts the new tree (the mirror updates reactively). We await
   * the panel landing in our mirror before attaching its view so the artifact
   * updates inside attachCreatedPanel have a registry target.
   */
  private async createViaPanelTree(
    source: string,
    createOpts: {
      parentId?: string | null;
      name?: string;
      contextId?: string;
      ref?: string;
      stateArgs?: Record<string, unknown>;
    },
    attachOpts: { focus?: boolean },
    callPanelTree: PanelTreeCall
  ): Promise<{ id: string; title: string }> {
    const result = (await callPanelTree("create", [source, createOpts])) as {
      id: string;
      title: string;
      contextId?: string;
      source?: string;
    };
    try {
      await this.awaitPanelInMirror(result.id);
      await this.attachCreatedPanel(
        {
          panelId: result.id,
          title: result.title,
          contextId: result.contextId,
          source: result.source,
        },
        attachOpts
      );
      return { id: result.id, title: result.title };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.registry.getPanel(result.id)) {
        this.runtime.markPanelLoadError(result.id, message);
        if (attachOpts.focus) await this.focusPanel(result.id).catch(() => {});
      } else {
        await callPanelTree("archive", [result.id]).catch(() => {});
      }
      throw err;
    }
  }

  /** Wait (briefly) for a server-created panel to land in the broadcast mirror. */
  private async awaitPanelInMirror(panelId: string, timeoutMs = 4000): Promise<void> {
    if (this.registry.getPanel(panelId)) return;
    await new Promise<void>((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (this.registry.getPanel(panelId) || Date.now() - start > timeoutMs) {
          resolve();
          return;
        }
        setTimeout(tick, 16);
      };
      tick();
    });
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
    return this.createViaPanelTree(
      source,
      {
        parentId: options?.isRoot ? null : caller ? asPanelSlotId(callerId) : null,
        name: options?.name,
        contextId: options?.contextId,
        ref: options?.ref,
        stateArgs,
      },
      { focus: options?.focus },
      scopedCaller ? this.panelTreeCallAs(scopedCaller) : this.panelTreeCallAsServer()
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
    const result = (await (scopedCaller
      ? this.callPanelTreeAs(scopedCaller, "navigate", [panelId, source, options])
      : this.callPanelTreeAsServer("navigate", [panelId, source, options]))) as {
      id?: string;
      title?: string;
      source?: string;
      contextId?: string;
    } | null;
    if (!result) return null;
    await this.rebuildViewAfterServerNavigate(
      panelId,
      result.source ?? source,
      result.contextId,
      options
    );
    return { id: result.id ?? panelId, title: result.title ?? "" };
  }

  async navigatePanelHistory(
    panelId: string,
    delta: -1 | 1,
    caller?: ScopedServerCaller
  ): Promise<{ id: string; title: string } | null> {
    const result = (await (caller
      ? this.callPanelTreeAs(caller, "navigateHistory", [panelId, delta])
      : this.callPanelTreeAsServer("navigateHistory", [panelId, delta]))) as {
      id?: string;
      title?: string;
      source?: string;
      contextId?: string;
    } | null;
    if (!result) return null;
    await this.rebuildViewAfterServerNavigate(panelId, result.source ?? "", result.contextId);
    return { id: result.id ?? panelId, title: result.title ?? "" };
  }

  /**
   * Rebuild a panel's view after a server-side navigate/history mutation. The
   * desktop applies the broadcast to its registry mirror but does NOT re-sync the
   * panelManager's entity cache, so we explicitly refresh it (otherwise the lease
   * would target the retired previous entity). Browser panels are driven by their
   * own webContents (already navigated), so they only record the source change.
   */
  private async rebuildViewAfterServerNavigate(
    panelId: string,
    newSource: string,
    contextId: string | undefined,
    options?: Record<string, unknown>
  ): Promise<void> {
    if (!newSource || newSource.startsWith("browser:")) return;
    await this.shellCore.refreshSlotEntity(asPanelSlotId(panelId));
    this.runtime.beginNavigation(panelId);
    if (contextId) {
      this.runtime.prepareViewForSnapshot(panelId, {
        source: newSource,
        contextId,
        options: {},
      } as PanelSnapshot);
    }
    await this.attachCreatedPanel(
      { panelId, title: "", contextId, source: newSource, options },
      { focus: true }
    );
  }

  async createBrowserUrlPanel(
    callerId: string,
    url: string,
    options?: { name?: string; focus?: boolean },
    caller?: ScopedServerCaller
  ): Promise<{ id: string; title: string }> {
    // Defensive: reject non-string or non-http(s) URLs early
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      throw new Error(`Invalid browser panel URL (must be http/https string): ${String(url)}`);
    }
    const callerPanel = this.registry.getPanel(callerId);
    const parentId = callerPanel ? asPanelSlotId(callerId) : null;
    return this.createViaPanelTree(
      url,
      { parentId, name: options?.name },
      { focus: options?.focus },
      caller ? this.panelTreeCallAs(caller) : this.panelTreeCallAsServer()
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
    // down views/leases for the removed panels (applyServerPanelTreeSnapshot →
    // pruneRemovedPanelLocally).
    await (caller
      ? this.callPanelTreeAs(caller, "archive", [panelId])
      : this.callPanelTreeAsServer("archive", [panelId]));

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
    } else {
      const result = await this.rebuildUnloadedPanel(panelId);
      return {
        ...result,
        operation: "reload",
        status: result.rebuilt ? "loaded_after_rebuild" : result.status,
      };
    }
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
    this.registry.notifyPanelTreeUpdate();

    this.panelHttpServer?.invalidateBuild(getPanelSource(panel));

    await this.runtime.loadPanelIntoView(panelId);
    const refreshed = this.registry.getPanel(panelId);
    if (refreshed?.artifacts.buildState === "building") {
      this.registry.updateArtifacts(panelId, {
        ...refreshed.artifacts,
        buildProgress: "Rebuilding panel...",
      });
      this.registry.notifyPanelTreeUpdate();
    }
    return this.lifecycleResult(panelId, "rebuild", "rebuild_requested", {
      loaded: Boolean(this.getPanelView()?.hasView(panelId)),
      rebuilt: true,
    });
  }

  invalidateReadyPanels(): void {
    const focusedPanelId = this.registry.getFocusedPanelId();
    let focusedWasReset = false;

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
        if (entry.panelId === focusedPanelId) focusedWasReset = true;
      }
    }

    this.registry.notifyPanelTreeUpdate();
    if (focusedWasReset && focusedPanelId) {
      void this.rebuildUnloadedPanel(focusedPanelId).catch((e) =>
        console.warn(`[PanelOrchestrator] Failed to rebuild ${focusedPanelId}:`, e)
      );
    }
  }

  async rebuildPanel(panelId: string): Promise<PanelLifecycleResult> {
    return this.rebuildUnloadedPanel(panelId, { force: true });
  }

  async rebuildAndReloadPanel(panelId: string): Promise<PanelLifecycleResult> {
    const rebuild = await this.rebuildPanel(panelId);
    const reload = await this.reloadPanel(panelId);
    return this.lifecycleResult(panelId, "rebuildAndReload", "rebuilt_and_reloaded", {
      loaded: reload.loaded,
      rebuilt: rebuild.rebuilt,
      reloaded: reload.reloaded,
    });
  }

  applyBuildComplete(source: string, error?: string): void {
    for (const entry of this.registry.listPanels()) {
      const panel = this.registry.getPanel(entry.panelId);
      if (!panel || getPanelSource(panel) !== source) continue;
      const viewUrl = this.hasPanelView(entry.panelId)
        ? (this.getPanelUrl(entry.panelId) ?? undefined)
        : undefined;
      if (error) {
        this.registry.updateArtifacts(entry.panelId, {
          ...panel.artifacts,
          htmlPath: viewUrl,
          buildState: "error",
          buildRevision: this.runtime.getBuildRevision(source),
          error,
          buildProgress: error,
        });
      } else {
        this.registry.updateArtifacts(entry.panelId, {
          ...panel.artifacts,
          htmlPath: viewUrl,
          buildState: "ready",
          buildRevision: this.runtime.getBuildRevision(source),
          buildProgress: undefined,
          error: undefined,
        });
      }
    }
    this.registry.notifyPanelTreeUpdate();
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

  async snapshot(panelId: string): Promise<unknown> {
    return this.callPanelTreeAsServer("snapshot", [panelId]);
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
    opts: { loadIfNeeded?: boolean } = {}
  ): Promise<PanelFocusResult> {
    const panel = this.registry.getPanel(targetPanelId);
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

    this.registry.updateSelectedPath(targetPanelId);
    this.registry.notifyPanelTreeUpdate();

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
      this.eventService.emit("navigate-to-panel", { panelId: targetPanelId });
      return {
        panelId: targetPanelId,
        status: "loaded",
        focused: true,
        loaded: true,
      };
    }

    if (panel.artifacts.buildState === "error") {
      this.eventService.emit("navigate-to-panel", { panelId: targetPanelId });
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
          this.eventService.emit("navigate-to-panel", { panelId: targetPanelId });
          return {
            panelId: targetPanelId,
            status: "loaded",
            focused: true,
            loaded: true,
          };
        }
        this.eventService.emit("navigate-to-panel", { panelId: targetPanelId });
        this.runtime.markPanelLoadError(targetPanelId, "Panel view was not created");
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
        if (!isLeaseFailure) this.runtime.markPanelLoadError(targetPanelId, message);
        this.eventService.emit("navigate-to-panel", { panelId: targetPanelId });
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

    this.eventService.emit("navigate-to-panel", { panelId: targetPanelId });
    return {
      panelId: targetPanelId,
      status: "focused",
      focused: true,
      loaded: false,
    };
  }

  async ensureLoaded(panelId: string): Promise<PanelFocusResult> {
    const panel = this.registry.getPanel(panelId);
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
      if (!loaded) this.runtime.markPanelLoadError(panelId, "Panel view was not created");
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
      if (!isLeaseFailure) this.runtime.markPanelLoadError(panelId, message);
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

  async initializePanelTree(): Promise<void> {
    // The server is the sole tree authority. This canonical, authenticated
    // panelTree read both performs first-attach seeding for the acting account
    // and returns the resulting authoritative snapshot. Reading workspace-state
    // directly here would bypass the owner-aware service boundary and could
    // strand a fresh shell on an empty mirror forever.
    const snapshot = (await this.callPanelTreeAsServer("getTreeSnapshot", [])) as PanelTreeSnapshot;
    log.info(
      `[initializePanelTree] Received authoritative tree revision ${snapshot.revision} with ${snapshot.forest.reduce((count, group) => count + group.rootPanels.length, 0)} root(s)`
    );
    await this.runtime.applyServerPanelTreeSnapshot(snapshot);
    log.verbose("[initializePanelTree] Applied authoritative tree snapshot");
    await this.runtime.syncLeaseSnapshot().catch((error: unknown) => {
      log.warn(
        `[initializePanelTree] Failed to sync runtime leases: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
    log.verbose("[initializePanelTree] Synchronized runtime lease snapshot");

    const roots = this.registry.getRootPanels();
    if (roots.length === 0) {
      // A genuinely empty workspace has no roots to restore. Nothing is
      // created imperatively on the desktop.
      log.info(`[initializePanelTree] No roots in authoritative tree at init.`);
      this.registry.notifyPanelTreeUpdate();
      return;
    }

    // Mark restored panels as unloaded (they rebuild on focus)
    for (const entry of this.registry.listPanels()) {
      const panel = this.registry.getPanel(entry.panelId);
      if (panel) {
        const hasBuildArtifacts = Boolean(panel.artifacts?.htmlPath || panel.artifacts?.bundlePath);
        if (panel.artifacts?.buildState !== "pending" || hasBuildArtifacts) {
          this.registry.updateArtifacts(entry.panelId, {
            buildState: "pending",
            buildProgress: "Panel unloaded - will rebuild when focused",
          });
        }
      }
    }
    this.registry.notifyPanelTreeUpdate();
    log.info(`[initializePanelTree] Initialized ${this.registry.listPanels().length} panel(s)`);
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
  // Command palette contributions
  // =========================================================================

  /** Palette commands contributed by each panel, keyed by panel id (the same
   *  id `sendPanelEvent` dispatches to). Pruned lazily in `listPaletteCommands`
   *  when a contributing panel's view is gone. */
  private readonly paletteContributions = new Map<string, PaletteCommand[]>();

  registerPaletteCommands(panelId: string, commands: PaletteCommand[]): void {
    if (commands.length === 0) this.paletteContributions.delete(panelId);
    else this.paletteContributions.set(panelId, commands);
  }

  unregisterPaletteCommands(panelId: string): void {
    this.paletteContributions.delete(panelId);
  }

  listPaletteCommands(): Array<{ panelId: string; commands: PaletteCommand[] }> {
    const focused = this.registry.getFocusedPanelId();
    const out: Array<{ panelId: string; commands: PaletteCommand[] }> = [];
    for (const [panelId, commands] of this.paletteContributions) {
      if (this.getPanelView()?.hasView(panelId)) out.push({ panelId, commands });
      else this.paletteContributions.delete(panelId); // prune dead contributor
    }
    // Surface the focused panel's commands first.
    return out.sort((a, b) => (a.panelId === focused ? -1 : b.panelId === focused ? 1 : 0));
  }

  runPaletteCommand(panelId: string, commandId: string): void {
    if (this.getPanelView()?.hasView(panelId)) {
      this.deps.sendPanelEvent(panelId, "runtime:palette-run", { commandId });
    }
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

    this.runtime.unloadPanelTree(panelId, transition);
    this.registry.notifyPanelTreeUpdate();
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

  async applyServerPanelTreeSnapshot(snapshot: PanelTreeSnapshot): Promise<void> {
    await this.runtime.applyServerPanelTreeSnapshot(snapshot);
  }

  applyServerPanelTitleUpdate(update: {
    panelId: string;
    title: string;
    explicit?: boolean;
  }): void {
    this.runtime.applyServerPanelTitleUpdate(update);
  }

  async recoverShellSnapshot(
    opts: { loadFocusedView?: boolean } = {}
  ): Promise<PanelRecoverySnapshot> {
    const { collapsedIds } = await this.shellCore.loadTree();
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

  private getPanelUrlForId(panelId: string): string | null {
    const panel = this.registry.getPanel(panelId);
    if (!panel) return null;

    const source = getPanelSource(panel);
    if (source.startsWith("browser:")) {
      return source.slice("browser:".length);
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
        this.runtime.markPanelLoadError(result.panelId, message);
      this.runtime.releaseLocalPanelRuntime(result.panelId, "unload");
      throw error;
    }
    if (opts.focus) {
      await this.focusPanel(result.panelId);
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
