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
      capturePage(): Promise<{ isEmpty(): boolean }>;
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
  minimumProbeIntervalMs: number;
  maximumProbeIntervalMs: number;
  visibilityCycleCooldownMs: number;
}

/**
 * Owns compositor liveness policy: periodic keepalive, adaptive stall probes,
 * and the bounded visibility-cycle recovery used by explicit repaint requests.
 * ViewManager remains responsible for native layer mechanics and supplies them
 * through the required host callbacks above.
 */
export class CompositorRecovery {
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private stallDetectorTimer: ReturnType<typeof setTimeout> | null = null;
  private probeIntervalMs: number;
  private readonly lastVisibilityCycleTimeByView = new Map<string, number>();

  constructor(
    private readonly deps: CompositorRecoveryDeps,
    private readonly timings: CompositorRecoveryTimings
  ) {
    if (timings.minimumProbeIntervalMs <= 0) {
      throw new Error("minimumProbeIntervalMs must be positive");
    }
    if (timings.maximumProbeIntervalMs < timings.minimumProbeIntervalMs) {
      throw new Error("maximumProbeIntervalMs must be at least minimumProbeIntervalMs");
    }
    this.probeIntervalMs = timings.minimumProbeIntervalMs;
  }

  start(): void {
    this.stop();
    this.keepaliveTimer = setInterval(
      () => this.keepCompositorAlive(),
      this.timings.keepaliveIntervalMs
    );
    this.probeIntervalMs = this.timings.minimumProbeIntervalMs;
    this.scheduleProbe();
  }

  stop(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    if (this.stallDetectorTimer) clearTimeout(this.stallDetectorTimer);
    this.keepaliveTimer = null;
    this.stallDetectorTimer = null;
  }

  forgetView(viewId: string): void {
    this.lastVisibilityCycleTimeByView.delete(viewId);
  }

  handleWindowFocused(): void {
    this.probeIntervalMs = this.timings.minimumProbeIntervalMs;
    this.keepCompositorAlive();
    void this.probeNow();
  }

  probeNow(): Promise<void> {
    return this.detectAndRecoverStall();
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

  private scheduleProbe(): void {
    this.stallDetectorTimer = setTimeout(async () => {
      await this.probeNow();
      if (this.stallDetectorTimer === null) return;
      this.scheduleProbe();
    }, this.probeIntervalMs);
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
  }

  private async detectAndRecoverStall(): Promise<void> {
    if (!this.canProbe()) return;

    const slots = this.deps.getActiveSlots();
    if (slots.length > 0) {
      // capturePage is not a reliable liveness signal for a WebContentsView
      // that is composited as a child of the hosted shell. In particular,
      // Linux/Chromium can return an empty readback for a healthy, visible
      // native surface. Treating that as a stall visibility-cycles the user's
      // panel and races the shell's slot bind/clear messages. Keep the native
      // layer alive through the non-destructive maintenance path instead.
      this.deps.ensureSlotLayerOrder();
      for (const slot of slots) {
        const managed = this.deps.getView(slot.panelId);
        if (!this.canRepaint(managed)) continue;
        const currentSlot = this.deps
          .getActiveSlots()
          .find((candidate) => candidate.nativeSlotId === slot.nativeSlotId);
        if (currentSlot?.panelId !== slot.panelId) continue;
        managed.bounds = currentSlot.bounds;
        managed.view.setBounds(currentSlot.bounds);
        managed.view.webContents.invalidate();
      }
      this.adjustProbeBackoff(false);
      return;
    }

    const panelId = this.deps.getVisiblePanelId();
    if (!panelId) return;
    const managed = this.deps.getView(panelId);
    if (!this.canRepaint(managed)) return;

    try {
      const image = await managed.view.webContents.capturePage();
      if (this.deps.getVisiblePanelId() !== panelId || !managed.visible) return;

      if (image.isEmpty()) {
        this.deps.logVerbose(
          `Compositor stall detected on ${panelId} (empty capture) — recovering`
        );
        this.deps.reconcileNativeLayerOrder();
        const bounds = this.deps.calculatePanelBounds();
        managed.bounds = bounds;
        managed.view.setBounds(bounds);
        managed.view.webContents.invalidate();
        this.cycleVisibility(managed);
        this.adjustProbeBackoff(true);
      } else {
        this.adjustProbeBackoff(false);
      }
    } catch {
      // Navigation and destruction can race a capture. The next probe retries.
    }
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

  private adjustProbeBackoff(stalled: boolean): void {
    this.probeIntervalMs = stalled
      ? this.timings.minimumProbeIntervalMs
      : Math.min(this.probeIntervalMs * 2, this.timings.maximumProbeIntervalMs);
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
