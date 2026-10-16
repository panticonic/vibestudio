import { BaseWindow, WebContentsView, nativeTheme, type WebContents } from "electron";
import { createDevLogger } from "@vibestudio/dev-log";
import type { LaunchGatePort } from "./clientHost.js";
import {
  launchGateProgress,
  type LaunchGateStatus,
  type LaunchGateView,
} from "../bootstrap/launchGateModel.js";

const log = createDevLogger("LaunchGate");

function chromeWindowColors(dark: boolean): { background: string; symbol: string } {
  return dark
    ? { background: "#111419", symbol: "#b1bbcb" }
    : { background: "#edf1f6", symbol: "#445166" };
}

export interface LaunchGateDeps {
  preloadPath: string;
  htmlPath: string;
  iconPath: string;
  title(): string;
}

/**
 * The launch gate: host UI that runs before any client exists, and again
 * whenever a launch needs the person (a review, a build, an unavailable
 * client). It is its own window with its own page and preload, and it holds
 * no session and no principal: the host owns the launch and pushes each state
 * here; the gate only asks the host to relay the person's decision.
 */
export class LaunchGate implements LaunchGatePort {
  private window: BaseWindow | null = null;
  private view: WebContentsView | null = null;
  private current: LaunchGateView = {
    title: null,
    launch: { status: "starting", reason: "" },
    progress: [],
  };

  constructor(private readonly deps: LaunchGateDeps) {}

  /** Open the gate window (idempotent). */
  show(): void {
    if (this.window && !this.window.isDestroyed()) {
      if (this.window.isMinimized()) this.window.restore();
      this.window.show();
      return;
    }
    const chrome = chromeWindowColors(nativeTheme.shouldUseDarkColors);
    const window = new BaseWindow({
      width: 1200,
      height: 720,
      show: false,
      title: this.deps.title(),
      icon: this.deps.iconPath,
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
    const view = new WebContentsView({
      webPreferences: {
        preload: this.deps.preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        autoplayPolicy: "document-user-activation-required",
      },
    });
    window.contentView.addChildView(view);
    const fit = () => {
      if (window.isDestroyed()) return;
      const [width = 0, height = 0] = window.getContentSize();
      view.setBounds({ x: 0, y: 0, width, height });
    };
    fit();
    window.on("resize", fit);
    window.on("closed", () => {
      if (this.window === window) {
        this.window = null;
        this.view = null;
      }
    });
    view.webContents.once("did-finish-load", () => {
      fit();
      if (!window.isDestroyed()) window.show();
    });
    void view.webContents.loadFile(this.deps.htmlPath).catch((error: unknown) => {
      log.error(`Could not load the launch gate page: ${String(error)}`);
    });
    this.window = window;
    this.view = view;
  }

  get isOpen(): boolean {
    return this.window !== null && !this.window.isDestroyed();
  }

  setTitle(title: string): void {
    if (this.window && !this.window.isDestroyed()) this.window.setTitle(title);
  }

  /** The renderer of the gate, for sender checks and pushes. */
  contents(): WebContents | null {
    const contents = this.view?.webContents;
    return contents && !contents.isDestroyed() ? contents : null;
  }

  isSender(contents: WebContents): boolean {
    return this.contents()?.id === contents.id;
  }

  get launchView(): LaunchGateView {
    return this.current;
  }

  present(title: string | null, status: LaunchGateStatus): void {
    this.current = { title, launch: status, progress: launchGateProgress(status) };
    this.show();
    this.contents()?.send("vibestudio:bootstrap:launch-state", this.current);
  }

  /** Push a value to the gate's renderer on one of its channels. */
  send(channel: string, payload: unknown): void {
    this.contents()?.send(channel, payload);
  }

  dismiss(): void {
    const window = this.window;
    this.window = null;
    this.view = null;
    if (window && !window.isDestroyed()) window.close();
  }
}
