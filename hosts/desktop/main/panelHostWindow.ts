import { app, BaseWindow, dialog, nativeTheme, screen, shell } from "electron";
import * as path from "node:path";
import type { EventService } from "@vibestudio/shared/eventsService";
import type { ShellSurfaceDescriptor } from "@vibestudio/shared/shellSurface";
import type { ClientMenus } from "./clientMenu.js";
import type { PanelLocation } from "@vibestudio/shared/panelLocation";
import type { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import { createDevLogger } from "@vibestudio/dev-log";
import { ViewManager, type BrowserDataSurface } from "./viewManager.js";
import { WorkspaceNativeViews } from "./workspaceNativeViews.js";
import { PanelView } from "./panelView.js";
import type { PanelOrchestrator } from "./panelOrchestrator.js";
import type { FormFillManager } from "./autofill/formFillManager.js";
import type { BrowserFaviconObserver } from "./services/browserFaviconObserver.js";
import type { BrowserPermissionController } from "./services/browserPermissionController.js";
import type { ApprovalAttention } from "./approvalAttention.js";
import type { WorkspaceSessionConnection } from "./sessionConnection.js";
import { WebsiteNotificationBridge } from "./services/websiteNotificationBridge.js";
import { BrowserHistoryRecorder } from "./browserHistoryRecorder.js";
import {
  setMemoryMonitorViewManager,
  setMemoryPressureHandler,
  startMemoryMonitor,
} from "./memoryMonitor.js";
import { recordPanelInitializationFailure } from "./panelInitializationFailure.js";
import { DesktopWindowState } from "./desktopWindowState.js";

const log = createDevLogger("PanelHostWindow");

interface CdpRegistrationAdapter {
  registerTarget(panelId: string, contentsId: number): void;
  unregisterTarget(panelId: string, contentsId: number): void;
  cleanupPanelAccess(panelId: string): void;
  isTargetUnderAutomation(targetId: string): boolean;
  emitBrowserActivity?(panelId: string, activity: "popup" | "download", payload: unknown): void;
}

export interface WorkspaceWindowServices {
  openShellSurface?: (target: ShellSurfaceDescriptor) => void;
  panelRegistry: PanelRegistry;
  panelOrchestrator: PanelOrchestrator;
  serverSession: WorkspaceSessionConnection;
  eventService: EventService;
  cdpHost: CdpRegistrationAdapter;
  formFillManager: FormFillManager | null;
  browserDataSurface?: BrowserDataSurface | null;
  recordBrowserHistory?: boolean;
  browserFaviconObserver: BrowserFaviconObserver | null;
  getBrowserPermissionController(): BrowserPermissionController | null;
}

export interface PanelHostWindowDeps {
  openPanelLocation: (location: PanelLocation) => void;
  eventService: EventService;
  getSystemWorkspaceId(): string | null;
  isHeadlessHost: boolean;
  getWindowTitle: () => string;
  getApprovalAttention: () => ApprovalAttention | null;
  /** A headless host has no client; it prepares its panels as soon as the window exists. */
  initializePanelTreeOnce: (reason: string) => void;
  onHostedShellReady?: () => void;
  onCodeIdentityChanged?: (nativeId: string) => void;
  onWindowClosed: () => void;
  /** Menus clients contributed; the window's chrome-owned chords come from here. */
  menus: ClientMenus;
}

interface PanelHostWindowLifetime {
  /** Identifies this window's contributed menu and relayed menu actions. */
  windowId: string;
  window: BaseWindow;
  viewManager: ViewManager;
  panelViews: Map<string, PanelView>;
  websiteNotifications: WebsiteNotificationBridge;
  closed: boolean;
}

function chromeWindowColors(dark: boolean): { background: string; symbol: string } {
  return dark
    ? { background: "#111419", symbol: "#b1bbcb" }
    : { background: "#edf1f6", symbol: "#445166" };
}

/**
 * The window of the one panel-hosting client on this device, and every
 * renderer-host object whose lifetime is that window: the compositor, the
 * per-workspace panel views and the website bridges. Panels can be presented
 * in one place only, so panel hosting is a per-device singleton surface;
 * clients that do not host panels run in plain client windows.
 */
export class PanelHostWindow {
  private currentLifetime: PanelHostWindowLifetime | null = null;
  private readonly workspaceServices = new Map<string, WorkspaceWindowServices>();
  private readonly workspaceViewReleases = new Map<string, Array<() => void>>();
  private focusedWorkspaceId: string | null = null;

  constructor(private readonly deps: PanelHostWindowDeps) {}

  get focusedWorkspace(): string | null {
    return this.focusedWorkspaceId;
  }

  get window(): BaseWindow | null {
    return this.currentLifetime?.window ?? null;
  }

  get viewManager(): ViewManager | null {
    return this.currentLifetime?.viewManager ?? null;
  }

  closeBrowserDataSettings(workspaceId: string): void {
    this.deps.eventService.emit("close-settings", { workspaceId });
  }

  focusBrowserDataBoundary(workspaceId: string, backward: boolean): void {
    this.deps.eventService.emit("browser-data:focus-boundary", { workspaceId, backward });
  }

  get panelView(): PanelView | null {
    const id = this.deps.getSystemWorkspaceId();
    return id ? this.getWorkspacePanelView(id) : null;
  }

  getWorkspacePanelView(workspaceId: string): PanelView | null {
    return this.currentLifetime?.panelViews.get(workspaceId) ?? null;
  }

  focusWorkspace(workspaceId: string | null): void {
    if (workspaceId !== null && !this.workspaceServices.has(workspaceId))
      throw new Error(`Workspace is not open: ${workspaceId}`);
    if (this.focusedWorkspaceId !== workspaceId) {
      const closed = this.viewManager?.dismissBrowserDataSurface();
      if (closed) this.closeBrowserDataSettings(closed);
    }
    this.focusedWorkspaceId = workspaceId;
  }

  detachWorkspace(workspaceId: string): void {
    const lifetime = this.currentLifetime;
    lifetime?.websiteNotifications.detachWorkspace(workspaceId);
    for (const release of this.workspaceViewReleases.get(workspaceId) ?? []) release();
    this.workspaceViewReleases.delete(workspaceId);
    lifetime?.panelViews.get(workspaceId)?.dispose();
    lifetime?.panelViews.delete(workspaceId);
    this.workspaceServices.delete(workspaceId);
    if (lifetime) {
      for (const id of lifetime.viewManager.getViewIds()) {
        if (lifetime.viewManager.getViewInfo(id)?.workspaceIdentity?.workspaceId === workspaceId)
          lifetime.viewManager.destroyView(id);
      }
      lifetime.viewManager.setWorkspaceProtectedViews(workspaceId, new Set());
    }
    if (this.focusedWorkspaceId === workspaceId) this.focusedWorkspaceId = null;
  }

  handleWebsiteNotificationAction(workspaceId: string, id: string, actionId: string): void {
    if (!this.workspaceServices.has(workspaceId)) return;
    this.currentLifetime?.websiteNotifications.handleAction(workspaceId, id, actionId);
  }

  /** Identifies this window's contributed menu; null when closed. */
  get windowId(): string | null {
    return this.currentLifetime?.windowId ?? null;
  }

  get isOpen(): boolean {
    const lifetime = this.currentLifetime;
    return Boolean(lifetime && !lifetime.closed && !lifetime.window.isDestroyed());
  }

  showAndFocus(): void {
    const window = this.currentLifetime?.window;
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  requestAttention(): void {
    const window = this.currentLifetime?.window;
    if (!window || window.isDestroyed()) return;
    window.flashFrame(true);
  }

  setTitle(title: string): void {
    const window = this.currentLifetime?.window;
    if (window && !window.isDestroyed()) window.setTitle(title);
  }

  /** Open the window (idempotent while it is open) and attach the workspaces already known. */
  open(windowId: string): void {
    const existing = this.currentLifetime;
    if (existing) {
      if (!existing.closed && !existing.window.isDestroyed()) {
        this.attachWorkspaceWindowServices(existing);
        return;
      }
      // A native close may make the window observably destroyed before its
      // `closed` callback runs. Retire that exact generation synchronously so a
      // reopen cannot be cleared later by the stale callback.
      this.teardownLifetime(existing);
    }

    const chrome = chromeWindowColors(nativeTheme.shouldUseDarkColors);
    const windowState = this.deps.isHeadlessHost
      ? null
      : new DesktopWindowState(path.join(app.getPath("userData"), "desktop-window-state.json"));
    const bounds = windowState?.initialBounds(
      (saved) => (saved ? screen.getDisplayMatching(saved) : screen.getPrimaryDisplay()).workArea
    ) ?? { width: 1440, height: 900 };
    const window = new BaseWindow({
      ...bounds,
      show: false,
      icon: path.join(__dirname, "assets", "brand", "vibestudio-symbol-512.png"),
      skipTaskbar: this.deps.isHeadlessHost,
      backgroundColor: chrome.background,
      titleBarStyle: "hidden",
      ...(process.platform !== "darwin"
        ? {
            titleBarOverlay: {
              height: 28,
              color: chrome.background,
              symbolColor: chrome.symbol,
            },
          }
        : {}),
    });
    const viewManager = new ViewManager({
      window,
      shellOverlayPreload: path.join(__dirname, "shellOverlayPreload.cjs"),
      contentOverlayPreload: path.join(__dirname, "contentOverlayPreload.cjs"),
      chromeShortcuts: this.deps.menus.shortcutsFor(windowId),
      headless: this.deps.isHeadlessHost,
      hidePanelViewsUntilHostedShellReady: true,
    });
    windowState?.attach(
      window,
      (error) => log.warn(`[window] Failed to save window state: ${String(error)}`),
      () => viewManager.getWindowFullscreenPreference()
    );
    if (this.deps.onCodeIdentityChanged)
      viewManager.onCodeIdentityChanged(this.deps.onCodeIdentityChanged);
    const websiteNotifications = new WebsiteNotificationBridge({
      resolveOwner: (contents) => {
        const nativeId = viewManager.findViewIdByWebContentsId(contents.id);
        const identity = nativeId
          ? viewManager.getViewInfo(nativeId)?.workspaceIdentity
          : undefined;
        if (!identity) return null;
        const owner = this.workspaceServices.get(identity.workspaceId);
        const permissions = owner?.getBrowserPermissionController();
        if (!owner || !permissions) return null;
        return {
          workspaceId: identity.workspaceId,
          panelId: identity.runtimeId,
          permissions,
          eventService: owner.eventService,
        };
      },
    });
    const lifetime: PanelHostWindowLifetime = {
      windowId,
      window,
      viewManager,
      panelViews: new Map(),
      websiteNotifications,
      closed: false,
    };
    this.currentLifetime = lifetime;
    websiteNotifications.start();
    // Native→shell focus feedback (§5.2): surface native view focus
    // transitions so the shell's layout focus follows every route, not just
    // shell-initiated clicks. Cleared with the viewManager on window teardown.
    viewManager.onNativeSlotFocused((payload) => {
      const identity = viewManager.getViewInfo(payload.panelId)?.workspaceIdentity;
      if (!identity) return;
      this.focusWorkspace(identity.workspaceId);
      this.workspaceServices
        .get(identity.workspaceId)
        ?.eventService.emit("native-slot-focused", { ...payload, panelId: identity.runtimeId });
    });
    if (this.deps.onHostedShellReady) {
      viewManager.onHostedShellReady(this.deps.onHostedShellReady);
    }

    viewManager.onViewCrashed((viewId, reason) => {
      const identity = viewManager.getViewInfo(viewId)?.workspaceIdentity;
      if (!identity) return;
      const owner = this.workspaceServices.get(identity.workspaceId);
      if (!owner) return;
      void owner.panelOrchestrator
        .handlePanelViewCrash(identity.runtimeId, reason)
        .catch((error) => {
          log.warn("Failed to recover crashed panel presentation", {
            panelId: viewId,
            reason,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    });
    window.setTitle(this.deps.getWindowTitle());
    window.on("focus", () => {
      this.deps.menus.applyFor(windowId);
      app.setBadgeCount(0);
      this.deps.getApprovalAttention()?.handleWindowFocus();
      void this.deps.getApprovalAttention()?.refresh({ quiet: true });
    });
    // Release child views and overlays while Electron's native window is still
    // alive. Waiting for `closed` means BaseWindow has already destroyed those
    // children, so ownership cleanup becomes a second native destroy and panel
    // sessions can outlive their host during quit. Keep `closed` as an
    // idempotent fallback for abnormal native teardown.
    window.on("close", () => this.teardownLifetime(lifetime));
    window.on("closed", () => this.teardownLifetime(lifetime));

    this.attachWorkspaceWindowServices(lifetime);
    setMemoryMonitorViewManager(viewManager);
    setMemoryPressureHandler((message) => {
      this.deps.eventService.emit("notification:show", {
        id: "memory-pressure",
        type: "warning",
        title: "High panel memory use",
        message,
        ttl: 12_000,
      });
    });
    startMemoryMonitor();
    if (this.deps.isHeadlessHost) this.deps.initializePanelTreeOnce("headless-host-startup");
  }

  attachWorkspaceServices(services: WorkspaceWindowServices): void {
    const id = services.serverSession.workspaceId;
    const existing = this.workspaceServices.get(id);
    if (existing && existing !== services)
      throw new Error(`Workspace window services already attached: ${id}`);
    this.workspaceServices.set(id, services);
    this.attachWorkspaceWindowServices();
  }

  repaintChrome(dark: boolean): void {
    const window = this.currentLifetime?.window;
    if (!window || window.isDestroyed()) return;
    const chrome = chromeWindowColors(dark);
    try {
      window.setBackgroundColor(chrome.background);
      if (process.platform !== "darwin") {
        window.setTitleBarOverlay({ color: chrome.background, symbolColor: chrome.symbol });
      }
    } catch {
      // Window teardown can race a theme event. A recreated window uses the current theme.
    }
  }

  private attachWorkspaceWindowServices(
    lifetime: PanelHostWindowLifetime | null = this.currentLifetime
  ): void {
    if (!lifetime || lifetime.closed || this.currentLifetime !== lifetime) return;
    const { window, viewManager } = lifetime;

    for (const services of this.workspaceServices.values()) {
      if (lifetime.panelViews.has(services.serverSession.workspaceId)) continue;
      const browserHistoryRecorder = services.recordBrowserHistory
        ? new BrowserHistoryRecorder(services.serverSession.serverClient)
        : undefined;
      const nativeViews = new WorkspaceNativeViews(services.serverSession.workspaceId, viewManager);
      const panelView = new PanelView({
        openPanelLocation: this.deps.openPanelLocation,
        openShellSurface: services.openShellSurface,
        nativeStorageScope: services.serverSession.nativeStorageScope,
        viewManager: nativeViews,
        panelRegistry: services.panelRegistry,
        serverInfo: services.serverSession.serverInfo,
        cdpHost: services.cdpHost,
        panelOrchestrator: services.panelOrchestrator,
        sendPanelEvent: (panelId, event, payload) => {
          const contents = nativeViews.getWebContents(panelId);
          if (contents && !contents.isDestroyed()) {
            contents.send("vibestudio:event", event, payload);
          }
        },
        onPanelLinkError: (_panelId, url, message) => {
          services.eventService.emit("notification:show", {
            id: `panel-link-error:${Date.now()}`,
            type: "error",
            title: "Couldn't open link",
            message: `${message} (${url})`,
            ttl: 10_000,
          });
        },
        openExternal: async (url) => {
          const result = await dialog.showMessageBox(window, {
            type: "question",
            title: "Open external application?",
            message: "This link opens outside Vibestudio.",
            detail: url,
            buttons: ["Open", "Cancel"],
            defaultId: 1,
            cancelId: 1,
            noLink: true,
          });
          if (result.response === 0) await shell.openExternal(url);
        },
        requestSiteCapability: (contents, capability) =>
          services.getBrowserPermissionController()?.requestSiteCapability(contents, capability) ??
          Promise.resolve(false),
        onPanelResponsivenessChanged: (panelId, responsive) => {
          services.eventService.emit("panel-responsiveness-changed", { panelId, responsive });
        },
        onPanelViewTransition: (panelId) => {
          void services.panelOrchestrator.reportPanelViewTransition(panelId).catch((error) => {
            log.warn("Failed to publish panel view transition", {
              panelId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        },
        onPreloadFailure: (panelId, contentsId, message) => {
          if (!services.panelRegistry.getPanel(panelId)) {
            const currentContents = nativeViews.getWebContents(panelId);
            if (
              !currentContents ||
              currentContents.isDestroyed() ||
              currentContents.id !== contentsId
            ) {
              return;
            }
            recordPanelInitializationFailure(
              `hosted-app-preload:${panelId}`,
              new Error(message),
              "host-launch"
            );
            services.eventService.emit("notification:show", {
              id: `app-preload-error:${panelId}:${Date.now()}`,
              type: "error",
              title: "App failed to start",
              message,
              ttl: 10_000,
            });
            return;
          }
          void services.panelOrchestrator
            .reportPanelPreloadFailure(panelId, contentsId, message)
            .catch((error) => {
              log.warn("Failed to publish panel preload failure", {
                panelId,
                error: error instanceof Error ? error.message : String(error),
              });
            });
        },
        onPanelDocumentCommitted: (panelId, url) => {
          services.panelOrchestrator.onExternalDocumentCommitted(panelId, url);
        },
        ...(services.formFillManager ? { formFillManager: services.formFillManager } : {}),
        ...(services.browserFaviconObserver
          ? { browserFaviconObserver: services.browserFaviconObserver }
          : {}),
        panelPreloadPath: path.join(__dirname, "panelPreload.cjs"),
        clientPreloadPath: path.join(__dirname, "clientPreload.cjs"),
        browserPreloadPath: path.join(__dirname, "browserPreload.cjs"),
        browserHistoryRecorder,
      });
      lifetime.panelViews.set(services.serverSession.workspaceId, panelView);
      const releases = this.workspaceViewReleases.get(services.serverSession.workspaceId) ?? [];
      if (services.browserDataSurface)
        releases.push(
          viewManager.registerBrowserDataSurface(
            services.serverSession.workspaceId,
            services.browserDataSurface
          )
        );
      const formFillManager = services.formFillManager;
      if (formFillManager) {
        formFillManager.setWindow(window);
        releases.push(
          viewManager.onViewOrderChanged(() => formFillManager.onViewOrderChanged()),
          viewManager.onViewHidden((viewId) => {
            const identity = viewManager.getViewInfo(viewId)?.workspaceIdentity;
            if (identity?.workspaceId === services.serverSession.workspaceId)
              formFillManager.onPanelHidden(identity.runtimeId);
          })
        );
      }
      this.workspaceViewReleases.set(services.serverSession.workspaceId, releases);
    }
  }

  private teardownLifetime(lifetime: PanelHostWindowLifetime): void {
    if (lifetime.closed) return;
    lifetime.closed = true;
    lifetime.websiteNotifications.stop();
    for (const releases of this.workspaceViewReleases.values())
      for (const release of releases) release();
    this.workspaceViewReleases.clear();

    // PanelView owns the meaning of child WebContents destruction. Disarm its
    // per-view observers before ViewManager performs host-owned native teardown
    // so closing a desktop window cannot masquerade as a panel calling
    // window.close() and issue durable close RPCs during session shutdown.
    try {
      for (const panelView of lifetime.panelViews.values()) panelView.dispose();
    } catch (error) {
      log.error(
        `[window] Failed to dispose PanelView: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    // ViewManager owns timers, native overlays, child views, and callbacks. It
    // must be destroyed while the rest of this generation is still reachable;
    // clearing references first would orphan those resources permanently.
    try {
      lifetime.viewManager.destroy();
    } catch (error) {
      log.error(
        `[window] Failed to destroy ViewManager: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    // A delayed `closed` event from an already-retired generation must never
    // clear the globals or references installed by a newer window.
    if (this.currentLifetime !== lifetime) return;

    this.deps.menus.clear(lifetime.windowId);
    setMemoryMonitorViewManager(null);
    lifetime.panelViews.clear();
    this.currentLifetime = null;
    this.deps.onWindowClosed();
  }
}
