import { WebContentsView, ipcMain, type BaseWindow } from "electron";
import { createDevLogger } from "@vibez1/dev-log";
import type { ContentOverlayTheme } from "@vibez1/shared/serviceSchemas/view";

const log = createDevLogger("ShellContentOverlayView");

/** Card width (440) + 2× the surface margin (16) used by OverlaySurfaceHost. */
const VIEW_WIDTH = 472;
/** Inset of the overlay's corner from the anchor region's corresponding corner. */
const ANCHOR_MARGIN = 12;
const MIN_HEIGHT = 64;
/** Snap-to-corner tween duration after a drag release. */
const SNAP_DURATION_MS = 150;

/** The corner of the anchor region the overlay floats against. */
type OverlayCorner = "top-right" | "top-left" | "bottom-right" | "bottom-left";

export interface ContentOverlayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ContentOverlayShowOptions {
  surface: string;
  /** Anchor region (the panel viewport rect); the surface floats top-right. */
  bounds: ContentOverlayBounds;
  props: unknown;
  theme: ContentOverlayTheme;
  focus?: boolean;
}

export type ContentOverlayUpdateOptions = Partial<ContentOverlayShowOptions>;

/**
 * The reusable rich content overlay — a transparent WebContentsView that loads
 * the shell bundle in "surface mode" (`#overlaySurface=<key>`) and floats above
 * the panels. Modeled on ShellOverlayView, but it hosts a real React surface
 * instead of static rows. Singleton: one surface at a time, like the autocomplete
 * overlay. It runs NO RPC; `props` flow in over IPC and `intent` payloads flow
 * back out to the owning shell chrome.
 */
export class ShellContentOverlayView {
  private view: WebContentsView | null = null;
  private window: BaseWindow | null = null;
  private visible = false;
  private overlayWcId: number | null = null;
  private loaded = false;
  private loadedUrl: string | null = null;
  private surface: string | null = null;
  private props: unknown = null;
  private theme: ContentOverlayTheme | null = null;
  private anchor: ContentOverlayBounds | null = null;
  private contentHeight = MIN_HEIGHT;
  private pendingFocus = false;
  /** Corner the overlay snaps to; persists across re-shows so the card reappears
   *  where the user last placed it. */
  private corner: OverlayCorner = "top-left";
  private dragging = false;
  private dragStartScreen: { x: number; y: number } | null = null;
  private dragStartPos: { x: number; y: number } | null = null;
  private snapTimer: ReturnType<typeof setInterval> | null = null;

  private readonly handleSize = (event: Electron.IpcMainEvent, payload: unknown) => {
    if (!this.isOwnSender(event.sender.id)) return;
    const height = Number((payload as { height?: unknown } | null)?.height);
    if (!Number.isFinite(height)) return;
    this.contentHeight = Math.max(MIN_HEIGHT, Math.round(height));
    this.applyBounds();
  };

  private readonly handleIntent = (event: Electron.IpcMainEvent, payload: unknown) => {
    if (!this.isOwnSender(event.sender.id)) return;
    this.forwardIntent((payload as { payload?: unknown } | null)?.payload);
  };

  /**
   * Drag the overlay around the window, then snap it to the nearest anchor
   * corner on release. The surface reports screen coordinates (stable as the
   * native view moves under the cursor) so the view tracks the pointer 1:1.
   */
  private readonly handleDrag = (event: Electron.IpcMainEvent, payload: unknown) => {
    if (!this.isOwnSender(event.sender.id)) return;
    if (!this.view || this.view.webContents.isDestroyed()) return;
    const message = payload as { phase?: unknown; screenX?: unknown; screenY?: unknown } | null;
    const phase = message?.phase;
    const screenX = Number(message?.screenX);
    const screenY = Number(message?.screenY);
    if (phase === "start") {
      this.cancelSnap();
      const bounds = this.view.getBounds();
      this.dragStartPos = { x: bounds.x, y: bounds.y };
      this.dragStartScreen = { x: screenX, y: screenY };
      this.dragging = true;
      return;
    }
    if (phase === "move") {
      if (!this.dragging || !this.dragStartScreen || !this.dragStartPos) return;
      if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return;
      const { width, height } = this.view.getBounds();
      const target = this.clampToWindow(
        this.dragStartPos.x + (screenX - this.dragStartScreen.x),
        this.dragStartPos.y + (screenY - this.dragStartScreen.y),
        width,
        height
      );
      this.view.setBounds({ ...target, width, height });
      return;
    }
    if (phase === "end") {
      if (!this.dragging) return;
      this.dragging = false;
      this.dragStartScreen = null;
      this.dragStartPos = null;
      this.corner = this.nearestCorner();
      this.snapToCorner();
    }
  };

  constructor(
    private readonly preloadPath: string,
    /** Resolves the hosted-shell URL so the overlay loads the same bundle. */
    private readonly getBaseUrl: () => string | null,
    /** Forward a surface intent to the owning shell chrome. */
    private readonly forwardIntent: (payload: unknown) => void
  ) {
    ipcMain.on("vibez1:content-overlay:size", this.handleSize);
    ipcMain.on("vibez1:content-overlay:intent", this.handleIntent);
    ipcMain.on("vibez1:content-overlay:drag", this.handleDrag);
  }

  setWindow(window: BaseWindow): void {
    this.window = window;
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.window.contentView.addChildView(this.view);
    }
  }

  show(options: ContentOverlayShowOptions): void {
    if (!this.window) return;
    const view = this.ensureView();
    this.surface = options.surface;
    this.props = options.props;
    this.theme = options.theme;
    this.anchor = options.bounds;
    this.visible = true;
    this.pendingFocus = options.focus === true;
    this.loadSurface(view, options.surface);
    view.setVisible(true);
    this.applyBounds();
    this.bringToFront();
    this.pushRender();
    this.applyPendingFocus();
  }

  update(options: ContentOverlayUpdateOptions): void {
    if (!this.view || this.view.webContents.isDestroyed()) return;
    if (options.surface && options.surface !== this.surface) {
      this.surface = options.surface;
      this.loadSurface(this.view, options.surface);
    }
    if (options.props !== undefined) this.props = options.props;
    if (options.theme) this.theme = options.theme;
    if (options.bounds) this.anchor = options.bounds;
    if (options.focus !== undefined) this.pendingFocus = options.focus === true;
    this.applyBounds();
    this.pushRender();
    this.applyPendingFocus();
  }

  hide(): void {
    this.visible = false;
    this.cancelSnap();
    this.dragging = false;
    this.dragStartScreen = null;
    this.dragStartPos = null;
    // Reset so a reuse re-pushes fresh content and re-fits from scratch.
    // `corner` is deliberately preserved so the card reappears where the user
    // last dragged it.
    this.surface = null;
    this.props = null;
    this.anchor = null;
    this.contentHeight = MIN_HEIGHT;
    this.pendingFocus = false;
    if (!this.view || this.view.webContents.isDestroyed()) return;
    if (this.loaded) this.view.webContents.send("vibez1:content-overlay:clear");
    this.view.setVisible(false);
    this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  }

  isVisible(): boolean {
    return this.visible && this.view != null && !this.view.webContents.isDestroyed();
  }

  /** Re-raise above the panels (called after every native layer reconcile). */
  bringToFront(): void {
    if (!this.window || !this.view || this.view.webContents.isDestroyed() || !this.visible) return;
    this.window.contentView.removeChildView(this.view);
    this.window.contentView.addChildView(this.view);
  }

  destroy(): void {
    this.cancelSnap();
    ipcMain.removeListener("vibez1:content-overlay:size", this.handleSize);
    ipcMain.removeListener("vibez1:content-overlay:intent", this.handleIntent);
    ipcMain.removeListener("vibez1:content-overlay:drag", this.handleDrag);
    if (this.view && !this.view.webContents.isDestroyed()) {
      if (this.window) this.window.contentView.removeChildView(this.view);
      this.view.webContents.close();
    }
    this.view = null;
    this.overlayWcId = null;
    this.visible = false;
    this.loaded = false;
    this.loadedUrl = null;
    this.pendingFocus = false;
  }

  private ensureView(): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;
    this.view = new WebContentsView({
      webPreferences: {
        preload: this.preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        transparent: true,
      },
    });
    this.loaded = false;
    this.loadedUrl = null;
    this.view.setBackgroundColor("#00000000");
    this.view.setVisible(false);
    this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    this.overlayWcId = this.view.webContents.id;
    const view = this.view;
    view.webContents.on("did-finish-load", () => {
      if (view.webContents.isDestroyed()) return;
      this.loaded = true;
      this.pushRender();
      this.applyPendingFocus();
    });
    this.window?.contentView.addChildView(this.view);
    return this.view;
  }

  private loadSurface(view: WebContentsView, surface: string): void {
    const base = this.getBaseUrl();
    if (!base) {
      log.warn("No hosted-shell base URL available to load content overlay surface");
      return;
    }
    const url = withSurfaceHash(base, surface);
    if (this.loadedUrl === url) return;
    this.loadedUrl = url;
    this.loaded = false;
    void view.webContents.loadURL(url).catch((error: unknown) => {
      log.warn(
        `Failed to load content overlay surface: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }

  private pushRender(): void {
    if (!this.view || this.view.webContents.isDestroyed()) return;
    if (!this.loaded || !this.surface || !this.theme || !this.anchor) return;
    const maxHeight = Math.max(MIN_HEIGHT, Math.round(this.anchor.height - 2 * ANCHOR_MARGIN));
    this.view.webContents.send("vibez1:content-overlay:render", {
      surface: this.surface,
      props: this.props,
      theme: this.theme,
      maxHeight,
    });
  }

  private applyPendingFocus(): void {
    if (!this.pendingFocus || !this.visible || !this.loaded) return;
    if (!this.view || this.view.webContents.isDestroyed()) return;
    this.pendingFocus = false;
    this.view.webContents.focus();
  }

  private applyBounds(): void {
    if (!this.view || !this.anchor || !this.window) return;
    // Don't fight an active drag (or the size-report it triggers).
    if (this.dragging) return;
    const { width, height } = this.currentSize();
    const { x, y } = this.cornerTarget(width, height);
    this.view.setBounds({ x, y, width, height });
  }

  /** The overlay's width/height for the current anchor + reported content. */
  private currentSize(): { width: number; height: number } {
    const anchor = this.anchor;
    if (!anchor) return { width: VIEW_WIDTH, height: this.contentHeight };
    const width = Math.max(1, Math.min(VIEW_WIDTH, Math.round(anchor.width)));
    const maxHeight = Math.max(MIN_HEIGHT, Math.round(anchor.height));
    const height = Math.max(MIN_HEIGHT, Math.min(this.contentHeight, maxHeight));
    return { width, height };
  }

  /** Position of the active corner within the anchor, inset by the margin. */
  private cornerTarget(width: number, height: number): { x: number; y: number } {
    const anchor = this.anchor;
    if (!anchor) return { x: 0, y: 0 };
    const left = Math.round(anchor.x + ANCHOR_MARGIN);
    const right = Math.round(anchor.x + anchor.width - width - ANCHOR_MARGIN);
    const top = Math.round(anchor.y + ANCHOR_MARGIN);
    const bottom = Math.round(anchor.y + anchor.height - height - ANCHOR_MARGIN);
    const x = this.corner.endsWith("right") ? right : left;
    const y = this.corner.startsWith("top") ? top : bottom;
    return this.clampToWindow(x, y, width, height);
  }

  /** Nearest anchor corner to the overlay's current center. */
  private nearestCorner(): OverlayCorner {
    if (!this.view || !this.anchor) return this.corner;
    const bounds = this.view.getBounds();
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    const anchorX = this.anchor.x + this.anchor.width / 2;
    const anchorY = this.anchor.y + this.anchor.height / 2;
    const horizontal = centerX < anchorX ? "left" : "right";
    const vertical = centerY < anchorY ? "top" : "bottom";
    return `${vertical}-${horizontal}` as OverlayCorner;
  }

  /** Ease the overlay from its current position to the active corner. */
  private snapToCorner(): void {
    if (!this.view || this.view.webContents.isDestroyed() || !this.anchor) return;
    const from = this.view.getBounds();
    const target = this.cornerTarget(from.width, from.height);
    this.cancelSnap();
    if (from.x === target.x && from.y === target.y) return;
    const startedAt = Date.now();
    this.snapTimer = setInterval(() => {
      if (!this.view || this.view.webContents.isDestroyed() || this.dragging) {
        this.cancelSnap();
        return;
      }
      const t = Math.min(1, (Date.now() - startedAt) / SNAP_DURATION_MS);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      this.view.setBounds({
        x: Math.round(from.x + (target.x - from.x) * eased),
        y: Math.round(from.y + (target.y - from.y) * eased),
        width: from.width,
        height: from.height,
      });
      if (t >= 1) this.cancelSnap();
    }, 16);
  }

  private cancelSnap(): void {
    if (this.snapTimer) {
      clearInterval(this.snapTimer);
      this.snapTimer = null;
    }
  }

  private clampToWindow(
    x: number,
    y: number,
    width: number,
    height: number
  ): { x: number; y: number } {
    const [windowWidth = 0, windowHeight = 0] = this.window?.getContentSize() ?? [];
    return {
      x: Math.max(0, Math.min(Math.round(x), Math.max(0, windowWidth - width))),
      y: Math.max(0, Math.min(Math.round(y), Math.max(0, windowHeight - height))),
    };
  }

  private isOwnSender(senderId: number): boolean {
    return this.overlayWcId === senderId;
  }
}

function withSurfaceHash(base: string, surface: string): string {
  try {
    const url = new URL(base);
    url.hash = `overlaySurface=${encodeURIComponent(surface)}`;
    return url.toString();
  } catch {
    return `${base.split("#")[0]}#overlaySurface=${encodeURIComponent(surface)}`;
  }
}
