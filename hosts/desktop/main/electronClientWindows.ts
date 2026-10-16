import { BaseWindow, nativeTheme, WebContentsView, session, type WebContents } from "electron";
import type { ClientCapability } from "@vibestudio/workspace-contracts/clients";
import { createDevLogger } from "@vibestudio/dev-log";
import type { ClientMenus } from "./clientMenu.js";
import type { ClientWindow, ClientWindowFactory, ClientWindowSpec } from "./clientWindow.js";
import { CLIENT_SCHEME } from "./clientDelivery.js";
import type { PanelHostWindow } from "./panelHostWindow.js";
import { workspaceNativeViewId } from "./workspaceNativeViews.js";
import { workspaceTransportArgument } from "../preload/workspaceTransportIdentity.js";

const log = createDevLogger("ClientWindows");

function chromeWindowColors(dark: boolean): { background: string; symbol: string } {
  return dark
    ? { background: "#111419", symbol: "#b1bbcb" }
    : { background: "#edf1f6", symbol: "#445166" };
}

export interface ElectronClientWindowDeps {
  /** Absolute path of the built client preload. */
  preloadPath: string;
  iconPath: string;
  menus: ClientMenus;
  panelHost: PanelHostWindow;
  /** The session partition a client's pages run in. */
  partitionFor(spec: ClientWindowSpec): string;
  /** Navigate-away policy for a link a client opened: ask, then open in the OS browser. */
  openExternal(url: string): Promise<void>;
  /** A client opened another window of itself. */
  openSibling(spec: ClientWindowSpec, url: string): void;
  /** A window ended: the person closed it, or the host did. */
  closed(window: ClientWindow): void;
  /** The renderer behind this window stopped; it is not recoverable by reloading. */
  rendererGone(window: ClientWindow, reason: string): void;
}

/**
 * A window of a client that does not host panels: one window, one top-level
 * view running the verified client page under its own session. The panel
 * compositor is not involved; a client that hosts panels uses
 * {@link PanelHostingClientWindow} instead.
 */
class PlainClientWindow implements ClientWindow {
  readonly hostsPanels = false;
  private view: WebContentsView | null;
  private window: BaseWindow | null;
  private ended = false;
  private currentSpec: ClientWindowSpec;

  private constructor(
    readonly windowId: string,
    spec: ClientWindowSpec,
    private readonly deps: ElectronClientWindowDeps
  ) {
    this.currentSpec = spec;
    const chrome = chromeWindowColors(nativeTheme.shouldUseDarkColors);
    this.window = new BaseWindow({
      width: 960,
      height: 720,
      show: false,
      title: spec.title,
      icon: deps.iconPath,
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
    this.view = new WebContentsView({
      webPreferences: {
        preload: deps.preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webviewTag: false,
        autoplayPolicy: "document-user-activation-required",
        session: session.fromPartition(deps.partitionFor(spec)),
        additionalArguments: [
          workspaceTransportArgument({
            workspaceId: spec.workspaceId,
            runtimeId: spec.principalId,
          }),
        ],
      },
    });
    this.window.contentView.addChildView(this.view);
    this.fit();
    this.window.on("resize", () => this.fit());
    this.window.on("focus", () => deps.menus.applyFor(windowId));
    // Release the view while the native window is still alive, then report once.
    this.window.on("close", () => this.end());
    this.window.on("closed", () => this.end());
    const contents = this.view.webContents;
    deps.menus.shortcutsFor(windowId).intercept(contents);
    contents.setWindowOpenHandler(({ url }) => {
      if (this.isOwnOrigin(url)) this.deps.openSibling(this.currentSpec, url);
      else if (/^https?:\/\//iu.test(url)) {
        void this.deps.openExternal(url).catch((error: unknown) => {
          log.warn(
            `Could not open ${url}: ${error instanceof Error ? error.message : String(error)}`
          );
        });
      }
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (this.isOwnOrigin(url)) return;
      event.preventDefault();
      if (/^https?:\/\//iu.test(url)) void this.deps.openExternal(url).catch(() => undefined);
    });
    contents.on("render-process-gone", (_event, details) => {
      if (details.reason !== "clean-exit") deps.rendererGone(this, details.reason);
    });
  }

  static async open(
    windowId: string,
    spec: ClientWindowSpec,
    deps: ElectronClientWindowDeps
  ): Promise<PlainClientWindow> {
    const window = new PlainClientWindow(windowId, spec, deps);
    try {
      await window.view!.webContents.loadURL(spec.entryUrl);
    } catch (error) {
      window.close();
      throw error;
    }
    window.show();
    return window;
  }

  get callerId(): string {
    return this.windowId;
  }

  get spec(): ClientWindowSpec {
    return this.currentSpec;
  }

  contents(): WebContents | null {
    const contents = this.view?.webContents;
    return contents && !contents.isDestroyed() ? contents : null;
  }

  browserWindow(): BaseWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null;
  }

  show(): void {
    const window = this.browserWindow();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  async swap(next: ClientWindowSpec): Promise<void> {
    if (next.clientId !== this.currentSpec.clientId) {
      throw new Error("A window can move only to another build of its own client");
    }
    this.currentSpec = next;
    await this.contents()?.loadURL(next.entryUrl);
  }

  setCapabilities(capabilities: readonly ClientCapability[]): void {
    this.currentSpec = { ...this.currentSpec, capabilities };
  }

  send(channel: string, ...args: unknown[]): void {
    this.contents()?.send(channel, ...args);
  }

  close(): void {
    const window = this.browserWindow();
    if (window) window.close();
    else this.end();
  }

  private fit(): void {
    const window = this.browserWindow();
    if (!window || !this.view) return;
    const [width = 0, height = 0] = window.getContentSize();
    this.view.setBounds({ x: 0, y: 0, width, height });
  }

  private isOwnOrigin(url: string): boolean {
    try {
      const parsed = new URL(url);
      return (
        parsed.protocol === `${CLIENT_SCHEME}:` && parsed.hostname === this.currentSpec.clientId
      );
    } catch {
      return false;
    }
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    const view = this.view;
    this.view = null;
    const window = this.window;
    this.window = null;
    if (view && window && !window.isDestroyed()) {
      try {
        window.contentView.removeChildView(view);
      } catch {
        // The native window already dropped its children while closing.
      }
    }
    if (view && !view.webContents.isDestroyed()) view.webContents.close();
    this.deps.closed(this);
  }
}

/** The window of the one client that hosts panels: the panel host's window with the client as its chrome. */
class PanelHostingClientWindow implements ClientWindow {
  readonly hostsPanels = true;
  readonly callerId: string;
  private currentSpec: ClientWindowSpec;

  constructor(
    readonly windowId: string,
    spec: ClientWindowSpec,
    private readonly deps: ElectronClientWindowDeps
  ) {
    this.currentSpec = spec;
    this.callerId = workspaceNativeViewId({
      workspaceId: spec.workspaceId,
      runtimeId: spec.principalId,
    });
  }

  private panelView() {
    const view = this.deps.panelHost.getWorkspacePanelView(this.currentSpec.workspaceId);
    if (!view) throw new Error("The panel host has no presentation for this workspace");
    return view;
  }

  /** Create the client's top-level view inside the panel host's window and show it. */
  async start(): Promise<void> {
    this.deps.panelHost.open(this.windowId);
    await this.panelView().createViewForClient(
      this.currentSpec.principalId,
      this.currentSpec.entryUrl,
      undefined,
      this.currentSpec.capabilities,
      this.currentSpec.codeIdentity
    );
    this.deps.panelHost.showAndFocus();
  }

  get spec(): ClientWindowSpec {
    return this.currentSpec;
  }

  contents(): WebContents | null {
    const contents = this.panelView().getWebContents(this.currentSpec.principalId);
    return contents && !contents.isDestroyed() ? contents : null;
  }

  browserWindow(): BaseWindow | null {
    return this.deps.panelHost.window;
  }

  show(): void {
    this.deps.panelHost.showAndFocus();
  }

  async swap(next: ClientWindowSpec): Promise<void> {
    if (next.clientId !== this.currentSpec.clientId) {
      throw new Error("A window can move only to another build of its own client");
    }
    await this.panelView().createViewForClient(
      next.principalId,
      next.entryUrl,
      undefined,
      next.capabilities,
      next.codeIdentity
    );
    this.currentSpec = next;
  }

  setCapabilities(capabilities: readonly ClientCapability[]): void {
    this.deps.panelHost.viewManager?.setClientCapabilities(this.callerId, capabilities);
    this.currentSpec = { ...this.currentSpec, capabilities };
  }

  send(channel: string, ...args: unknown[]): void {
    this.contents()?.send(channel, ...args);
  }

  close(): void {
    this.deps.panelHost.window?.close();
  }
}

export function createElectronClientWindowFactory(
  deps: ElectronClientWindowDeps
): ClientWindowFactory {
  return {
    plain: (windowId, spec) => PlainClientWindow.open(windowId, spec, deps),
    async panelHosting(windowId, spec) {
      const window = new PanelHostingClientWindow(windowId, spec, deps);
      await window.start();
      return window;
    },
  };
}
