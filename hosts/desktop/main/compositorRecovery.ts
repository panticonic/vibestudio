export interface CompositorBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CompositorRecoveryView {
  id: string;
  type: "shell" | "panel" | "app";
  visible: boolean;
  bounds: CompositorBounds;
  view: {
    setBounds(bounds: CompositorBounds): void;
    setVisible(visible: boolean): void;
    webContents: {
      isDestroyed(): boolean;
      invalidate(): void;
    };
  };
}

export interface CompositorRecoverySlot {
  nativeSlotId: string;
  panelId: string;
  bounds: CompositorBounds;
}

export interface CompositorRecoveryDeps {
  isWindowDestroyed(): boolean;
  isWindowVisible(): boolean;
  isWindowFocused(): boolean;
  getVisiblePanelId(): string | null;
  getActiveSlots(): readonly CompositorRecoverySlot[];
  getView(panelId: string): CompositorRecoveryView | undefined;
  calculatePanelBounds(): CompositorBounds;
  ensureSlotLayerOrder(): void;
  reconcileNativeLayerOrder(): void;
  isShellOverlayActive(): boolean;
  logVerbose(message: string): void;
  logWarning(message: string): void;
  logError(message: string, error: unknown): void;
}

export interface CompositorRecoveryTimings {
  keepaliveIntervalMs: number;
  visibilityCycleCooldownMs: number;
}

/**
 * Owns compositor liveness policy: periodic non-destructive maintenance and
 * the bounded visibility-cycle recovery used by explicit repaint requests.
 *
 * `capturePage()` is deliberately not a liveness probe. Chromium can return an
 * empty readback for a healthy WebContentsView, especially when it is layered
 * with the hosted shell on Linux. A false positive here used to visibility-
 * cycle live panels out from under the slot protocol while their agents kept
 * running. Automatic maintenance therefore only reasserts bounds, layer order,
 * and invalidation; visibility cycling is reserved for an explicit user action.
 * ViewManager remains responsible for native layer mechanics and supplies them
 * through the required host callbacks above.
 */
export class CompositorRecovery {
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private readonly lastVisibilityCycleTimeByView = new Map<string, number>();

  constructor(
    private readonly deps: CompositorRecoveryDeps,
    private readonly timings: CompositorRecoveryTimings
  ) {}

  start(): void {
    this.stop();
    this.keepaliveTimer = setInterval(
      () => this.keepCompositorAlive(),
      this.timings.keepaliveIntervalMs
    );
  }

  stop(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  forgetView(viewId: string): void {
    this.lastVisibilityCycleTimeByView.delete(viewId);
  }

  handleWindowFocused(): void {
    this.keepCompositorAlive();
  }

  async probeNow(): Promise<void> {
    this.keepCompositorAlive();
  }

  forceRepaint(viewId: string): boolean {
    const managed = this.deps.getView(viewId);
    if (!managed) {
      this.deps.logWarning(`forceRepaint: view not found: ${viewId}`);
      return false;
    }

    const contents = managed.view.webContents;
    if (contents.isDestroyed()) {
      this.deps.logWarning(`forceRepaint: webContents destroyed: ${viewId}`);
      return false;
    }

    this.deps.logVerbose(`Forcing repaint for view: ${viewId}`);
    try {
      contents.invalidate();
      if (managed.visible) this.cycleVisibility(managed);
      return true;
    } catch (error) {
      this.deps.logError(`Failed to force repaint for ${viewId}`, error);
      return false;
    }
  }

  private keepCompositorAlive(): void {
    if (!this.canProbe()) return;

    const slots = this.deps.getActiveSlots();
    if (slots.length > 0) {
      this.deps.ensureSlotLayerOrder();
      for (const slot of slots) {
        const managed = this.deps.getView(slot.panelId);
        if (!this.canRepaint(managed)) continue;
        managed.bounds = slot.bounds;
        managed.view.setBounds(slot.bounds);
        managed.view.webContents.invalidate();
      }
      return;
    }

    const panelId = this.deps.getVisiblePanelId();
    if (!panelId) return;
    const managed = this.deps.getView(panelId);
    if (!this.canRepaint(managed)) return;
    const bounds = this.deps.calculatePanelBounds();
    managed.bounds = bounds;
    managed.view.setBounds(bounds);
    managed.view.webContents.invalidate();
    this.deps.reconcileNativeLayerOrder();
  }

  private canProbe(): boolean {
    return (
      !this.deps.isWindowDestroyed() && this.deps.isWindowVisible() && this.deps.isWindowFocused()
    );
  }

  private canRepaint(
    managed: CompositorRecoveryView | undefined
  ): managed is CompositorRecoveryView {
    return Boolean(managed?.visible && !managed.view.webContents.isDestroyed());
  }

  private cycleVisibility(managed: CompositorRecoveryView): void {
    if (managed.view.webContents.isDestroyed()) return;
    const now = Date.now();
    const lastCycleTime = this.lastVisibilityCycleTimeByView.get(managed.id) ?? 0;
    if (now - lastCycleTime < this.timings.visibilityCycleCooldownMs) return;
    this.lastVisibilityCycleTimeByView.set(managed.id, now);
    managed.view.setVisible(false);
    if (!(this.deps.isShellOverlayActive() && managed.type === "panel")) {
      managed.view.setVisible(true);
    }
  }
}
