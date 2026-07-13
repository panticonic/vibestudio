import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CompositorRecovery,
  type CompositorRecoveryDeps,
  type CompositorRecoverySlot,
  type CompositorRecoveryView,
} from "./compositorRecovery.js";

const timings = {
  keepaliveIntervalMs: 5,
  minimumProbeIntervalMs: 10,
  maximumProbeIntervalMs: 40,
  visibilityCycleCooldownMs: 1,
};

function createView(id: string, empty = false): CompositorRecoveryView {
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
        capturePage: vi.fn(async () => ({ isEmpty: () => empty })),
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

  it("recovers an empty visible surface with bounds, invalidation, and a visibility cycle", async () => {
    const harness = createHarness(createView("stalled", true));

    await harness.recovery.probeNow();

    expect(harness.deps.reconcileNativeLayerOrder).toHaveBeenCalledOnce();
    expect(harness.view.view.setBounds).toHaveBeenCalledWith({
      x: 10,
      y: 20,
      width: 300,
      height: 200,
    });
    expect(harness.view.view.webContents.invalidate).toHaveBeenCalledOnce();
    expect(harness.view.view.setVisible).toHaveBeenNthCalledWith(1, false);
    expect(harness.view.view.setVisible).toHaveBeenNthCalledWith(2, true);
  });

  it("backs healthy capture probes off and resets the interval after a stall", async () => {
    const harness = createHarness();
    const capturePage = vi.mocked(harness.view.view.webContents.capturePage);
    harness.recovery.start();

    await vi.advanceTimersByTimeAsync(10);
    expect(capturePage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(19);
    expect(capturePage).toHaveBeenCalledTimes(1);

    capturePage.mockResolvedValue({ isEmpty: () => true });
    await vi.advanceTimersByTimeAsync(1);
    expect(capturePage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10);
    expect(capturePage).toHaveBeenCalledTimes(3);
  });

  it("does not repaint when capture fails or the window cannot be probed", async () => {
    const harness = createHarness();
    vi.mocked(harness.view.view.webContents.capturePage).mockRejectedValue(new Error("navigating"));

    await harness.recovery.probeNow();
    harness.state.focused = false;
    await harness.recovery.probeNow();

    expect(harness.view.view.webContents.capturePage).toHaveBeenCalledTimes(1);
    expect(harness.deps.reconcileNativeLayerOrder).not.toHaveBeenCalled();
    expect(harness.view.view.setVisible).not.toHaveBeenCalled();
  });

  it("discards a slotted capture when that native slot was rebound during the probe", async () => {
    const harness = createHarness(createView("old-panel", true));
    harness.state.slots = [
      {
        nativeSlotId: "slot-1",
        panelId: "old-panel",
        bounds: { x: 1, y: 2, width: 30, height: 40 },
      },
    ];
    vi.mocked(harness.view.view.webContents.capturePage).mockImplementation(async () => {
      harness.state.slots = [
        {
          nativeSlotId: "slot-1",
          panelId: "new-panel",
          bounds: { x: 1, y: 2, width: 30, height: 40 },
        },
      ];
      return { isEmpty: () => true };
    });

    await harness.recovery.probeNow();

    expect(harness.deps.reconcileNativeLayerOrder).not.toHaveBeenCalled();
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
