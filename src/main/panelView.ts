/**
 * PanelView — Electron-only view management service.
 *
 * Manages WebContentsView lifecycle: creating views, tracking browser state,
 * intercepting navigation, and handling crashes. Implements PanelViewLike so
 * PanelOrchestrator can drive view creation without Electron imports.
 */

import { createDevLogger } from "@vibestudio/dev-log";
import type { ViewManager } from "./viewManager.js";
import type { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import type { PanelViewLike, ServerInfoLike } from "@vibestudio/shared/panelInterfaces";
import { BROWSER_SESSION_PARTITION } from "@vibestudio/shared/panelInterfaces";
import type { AppCapability } from "@vibestudio/shared/unitManifest";
import {
  getCurrentSnapshot,
  getPanelSource,
  getPanelContextId,
  getPanelRef,
  updatePanelNavigationState,
} from "@vibestudio/shared/panelTypes";
import { contextIdToPartition } from "@vibestudio/shared/contextIdToPartition.js";
import {
  isManagedHost,
  parsePanelUrl,
  type ParsedPanelUrl,
} from "@vibestudio/shared/shell/urlParsing.js";
import {
  tryParsePanelLocationLink,
  type PanelDisposition,
  type PanelLocation,
} from "@vibestudio/shared/panelLocation.js";
import { selectedWorkspaceNameFromUrl } from "@vibestudio/shared/connect.js";
import { isBrowserPanelSource, panelSourceFromBrowserUrl } from "@vibestudio/shared/panelChrome";
import type { PanelNavigationState } from "@vibestudio/shared/types";
import { logMemorySnapshot } from "./memoryMonitor.js";
import type { BrowserHistoryRecorder, BrowserNavigationIntent } from "./browserHistoryRecorder.js";
// Persistence removed — server panel service handles all persistence

const log = createDevLogger("PanelView");
const TRANSIENT_MAIN_FRAME_LOAD_RETRY_CODES = new Set([-21]); // ERR_NETWORK_CHANGED
const MAX_TRANSIENT_MAIN_FRAME_LOAD_RETRIES = 2;
const TRANSIENT_MAIN_FRAME_LOAD_RETRY_DELAY_MS = 500;

// syncSnapshotFromManifest moved server-side (panelService snapshot replacement handles autoArchiveWhenEmpty)

// Narrow interfaces for dependencies
interface CdpHostLike {
  registerTarget(panelId: string, contentsId: number): void;
  unregisterTarget(panelId: string): void;
  cleanupPanelAccess(panelId: string): void;
}

interface PanelOrchestratorLike {
  createPanel(
    callerId: string,
    source: string,
    options?: {
      name?: string;
      contextId?: string;
      ref?: string;
      focus?: boolean;
      isRoot?: boolean;
    },
    stateArgs?: Record<string, unknown>,
    scopedCaller?: PanelLinkCaller
  ): Promise<{ id: string; title: string }>;
  createBrowserUrlPanel(
    callerId: string,
    url: string,
    options?: { name?: string; focus?: boolean },
    scopedCaller?: PanelLinkCaller
  ): Promise<{ id: string; title: string }>;
  navigatePanel(
    panelId: string,
    source: string,
    options?: {
      contextId?: string;
      ref?: string;
      stateArgs?: Record<string, unknown>;
    }
  ): Promise<{ id: string; title: string } | null>;
  replaceCurrentSnapshot(
    panelId: string,
    contextId: string,
    source?: string,
    stateArgs?: Record<string, unknown>
  ): Promise<void>;
  updatePanelTitle(panelId: string, title: string): Promise<void>;
}

type PanelLinkCaller = { callerId: string; callerKind: "app" };

interface AutofillManagerLike {
  attachToWebContents(webContentsId: number, webContents: Electron.WebContents): void;
  detachFromWebContents(webContentsId: number, webContents?: Electron.WebContents): void;
}

export class PanelView implements PanelViewLike {
  private viewManager: ViewManager;
  private readonly panelRegistry: PanelRegistry;
  private readonly serverInfo: ServerInfoLike;
  private readonly cdpHost: CdpHostLike;
  private readonly panelOrchestrator: PanelOrchestratorLike;
  private readonly managedHosts: readonly string[];
  private readonly managedBasePaths: readonly string[];
  private readonly managedWorkspace?: string;
  private sendPanelEvent?: (panelId: string, event: string, payload: unknown) => void;
  private onPanelLinkError?: (panelId: string, url: string, message: string) => void;
  private onPanelResponsivenessChanged?: (panelId: string, responsive: boolean) => void;
  private autofillManager?: AutofillManagerLike;
  private autofillPreloadPath?: string;
  private panelPreloadPath?: string;
  private appPreloadPath?: string;
  private browserPreloadPath?: string;
  private browserHistoryRecorder?: BrowserHistoryRecorder;

  private browserStateCleanup = new Map<
    string,
    { cleanup: () => void; destroyedHandler: () => void }
  >();
  private linkInterceptionHandlers = new Map<
    string,
    (event: Electron.Event, url: string) => void
  >();
  private contentLoadHandlers = new Map<
    string,
    { domReady?: () => void; didFinishLoad?: () => void }
  >();
  private crashHistory = new Map<string, number[]>();
  private readonly MAX_CRASHES = 3;
  private readonly CRASH_WINDOW_MS = 60000;

  private get gatewayPort() {
    return this.serverInfo.gatewayPort;
  }

  constructor(deps: {
    viewManager: ViewManager;
    panelRegistry: PanelRegistry;
    serverInfo: ServerInfoLike;
    cdpHost: CdpHostLike;
    panelOrchestrator: PanelOrchestratorLike;
    sendPanelEvent?: (panelId: string, event: string, payload: unknown) => void;
    onPanelLinkError?: (panelId: string, url: string, message: string) => void;
    onPanelResponsivenessChanged?: (panelId: string, responsive: boolean) => void;
    autofillManager?: AutofillManagerLike;
    autofillPreloadPath?: string;
    panelPreloadPath?: string;
    appPreloadPath?: string;
    browserPreloadPath?: string;
    browserHistoryRecorder?: BrowserHistoryRecorder;
  }) {
    this.viewManager = deps.viewManager;
    this.panelRegistry = deps.panelRegistry;
    this.serverInfo = deps.serverInfo;
    this.cdpHost = deps.cdpHost;
    this.panelOrchestrator = deps.panelOrchestrator;
    this.managedHosts = this.buildManagedHosts(deps.serverInfo);
    this.managedBasePaths = this.buildManagedBasePaths(deps.serverInfo);
    this.managedWorkspace = deps.serverInfo.gatewayConfig?.serverUrl
      ? (selectedWorkspaceNameFromUrl(deps.serverInfo.gatewayConfig.serverUrl) ?? undefined)
      : undefined;
    this.sendPanelEvent = deps.sendPanelEvent;
    this.onPanelLinkError = deps.onPanelLinkError;
    this.onPanelResponsivenessChanged = deps.onPanelResponsivenessChanged;
    this.autofillManager = deps.autofillManager;
    this.autofillPreloadPath = deps.autofillPreloadPath;
    this.panelPreloadPath = deps.panelPreloadPath;
    this.appPreloadPath = deps.appPreloadPath;
    this.browserPreloadPath = deps.browserPreloadPath;
    this.browserHistoryRecorder = deps.browserHistoryRecorder;
  }

  private buildManagedHosts(serverInfo: ServerInfoLike): string[] {
    const hosts = new Set<string>();
    const addHost = (host: string | undefined) => {
      if (!host) return;
      const normalized = host.trim().toLowerCase();
      if (normalized) hosts.add(normalized);
    };
    const addUrlHost = (value: string | undefined) => {
      if (!value) return;
      try {
        addHost(new URL(value).hostname);
      } catch {
        addHost(value.replace(/:\d+$/, ""));
      }
    };

    addHost(serverInfo.externalHost);
    addUrlHost(serverInfo.gatewayConfig?.serverUrl);
    for (const alias of serverInfo.gatewayConfig?.aliases ?? []) {
      addUrlHost(alias);
    }
    const loopbackHosts = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"];
    if (loopbackHosts.some((host) => hosts.has(host))) {
      for (const host of loopbackHosts) hosts.add(host);
    }
    return [...hosts];
  }

  private buildManagedBasePaths(serverInfo: ServerInfoLike): string[] {
    const paths = new Set<string>();
    for (const value of [
      serverInfo.gatewayConfig?.serverUrl,
      ...(serverInfo.gatewayConfig?.aliases ?? []),
    ]) {
      if (!value) continue;
      try {
        const pathname = new URL(value).pathname.replace(/\/+$/, "");
        if (pathname && pathname !== "/") paths.add(pathname);
      } catch {
        // Invalid gateway configuration fails elsewhere; it is not a managed
        // panel route candidate here.
      }
    }
    // Try the longest workspace prefix first so
    // `/_workspace/<id>/about/new` is not parsed as `/_workspace/<id>`.
    // An origin-root route is valid only when no configured endpoint prefix
    // exists; otherwise a different workspace on the same hub must not be
    // translated into this panel tree.
    if (paths.size === 0) paths.add("");
    return [...paths].sort((a, b) => b.length - a.length);
  }

  private isManagedUrl(url: string): boolean {
    return this.managedHosts.some((host) => isManagedHost(url, host));
  }

  private parseManagedPanelUrl(url: string): ParsedPanelUrl | null {
    const canonical = tryParsePanelLocationLink(url);
    if (canonical) {
      return {
        ...canonical,
        options: {
          name: canonical.name,
          contextId: canonical.contextId,
          focus: canonical.focus,
          ref: canonical.ref,
        },
      };
    }
    for (const basePath of this.managedBasePaths) {
      for (const host of this.managedHosts) {
        const parsed = parsePanelUrl(url, host, basePath);
        if (parsed) return parsed;
      }
    }
    return null;
  }

  // ==== PanelViewLike implementation ========================================

  async createViewForPanel(panelId: string, url: string, contextId?: string): Promise<void> {
    if (this.viewManager.hasView(panelId)) {
      const currentUrl = this.viewManager.getViewUrl(panelId);
      if (currentUrl !== url) void this.viewManager.navigateView(panelId, url);
      return;
    }

    const parentId = this.panelRegistry.findParentId(panelId);

    const view = this.viewManager.createView({
      id: panelId,
      type: "panel",
      preload: this.panelPreloadPath ?? null,
      url,
      parentId: parentId ?? undefined,
      partition: contextId ? contextIdToPartition(contextId) : undefined,
      injectHostThemeVariables: true,
    });

    this.setupBrowserStateTracking(panelId, view.webContents);

    // Register immediately so CDP access checks pass before dom-ready.
    // Root panels are CDP targets too; parentage is no longer an auth input.
    this.cdpHost.registerTarget(panelId, view.webContents.id);
    const domReadyHandler = () => {
      this.cdpHost.registerTarget(panelId, view.webContents.id);
    };
    view.webContents.on("dom-ready", domReadyHandler);
    this.contentLoadHandlers.set(panelId, { domReady: domReadyHandler });

    this.setupLinkInterception(panelId, view.webContents);
  }

  async createViewForApp(
    appId: string,
    url: string,
    contextId?: string,
    capabilities?: readonly AppCapability[],
    identity?: { source?: string; effectiveVersion?: string | null }
  ): Promise<void> {
    if (this.viewManager.hasView(appId)) {
      const currentUrl = this.viewManager.getViewUrl(appId);
      if (currentUrl !== url) {
        await this.viewManager.updateAppView(appId, url, capabilities, identity);
      }
      return;
    }
    if (!this.appPreloadPath) {
      throw new Error("App preload is required for privileged app views");
    }

    const view = this.viewManager.createView({
      id: appId,
      type: "app",
      preload: this.appPreloadPath,
      url,
      partition: contextId ? contextIdToPartition(contextId) : undefined,
      injectHostThemeVariables: true,
      appCapabilities: capabilities,
      hostChrome: capabilities?.includes("panel-hosting") ?? false,
      appIdentity: identity,
    });

    this.setupBrowserStateTracking(appId, view.webContents);
    this.setupLinkInterception(appId, view.webContents);
  }

  setViewVisible(panelId: string, visible: boolean): void {
    this.viewManager.setViewVisible(panelId, visible);
  }

  hasView(panelId: string): boolean {
    return this.viewManager.hasView(panelId);
  }

  destroyView(panelId: string): void {
    const contents = this.viewManager.getWebContents(panelId);
    if (this.autofillManager && contents && !contents.isDestroyed()) {
      this.autofillManager.detachFromWebContents(contents.id, contents);
    }
    this.cleanupBrowserStateTracking(panelId, contents ?? undefined);
    this.cleanupLinkInterception(panelId, contents ?? undefined);
    this.cdpHost.cleanupPanelAccess(panelId);
    this.cdpHost.unregisterTarget(panelId);
    this.crashHistory.delete(panelId);
    this.viewManager.destroyView(panelId);
  }

  reloadView(panelId: string): boolean {
    return this.viewManager.reloadView(panelId);
  }

  async navigateView(panelId: string, url: string): Promise<void> {
    await this.viewManager.navigateView(panelId, url);
  }

  getWebContents(panelId: string): Electron.WebContents | null {
    return this.viewManager.getWebContents(panelId);
  }

  findViewIdByWebContentsId(senderId: number): string | null {
    return this.viewManager.findViewIdByWebContentsId(senderId);
  }

  setProtectedViews(lineage: Set<string>): void {
    this.viewManager.setProtectedViews(lineage);
  }

  /**
   * Create a view for a browser panel (external URL).
   * No auth cookies, no link interception — browser panels navigate freely.
   */
  async createViewForBrowser(panelId: string, url: string, _contextId: string): Promise<void> {
    if (this.viewManager.hasView(panelId)) {
      const currentUrl = this.viewManager.getViewUrl(panelId);
      if (currentUrl !== url) void this.viewManager.navigateView(panelId, url);
      return;
    }

    const parentId = this.panelRegistry.findParentId(panelId);

    const view = this.viewManager.createView({
      id: panelId,
      type: "panel",
      preload: this.browserPreloadPath ?? this.autofillPreloadPath ?? null,
      url,
      parentId: parentId ?? undefined,
      partition: BROWSER_SESSION_PARTITION,
      injectHostThemeVariables: false,
    });

    this.setupBrowserStateTracking(panelId, view.webContents);

    // Register immediately so CDP access checks pass before dom-ready.
    // Root panels are CDP targets too; parentage is no longer an auth input.
    this.cdpHost.registerTarget(panelId, view.webContents.id);
    const domReadyHandler = () => {
      this.cdpHost.registerTarget(panelId, view.webContents.id);
    };
    view.webContents.on("dom-ready", domReadyHandler);
    this.contentLoadHandlers.set(panelId, { domReady: domReadyHandler });

    // Attach autofill for browser panels
    if (this.autofillManager) {
      this.autofillManager.attachToWebContents(view.webContents.id, view.webContents);
    }

    // No setupLinkInterception — browser panels navigate freely
  }

  // ==== Additional public methods ===========================================

  openDevTools(panelId: string): void {
    this.viewManager.openDevTools(panelId);
  }
  getViewPartition(panelId: string): string | undefined | null {
    return this.viewManager.getViewPartition(panelId);
  }
  getViewManager(): ViewManager {
    return this.viewManager;
  }
  markBrowserNavigationIntent(panelId: string, intent: BrowserNavigationIntent): void {
    this.browserHistoryRecorder?.markNext(panelId, intent);
  }

  /** Handle a view crash — implements recovery policy with loop protection. */
  handleViewCrashed(viewId: string, reason: string): void {
    console.warn(`[PanelView] View ${viewId} crashed: ${reason}`);
    void logMemorySnapshot({ reason: `view-crash:${viewId}:${reason}` });

    if (!this.shouldAttemptReload(viewId)) {
      console.error(`[PanelView] Giving up on ${viewId} after repeated crashes`);
      this.showPanelErrorPage(
        viewId,
        "Panel crashed repeatedly",
        `The panel's renderer crashed ${this.MAX_CRASHES} times in a row (last reason: ${reason}). ` +
          "Automatic recovery was stopped to avoid a crash loop."
      );
      return;
    }
    log.verbose(` Attempting reload of ${viewId}`);
    if (!this.viewManager.reloadView(viewId)) {
      console.warn(`[PanelView] Reload failed for ${viewId}, attempting view recreation`);
      void this.recreatePanelView(viewId);
    }
  }

  // ==== Browser state tracking ==============================================

  private setupBrowserStateTracking(panelId: string, contents: Electron.WebContents): void {
    let pendingState: Partial<PanelNavigationState> = {};
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let transientMainFrameLoadRetries = 0;
    let transientLoadRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let cleaned = false;

    const flushPendingState = () => {
      if (cleaned) return;
      if (Object.keys(pendingState).length > 0) {
        this.updatePanelState(panelId, pendingState);
        pendingState = {};
      }
      debounceTimer = null;
    };

    const queueStateUpdate = (update: typeof pendingState) => {
      if (cleaned) return;
      Object.assign(pendingState, update);
      if (!debounceTimer) debounceTimer = setTimeout(flushPendingState, 50);
    };

    const handlers = {
      didNavigate: (_event: Electron.Event, url: string) => {
        log.verbose(` Panel ${panelId} navigated to: ${url}`);
        queueStateUpdate({ url });
        const panel = this.panelRegistry.getPanel(panelId);
        if (!panel) return;
        const currentSource = getPanelSource(panel);
        if (isBrowserPanelSource(currentSource) && /^https?:\/\//i.test(url)) {
          this.browserHistoryRecorder?.recordNavigation(panelId, url, panel.navigation?.pageTitle);
          const nextSource = panelSourceFromBrowserUrl(url);
          if (nextSource !== currentSource) {
            void this.panelOrchestrator
              .replaceCurrentSnapshot(panelId, getPanelContextId(panel), nextSource)
              .catch(() => {});
          }
          return;
        }

        if (/^https?:\/\//i.test(url) && !this.isManagedUrl(url)) {
          this.handlePanelLinkError(
            panelId,
            new Error("Unexpected raw external main-frame navigation"),
            url
          );
          return;
        }

        const parsed = this.parseManagedPanelUrl(url);
        if (parsed && parsed.source !== currentSource) {
          this.handlePanelLinkError(
            panelId,
            new Error("Unexpected raw managed main-frame navigation"),
            url
          );
        }
      },
      didNavigateInPage: (_event: Electron.Event, url: string) => {
        queueStateUpdate({ url });
      },
      didFailLoad: (
        _e: Electron.Event,
        code: number,
        desc: string,
        url: string,
        isMainFrame?: boolean
      ) => {
        console.warn(`[PanelView] Panel ${panelId} failed to load: ${desc} (${code}) - ${url}`);
        // -3 is ERR_ABORTED (navigation superseded) — routine, not a failure.
        if (isMainFrame && code !== -3) {
          if (
            TRANSIENT_MAIN_FRAME_LOAD_RETRY_CODES.has(code) &&
            /^https?:\/\//i.test(url) &&
            transientMainFrameLoadRetries < MAX_TRANSIENT_MAIN_FRAME_LOAD_RETRIES
          ) {
            transientMainFrameLoadRetries += 1;
            if (transientLoadRetryTimer) clearTimeout(transientLoadRetryTimer);
            transientLoadRetryTimer = setTimeout(() => {
              transientLoadRetryTimer = null;
              if (cleaned || contents.isDestroyed()) return;
              log.info(
                `Retrying transient main-frame load for ${panelId} (${transientMainFrameLoadRetries}/${MAX_TRANSIENT_MAIN_FRAME_LOAD_RETRIES}): ${url}`
              );
              contents.loadURL(url).catch((error: unknown) => {
                log.warn(
                  `[PanelView] Retry load failed for ${panelId}: ${
                    error instanceof Error ? error.message : String(error)
                  }`
                );
              });
            }, TRANSIENT_MAIN_FRAME_LOAD_RETRY_DELAY_MS);
            return;
          }
          this.showPanelErrorPage(
            panelId,
            "Panel failed to load",
            `${desc} (${code}) while loading ${url}`,
            url
          );
        }
      },
      renderProcessGone: (_e: Electron.Event, details: Electron.RenderProcessGoneDetails) => {
        console.warn(`[PanelView] Panel ${panelId} render process gone: ${details.reason}`);
      },
      unresponsive: () => {
        console.warn(`[PanelView] Panel ${panelId} became unresponsive`);
        this.onPanelResponsivenessChanged?.(panelId, false);
      },
      responsive: () => {
        log.verbose(` Panel ${panelId} became responsive again`);
        this.onPanelResponsivenessChanged?.(panelId, true);
      },
      didStartLoading: () => {
        queueStateUpdate({ isLoading: true });
      },
      didStopLoading: () => {
        if (contents.isDestroyed()) return;
        queueStateUpdate({
          isLoading: false,
          canGoBack: contents.navigationHistory.canGoBack(),
          canGoForward: contents.navigationHistory.canGoForward(),
        });
      },
      didFinishLoad: () => {
        transientMainFrameLoadRetries = 0;
        if (transientLoadRetryTimer) {
          clearTimeout(transientLoadRetryTimer);
          transientLoadRetryTimer = null;
        }
      },
      pageTitleUpdated: (_event: Electron.Event, title: string) => {
        queueStateUpdate({ pageTitle: title });
        const panel = this.panelRegistry.getPanel(panelId);
        const url = panel?.navigation?.url ?? contents.getURL();
        if (panel && isBrowserPanelSource(getPanelSource(panel))) {
          this.browserHistoryRecorder?.updateTitle(url, title);
        }
      },
    };

    contents.on("did-navigate", handlers.didNavigate);
    contents.on("did-navigate-in-page", handlers.didNavigateInPage);
    contents.on("did-fail-load", handlers.didFailLoad);
    contents.on("render-process-gone", handlers.renderProcessGone);
    contents.on("unresponsive", handlers.unresponsive);
    contents.on("responsive", handlers.responsive);
    contents.on("did-start-loading", handlers.didStartLoading);
    contents.on("did-stop-loading", handlers.didStopLoading);
    contents.on("did-finish-load", handlers.didFinishLoad);
    contents.on("page-title-updated", handlers.pageTitleUpdated);

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      if (transientLoadRetryTimer) clearTimeout(transientLoadRetryTimer);
      if (!contents.isDestroyed()) {
        contents.off("did-navigate", handlers.didNavigate);
        contents.off("did-navigate-in-page", handlers.didNavigateInPage);
        contents.off("did-fail-load", handlers.didFailLoad);
        contents.off("render-process-gone", handlers.renderProcessGone);
        contents.off("unresponsive", handlers.unresponsive);
        contents.off("responsive", handlers.responsive);
        contents.off("did-start-loading", handlers.didStartLoading);
        contents.off("did-stop-loading", handlers.didStopLoading);
        contents.off("did-finish-load", handlers.didFinishLoad);
        contents.off("page-title-updated", handlers.pageTitleUpdated);
      }
      this.browserStateCleanup.delete(panelId);
    };

    const destroyedHandler = () => cleanup();
    contents.once("destroyed", destroyedHandler);
    this.browserStateCleanup.set(panelId, { cleanup, destroyedHandler });
  }

  private cleanupBrowserStateTracking(panelId: string, contents?: Electron.WebContents): void {
    const entry = this.browserStateCleanup.get(panelId);
    if (entry) {
      if (contents && !contents.isDestroyed()) contents.off("destroyed", entry.destroyedHandler);
      entry.cleanup();
    }
    const loadHandlers = this.contentLoadHandlers.get(panelId);
    if (loadHandlers && contents && !contents.isDestroyed()) {
      if (loadHandlers.domReady) contents.off("dom-ready", loadHandlers.domReady);
      if (loadHandlers.didFinishLoad) contents.off("did-finish-load", loadHandlers.didFinishLoad);
    }
    this.contentLoadHandlers.delete(panelId);
  }

  /** Update panel metadata from webview navigation events. */
  private updatePanelState(panelId: string, state: PanelNavigationState): void {
    const panel = this.panelRegistry.getPanel(panelId);
    if (!panel) return;

    updatePanelNavigationState(panel, state);

    if (state.pageTitle !== undefined) {
      void this.panelOrchestrator.updatePanelTitle(panelId, state.pageTitle).catch(() => {});
    }
    this.panelRegistry.notifyPanelTreeUpdate();
  }

  // ==== Link interception ===================================================

  private setupLinkInterception(panelId: string, contents: Electron.WebContents): void {
    contents.setWindowOpenHandler((details) => {
      const url = details.url;
      const parsed = this.parseManagedPanelUrl(url);
      if (parsed) {
        void this.handleManagedLink(panelId, parsed, url, "child").catch((err: unknown) =>
          this.handlePanelLinkError(panelId, err, url)
        );
        return { action: "deny" as const };
      }
      if (/^https?:\/\//i.test(url)) {
        void this.openBrowserLink(panelId, url).catch((err: unknown) =>
          this.handlePanelLinkError(panelId, err, url)
        );
        return { action: "deny" as const };
      }
      this.handlePanelLinkError(
        panelId,
        new Error("This link type is not supported. Use an http(s) or Vibestudio panel link."),
        url
      );
      return { action: "deny" as const };
    });

    const willNavigateHandler = (event: Electron.Event, url: string) => {
      const canonical = tryParsePanelLocationLink(url);
      if (canonical) {
        event.preventDefault();
        const parsed = this.parseManagedPanelUrl(url);
        if (parsed) {
          const fallback = this.getHostedViewInfo(panelId)?.type === "app" ? "root" : "current";
          void this.handleManagedLink(panelId, parsed, url, fallback).catch((err: unknown) =>
            this.handlePanelLinkError(panelId, err, url)
          );
        }
        return;
      }
      if (!this.isManagedUrl(url)) {
        if (/^https?:\/\//i.test(url)) {
          event.preventDefault();
          void this.openBrowserLink(panelId, url).catch((err: unknown) =>
            this.handlePanelLinkError(panelId, err, url)
          );
        }
        return;
      }

      const parsed = this.parseManagedPanelUrl(url);
      if (!parsed) return;

      const viewInfo = this.getHostedViewInfo(panelId);
      if (viewInfo?.type === "app") {
        event.preventDefault();
        void this.handleManagedLink(panelId, parsed, url, "root").catch((err: unknown) =>
          this.handlePanelLinkError(panelId, err, url)
        );
        return;
      }

      const panel = this.panelRegistry.getPanel(panelId);
      if (!panel) return;

      const currentContextId = getPanelContextId(panel);
      const targetContextId = parsed.contextId ?? currentContextId;
      const sourceChanged = parsed.source !== getPanelSource(panel);
      const contextChanged = targetContextId !== currentContextId;
      const refChanged = parsed.ref !== getPanelRef(panel);
      const stateArgsChanged = parsed.stateArgs !== undefined;
      const placementChanged = parsed.disposition !== undefined && parsed.disposition !== "current";
      if (
        !sourceChanged &&
        !contextChanged &&
        !refChanged &&
        !stateArgsChanged &&
        !placementChanged
      ) {
        return;
      }

      event.preventDefault();
      void this.handleManagedLink(panelId, parsed, url, "current").catch((err: unknown) =>
        this.handlePanelLinkError(panelId, err, url)
      );
    };

    this.linkInterceptionHandlers.set(panelId, willNavigateHandler);
    contents.on("will-navigate", willNavigateHandler);
  }

  private cleanupLinkInterception(panelId: string, contents?: Electron.WebContents): void {
    const handler = this.linkInterceptionHandlers.get(panelId);
    if (handler) {
      if (contents && !contents.isDestroyed()) contents.off("will-navigate", handler);
      this.linkInterceptionHandlers.delete(panelId);
    }
  }

  private getHostedViewInfo(viewId: string): { type?: string } | null {
    const viewManager = this.viewManager as unknown as {
      getViewInfo?: (id: string) => { type?: string } | null;
    };
    return viewManager.getViewInfo?.(viewId) ?? null;
  }

  /**
   * App-hosted views act under their own (capability-gated) authority when they
   * open managed links. Panel-hosted views do NOT: acting as the panel would
   * need a second runtime connection, which the panel lease gate rejects (the
   * panel's own connection holds the lease). Host-intercepted links are already
   * structurally scoped to the source slot, so the host translates them as
   * trusted chrome — returning no scoped caller routes the call that way.
   */
  private scopedCallerForHostedView(viewId: string): PanelLinkCaller | undefined {
    const viewInfo = this.getHostedViewInfo(viewId);
    if (viewInfo?.type === "app") return { callerId: viewId, callerKind: "app" };
    return undefined;
  }

  private createOptionsForParsedLink(parsed: ParsedPanelUrl): {
    name?: string;
    contextId?: string;
    ref?: string;
    focus?: boolean;
    isRoot?: boolean;
  } {
    return {
      ...(parsed.options.name !== undefined ? { name: parsed.options.name } : {}),
      ...(parsed.contextId !== undefined ? { contextId: parsed.contextId } : {}),
      ...(parsed.ref !== undefined ? { ref: parsed.ref } : {}),
      ...(parsed.options.focus !== undefined ? { focus: parsed.options.focus } : {}),
    };
  }

  private navigateOptionsForParsedLink(parsed: ParsedPanelUrl): {
    contextId?: string;
    ref?: string;
    stateArgs?: Record<string, unknown>;
  } {
    return {
      ...(parsed.contextId !== undefined ? { contextId: parsed.contextId } : {}),
      ...(parsed.ref !== undefined ? { ref: parsed.ref } : {}),
      ...(parsed.stateArgs !== undefined ? { stateArgs: parsed.stateArgs } : {}),
    };
  }

  private async openManagedLink(
    sourceViewId: string,
    parsed: ParsedPanelUrl,
    url: string,
    disposition: Exclude<PanelDisposition, "current">
  ): Promise<void> {
    const caller = this.scopedCallerForHostedView(sourceViewId);
    const result = await this.panelOrchestrator.createPanel(
      sourceViewId,
      parsed.source,
      {
        ...this.createOptionsForParsedLink(parsed),
        ...(disposition === "root" ? { isRoot: true } : {}),
      },
      parsed.stateArgs,
      caller
    );
    this.sendPanelEvent?.(sourceViewId, "runtime:child-created", { childId: result.id, url });
  }

  private assertLinkWorkspace(location: PanelLocation): void {
    if (
      location.workspace &&
      this.managedWorkspace &&
      location.workspace !== this.managedWorkspace
    ) {
      throw new Error(
        `Panel link targets workspace ${location.workspace}; current workspace is ${this.managedWorkspace}`
      );
    }
  }

  private async handleManagedLink(
    sourceViewId: string,
    parsed: ParsedPanelUrl,
    url: string,
    fallbackDisposition: PanelDisposition
  ): Promise<void> {
    this.assertLinkWorkspace(parsed);
    const disposition = parsed.disposition ?? fallbackDisposition;
    const sourcePanel = this.panelRegistry.getPanel(sourceViewId);
    if (disposition === "current" && sourcePanel) {
      await this.navigateManagedLink(sourceViewId, parsed, url);
      return;
    }
    await this.openManagedLink(
      sourceViewId,
      parsed,
      url,
      disposition === "child" && sourcePanel ? "child" : "root"
    );
  }

  private async openBrowserLink(sourceViewId: string, url: string): Promise<void> {
    const caller = this.scopedCallerForHostedView(sourceViewId);
    const result = await this.panelOrchestrator.createBrowserUrlPanel(
      sourceViewId,
      url,
      { focus: true },
      caller
    );
    this.sendPanelEvent?.(sourceViewId, "runtime:child-created", { childId: result.id, url });
  }

  private async navigateManagedLink(
    panelId: string,
    parsed: ParsedPanelUrl,
    url: string
  ): Promise<void> {
    // Same-frame navigation only happens for panel-hosted slots (app views open
    // links as new root panels), so this is always a trusted-chrome translation
    // of the source slot — no scoped caller.
    const result = await this.panelOrchestrator.navigatePanel(
      panelId,
      parsed.source,
      this.navigateOptionsForParsedLink(parsed)
    );
    if (result) {
      this.sendPanelEvent?.(panelId, "runtime:managed-navigation", { panelId: result.id, url });
    }
  }

  private handlePanelLinkError(viewId: string, error: unknown, url: string): void {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`[PanelView] Failed to handle panel link for ${viewId}: ${url}: ${message}`);
    this.sendPanelEvent?.(viewId, "runtime:child-creation-error", { url, error: message });
    this.onPanelLinkError?.(viewId, url, message);
  }

  // ==== Crash recovery ======================================================

  /**
   * Replace a dead/blank panel with a visible error page instead of leaving
   * it empty. Loading a data: URL spawns a fresh renderer, so this works even
   * after the previous renderer process is gone. The retry link re-navigates
   * to the panel's real URL.
   */
  private showPanelErrorPage(
    panelId: string,
    title: string,
    detail: string,
    retryUrl?: string
  ): void {
    const contents = this.viewManager.getWebContents(panelId);
    if (!contents || contents.isDestroyed()) return;
    const panel = this.panelRegistry.getPanel(panelId);
    const targetUrl = retryUrl ?? (panel ? getCurrentSnapshot(panel).resolvedUrl : null);
    const escapeHtml = (text: string) =>
      text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; background: #f7f7f8; color: #202124;
         display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .box { max-width: 560px; padding: 2rem; }
  h1 { font-size: 1.1rem; color: #b42318; }
  p, summary { font-size: 0.9rem; line-height: 1.5; color: #5f6368; word-break: break-word; }
  a { display: inline-block; color: white; background: #a15c00; padding: .55rem .8rem;
      border-radius: 6px; text-decoration: none; font-weight: 600; }
  details { margin: 1rem 0; }
  @media (prefers-color-scheme: dark) {
    body { background: #272a2d; color: #ddd; }
    h1 { color: #f48771; }
    p, summary { color: #aaa; }
  }
</style></head><body><div class="box">
  <h1>${escapeHtml(title)}</h1>
  <p>The panel stopped unexpectedly. Reload it to try again.</p>
  <details><summary>Technical details</summary><p>${escapeHtml(detail)}</p></details>
  ${targetUrl ? `<p><a href="${escapeHtml(targetUrl)}">Reload panel</a></p>` : panel ? "<p>Open the panel menu and choose Rebuild.</p>" : "<p>Restart Vibestudio from the launcher to recover the app shell.</p>"}
</div></body></html>`;
    void contents
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      .catch(() => {});
  }

  private shouldAttemptReload(viewId: string): boolean {
    const now = Date.now();
    const history = this.crashHistory.get(viewId) ?? [];
    const recent = history.filter((t) => now - t < this.CRASH_WINDOW_MS);
    if (recent.length >= this.MAX_CRASHES) return false;
    recent.push(now);
    this.crashHistory.set(viewId, recent);
    return true;
  }

  private async recreatePanelView(panelId: string): Promise<void> {
    const panel = this.panelRegistry.getPanel(panelId);
    if (!panel) {
      console.error(`[PanelView] Cannot recreate view: panel ${panelId} not found`);
      return;
    }

    if (this.viewManager.hasView(panelId)) {
      log.verbose(` Destroying zombie view for ${panelId}`);
      this.viewManager.destroyView(panelId);
    }

    try {
      const builtUrl = getCurrentSnapshot(panel).resolvedUrl;
      if (builtUrl) {
        await this.createViewForPanel(panelId, builtUrl, getPanelContextId(panel));
        log.verbose(` Recreated view for ${panelId}`);
      } else {
        log.verbose(` No built URL for ${panelId}, triggering rebuild`);
        panel.artifacts = { buildState: "pending" };
        this.panelRegistry.notifyPanelTreeUpdate();
      }
    } catch (error) {
      console.error(
        `[PanelView] Failed to recreate view for ${panelId}:`,
        error instanceof Error ? error.message : error
      );
      panel.artifacts = { buildState: "pending" };
      this.panelRegistry.notifyPanelTreeUpdate();
    }
  }
}
