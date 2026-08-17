import type { BaseWindow, WebContentsView } from "electron";
import {
  ShellContentOverlayView,
  type ContentOverlayShowOptions,
  type ContentOverlayUpdateOptions,
} from "./shellContentOverlayView.js";

/**
 * Fixed stacking order for the content overlays, lowest first.
 *
 * Quickfire sits above the approval card because it is focused, transient
 * chrome the user just summoned, while the card is ambient and corner-snapped;
 * they never contest the same space. Surfaces not named here stack below both,
 * in creation order, which is the conservative default for a new surface.
 */
const SURFACE_STACKING_ORDER = ["approval-card", "quickfire"] as const;

function stackingRank(surface: string): number {
  const index = (SURFACE_STACKING_ORDER as readonly string[]).indexOf(surface);
  return index < 0 ? -1 : index;
}

/**
 * Per-surface instances of the rich content overlay.
 *
 * The overlay used to be a singleton: showing a second surface *replaced* the
 * first, and `hide()` took no argument. That made the approval card and the
 * command palette mutually exclusive — an approval raised while the palette was
 * up would have been invisible behind it, or would have destroyed it. Each
 * registered surface key now owns its own `ShellContentOverlayView`, created
 * lazily on first show. The views already filter their IPC by sender id, so
 * running several side by side needs no transport change.
 */
export class ContentOverlayManager {
  private readonly instances = new Map<string, ShellContentOverlayView>();
  private window: BaseWindow | null = null;

  constructor(
    private readonly preloadPath: string,
    private readonly getBaseUrl: () => string | null,
    private readonly forwardIntent: (payload: unknown) => void
  ) {}

  setWindow(window: BaseWindow): void {
    this.window = window;
    for (const instance of this.instances.values()) instance.setWindow(window);
  }

  /** Prepare a surface without making it visible or giving it focus. */
  prewarm(surface: string): void {
    this.ensure(surface).prewarm(surface);
  }

  show(options: ContentOverlayShowOptions): void {
    const instance = this.ensure(options.surface);
    instance.show(options);
    // A newly shown surface must respect the fixed pair order rather than
    // simply landing on top: an approval card shown while quickfire is open
    // belongs underneath it.
    this.bringToFront();
    // Re-adding native views can move focus back to another WebContents. Apply
    // the request only after the final stacking pass has completed.
    instance.applyRequestedFocus();
  }

  /**
   * Update one surface. `surface` identifies the instance — it is no longer a
   * retarget instruction, because retargeting a shared view is exactly the
   * single-instance behavior this class removes.
   */
  update(surface: string, options: ContentOverlayUpdateOptions): void {
    this.instances.get(surface)?.update({ ...options, surface });
  }

  hide(surface: string): void {
    this.instances.get(surface)?.hide();
  }

  isVisible(surface: string): boolean {
    return this.instances.get(surface)?.isVisible() === true;
  }

  /** Every currently visible overlay view, lowest in the stack first. */
  getVisibleViews(): WebContentsView[] {
    return this.orderedInstances().flatMap((entry) => {
      const view = entry.instance.getVisibleView();
      return view ? [view] : [];
    });
  }

  ownsWebContentsId(webContentsId: number): boolean {
    return [...this.instances.values()].some((instance) =>
      instance.ownsWebContentsId(webContentsId)
    );
  }

  /** Re-raise the visible overlays, in stacking order, above the panels. */
  bringToFront(): void {
    for (const entry of this.orderedInstances()) entry.instance.bringToFront();
  }

  destroy(): void {
    for (const instance of this.instances.values()) instance.destroy();
    this.instances.clear();
  }

  private orderedInstances(): Array<{ surface: string; instance: ShellContentOverlayView }> {
    return [...this.instances]
      .map(([surface, instance], creationIndex) => ({ surface, instance, creationIndex }))
      .sort(
        (left, right) =>
          stackingRank(left.surface) - stackingRank(right.surface) ||
          left.creationIndex - right.creationIndex
      );
  }

  private ensure(surface: string): ShellContentOverlayView {
    const existing = this.instances.get(surface);
    if (existing) return existing;
    const instance = new ShellContentOverlayView(
      this.preloadPath,
      this.getBaseUrl,
      this.forwardIntent
    );
    if (this.window) instance.setWindow(this.window);
    this.instances.set(surface, instance);
    return instance;
  }
}
