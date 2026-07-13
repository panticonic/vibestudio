import { app, BaseWindow, nativeTheme } from "electron";
import * as path from "node:path";
import type { EventService } from "@vibestudio/shared/eventsService";
import type { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import { createDevLogger } from "@vibestudio/dev-log";
import { ViewManager } from "./viewManager.js";
import { PanelView } from "./panelView.js";
import type { PanelOrchestrator } from "./panelOrchestrator.js";
import type { AutofillManager } from "./autofill/autofillManager.js";
import type { ApprovalAttention } from "./approvalAttention.js";
import type { SessionConnection } from "./serverSession.js";
import { BrowserHistoryRecorder } from "./browserHistoryRecorder.js";
import { AppOrchestrator } from "./appOrchestrator.js";
import {
  setMemoryMonitorViewManager,
  setMemoryPressureHandler,
  startMemoryMonitor,
} from "./memoryMonitor.js";
import { setMenuEventService, setMenuViewManager, setupMenu } from "./menu.js";
import { setupTestApi } from "./testApi.js";
import { getResourcesPath } from "./paths.js";
import { assertPresent } from "../lintHelpers";

const log = createDevLogger("ApplicationWindowController");

interface CdpRegistrationAdapter {
  registerTarget(panelId: string, contentsId: number): void;
  unregisterTarget(panelId: string): void;
  cleanupPanelAccess(panelId: string): void;
}

export interface WorkspaceWindowServices {
  panelRegistry: PanelRegistry;
  panelOrchestrator: PanelOrchestrator;
  serverSession: SessionConnection;
  cdpHost: CdpRegistrationAdapter;
  autofillManager: AutofillManager | null;
}

export interface ApplicationWindowControllerDeps {
  eventService: EventService;
  isHeadlessHost: boolean;
  getWindowTitle: () => string;
  getApprovalAttention: () => ApprovalAttention | null;
  stopElectronHostTargetLaunchLoop: () => void;
  startElectronHostTargetLaunchLoop: (serverClient: SessionConnection["serverClient"]) => void;
  drainPendingReadyElectronLaunch: () => Promise<void>;
  initializePanelTreeOnce: (reason: string) => void;
  onWindowClosed: () => void;
}

interface ApplicationWindowLifetime {
  window: BaseWindow;
  viewManager: ViewManager;
  panelView: PanelView | null;
  appOrchestrator: AppOrchestrator | null;
  closed: boolean;
}

export function chromeWindowColors(dark: boolean): { background: string; symbol: string } {
  return dark
    ? { background: "#272a2d", symbol: "#c7c9ce" }
    : { background: "#f0f0f3", symbol: "#44474d" };
}

/** Owns the Electron window and every renderer-host object whose lifetime is the window. */
export class ApplicationWindowController {
  private currentLifetime: ApplicationWindowLifetime | null = null;
  private workspaceServices: WorkspaceWindowServices | null = null;

  constructor(private readonly deps: ApplicationWindowControllerDeps) {}

  get window(): BaseWindow | null {
    return this.currentLifetime?.window ?? null;
  }

  get viewManager(): ViewManager | null {
    return this.currentLifetime?.viewManager ?? null;
  }

  get panelView(): PanelView | null {
    return this.currentLifetime?.panelView ?? null;
  }

  get appOrchestrator(): AppOrchestrator | null {
    return this.currentLifetime?.appOrchestrator ?? null;
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

  create(): void {
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
    const window = new BaseWindow({
      width: 1200,
      height: 600,
      show: false,
      icon: path.join(__dirname, "assets", "brand", "vibestudio-icon-512.png"),
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
      shellPreload: path.join(__dirname, "bootstrapPreload.cjs"),
      shellOverlayPreload: path.join(__dirname, "shellOverlayPreload.cjs"),
      contentOverlayPreload: path.join(__dirname, "contentOverlayPreload.cjs"),
      shellHtmlPath: path.join(__dirname, "index.html"),
      shellAdditionalArguments: [],
      devTools: false,
      showWindowOnShellLoad: !this.deps.isHeadlessHost,
      hidePanelViewsUntilHostedShellReady: true,
    });
    const lifetime: ApplicationWindowLifetime = {
      window,
      viewManager,
      panelView: null,
      appOrchestrator: null,
      closed: false,
    };
    this.currentLifetime = lifetime;
    window.setTitle(this.deps.getWindowTitle());
    window.on("focus", () => {
      app.setBadgeCount(0);
      this.deps.getApprovalAttention()?.handleWindowFocus();
      void this.deps.getApprovalAttention()?.refresh({ quiet: true });
    });
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
    setMenuViewManager(viewManager);
    setMenuEventService(this.deps.eventService);
    if (!this.deps.isHeadlessHost) this.setupApplicationMenu(window, viewManager);
    if (this.deps.isHeadlessHost) this.deps.initializePanelTreeOnce("headless-host-startup");
  }

  attachWorkspaceServices(services: WorkspaceWindowServices): void {
    this.workspaceServices = services;
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
    lifetime: ApplicationWindowLifetime | null = this.currentLifetime
  ): void {
    const services = this.workspaceServices;
    if (
      !services ||
      !lifetime ||
      lifetime.closed ||
      this.currentLifetime !== lifetime ||
      lifetime.panelView
    ) {
      return;
    }
    const { window, viewManager } = lifetime;

    const browserHistoryRecorder = new BrowserHistoryRecorder(services.serverSession.serverClient);
    const panelView = new PanelView({
      viewManager,
      panelRegistry: services.panelRegistry,
      serverInfo: services.serverSession.serverInfo,
      cdpHost: services.cdpHost,
      panelOrchestrator: services.panelOrchestrator,
      sendPanelEvent: (panelId, event, payload) => {
        const contents = viewManager.getWebContents(panelId);
        if (contents && !contents.isDestroyed()) {
          contents.send("vibestudio:event", event, payload);
        }
      },
      onPanelLinkError: (_panelId, url, message) => {
        this.deps.eventService.emit("notification:show", {
          id: `panel-link-error:${Date.now()}`,
          type: "error",
          title: "Couldn't open link",
          message: `${message} (${url})`,
          ttl: 10_000,
        });
      },
      onPanelResponsivenessChanged: (panelId, responsive) => {
        this.deps.eventService.emit("panel-responsiveness-changed", { panelId, responsive });
      },
      ...(services.autofillManager ? { autofillManager: services.autofillManager } : {}),
      autofillPreloadPath: path.join(__dirname, "autofillPreload.cjs"),
      panelPreloadPath: path.join(__dirname, "panelPreload.cjs"),
      appPreloadPath: path.join(__dirname, "appPreload.cjs"),
      browserPreloadPath: path.join(__dirname, "browserPreload.cjs"),
      browserHistoryRecorder,
    });
    lifetime.panelView = panelView;
    const appOrchestrator = new AppOrchestrator({
      getPanelView: () => lifetime.panelView,
      statePath: services.serverSession.statePath,
    });
    lifetime.appOrchestrator = appOrchestrator;

    void this.deps.drainPendingReadyElectronLaunch().catch((error: unknown) => {
      log.warn(
        `[apps] Failed to apply held Electron host target: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
    this.deps.startElectronHostTargetLaunchLoop(services.serverSession.serverClient);
    void assertPresent(lifetime.appOrchestrator)
      .loadBakedApp(path.join(getResourcesPath(), "baked-app"))
      .then((loaded) => {
        if (loaded && this.currentLifetime === lifetime && !lifetime.closed) {
          this.deps.initializePanelTreeOnce("baked-electron-host");
        }
      })
      .catch((error: unknown) => {
        log.error(
          `[dist] Failed to load baked app payload: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });

    const autofillManager = services.autofillManager;
    if (autofillManager) {
      autofillManager.setWindow(window);
      viewManager.onViewOrderChanged(() => autofillManager.onViewOrderChanged());
      viewManager.onViewHidden((viewId) => autofillManager.onPanelHidden(viewId));
    }
    viewManager.onViewCrashed((viewId, reason) => panelView.handleViewCrashed(viewId, reason));
    setupTestApi(services.panelOrchestrator, services.panelRegistry, panelView);
  }

  private setupApplicationMenu(window: BaseWindow, viewManager: ViewManager): void {
    setupMenu(window, viewManager.getShellWebContents(), {
      onHistoryBack: () => {
        const currentViewManager = this.currentLifetime?.viewManager;
        if (!currentViewManager) return;
        const panelId = this.workspaceServices?.panelRegistry.getFocusedPanelId();
        if (!panelId) return;
        const contents = currentViewManager.getWebContents(panelId);
        if (contents && !contents.isDestroyed() && contents.navigationHistory.canGoBack()) {
          contents.navigationHistory.goBack();
        }
      },
      onHistoryForward: () => {
        const currentViewManager = this.currentLifetime?.viewManager;
        if (!currentViewManager) return;
        const panelId = this.workspaceServices?.panelRegistry.getFocusedPanelId();
        if (!panelId) return;
        const contents = currentViewManager.getWebContents(panelId);
        if (contents && !contents.isDestroyed() && contents.navigationHistory.canGoForward()) {
          contents.navigationHistory.goForward();
        }
      },
    });
  }

  private teardownLifetime(lifetime: ApplicationWindowLifetime): void {
    if (lifetime.closed) return;
    lifetime.closed = true;

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

    this.deps.stopElectronHostTargetLaunchLoop();
    setMenuViewManager(null);
    setMemoryMonitorViewManager(null);
    lifetime.panelView = null;
    lifetime.appOrchestrator = null;
    this.currentLifetime = null;
    this.deps.onWindowClosed();
  }
}
