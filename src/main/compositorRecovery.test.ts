import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CompositorRecovery,
  type CompositorRecoveryDeps,
  type CompositorRecoverySlot,
  type CompositorRecoveryView,
} from "./compositorRecovery.js";

const timings = {
  keepaliveIntervalMs: 5,
  visibilityCycleCooldownMs: 1,
};

function createView(id: string): CompositorRecoveryView {
  return {
    id,
    type: "panel",
    visible: true,
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    view: {
      setBounds: vi.fn(),
      setVisible: vi.fn(),
      webContents: {
        isDestroyed: vi.fn(() => false),
        invalidate: vi.fn(),
      },
    },
  };
}

function createHarness(view = createView("panel-1")) {
  const views = new Map([[view.id, view]]);
  const state: {
    destroyed: boolean;
    visible: boolean;
    focused: boolean;
    visiblePanelId: string | null;
    slots: CompositorRecoverySlot[];
    overlayActive: boolean;
  } = {
    destroyed: false,
    visible: true,
    focused: true,
    visiblePanelId: view.id,
    slots: [],
    overlayActive: false,
  };
  const deps: CompositorRecoveryDeps = {
    isWindowDestroyed: () => state.destroyed,
    isWindowVisible: () => state.visible,
    isWindowFocused: () => state.focused,
    getVisiblePanelId: () => state.visiblePanelId,
    getActiveSlots: () => state.slots,
    getView: (panelId) => views.get(panelId),
    calculatePanelBounds: () => ({ x: 10, y: 20, width: 300, height: 200 }),
    ensureSlotLayerOrder: vi.fn(),
    reconcileNativeLayerOrder: vi.fn(),
    isShellOverlayActive: () => state.overlayActive,
    logVerbose: vi.fn(),
    logWarning: vi.fn(),
    logError: vi.fn(),
  };
  return {
    recovery: new CompositorRecovery(deps, timings),
    deps,
    state,
    view,
  };
}

describe("CompositorRecovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("maintains an unslotted visible surface without changing its visibility", async () => {
    const harness = createHarness(createView("visible"));

    await harness.recovery.probeNow();

    expect(harness.deps.reconcileNativeLayerOrder).toHaveBeenCalledOnce();
    expect(harness.view.view.setBounds).toHaveBeenCalledWith({
      x: 10,
      y: 20,
      width: 300,
      height: 200,
    });
    expect(harness.view.view.webContents.invalidate).toHaveBeenCalledOnce();
    expect(harness.view.view.setVisible).not.toHaveBeenCalled();
  });

  it("runs periodic maintenance without a second destructive probe timer", async () => {
    const harness = createHarness();
    harness.recovery.start();

    await vi.advanceTimersByTimeAsync(15);
    expect(harness.view.view.webContents.invalidate).toHaveBeenCalledTimes(3);
    expect(harness.view.view.setVisible).not.toHaveBeenCalled();
  });

  it("does not repaint when the window cannot be maintained", async () => {
    const harness = createHarness();
    harness.state.focused = false;
    await harness.recovery.probeNow();

    expect(harness.view.view.webContents.invalidate).not.toHaveBeenCalled();
    expect(harness.deps.reconcileNativeLayerOrder).not.toHaveBeenCalled();
    expect(harness.view.view.setVisible).not.toHaveBeenCalled();
  });

  it("maintains slotted surfaces without treating empty readbacks as stalls", async () => {
    const harness = createHarness(createView("old-panel"));
    harness.state.slots = [
      {
        nativeSlotId: "slot-1",
        panelId: "old-panel",
        bounds: { x: 1, y: 2, width: 30, height: 40 },
      },
    ];
    await harness.recovery.probeNow();

    expect(harness.deps.ensureSlotLayerOrder).toHaveBeenCalledOnce();
    expect(harness.view.view.setBounds).toHaveBeenCalledWith({
      x: 1,
      y: 2,
      width: 30,
      height: 40,
    });
    expect(harness.view.view.webContents.invalidate).toHaveBeenCalledOnce();
    expect(harness.view.view.setVisible).not.toHaveBeenCalled();
  });

  it("owns repaint cooldown and keeps panel surfaces hidden behind a shell overlay", () => {
    const harness = createHarness();
    harness.state.overlayActive = true;

    expect(harness.recovery.forceRepaint("panel-1")).toBe(true);
    expect(harness.recovery.forceRepaint("panel-1")).toBe(true);

    expect(harness.view.view.webContents.invalidate).toHaveBeenCalledTimes(2);
    expect(harness.view.view.setVisible).toHaveBeenCalledTimes(1);
    expect(harness.view.view.setVisible).toHaveBeenCalledWith(false);
  });
});
