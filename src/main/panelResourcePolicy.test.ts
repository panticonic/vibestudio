import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PanelResourcePolicy, type PanelResourcePolicyDeps } from "./panelResourcePolicy.js";

function createHarness(
  overrides: Partial<
    Pick<
      PanelResourcePolicyDeps,
      "tracksAssignedResources" | "maximumLoadedPanels" | "idleUnloadMs" | "idleSweepIntervalMs"
    >
  > = {}
) {
  const state = {
    focusedPanelId: null as string | null,
    pinned: new Set<string>(),
    keepLoaded: new Set<string>(),
    panels: new Set<string>(),
  };
  const unload = vi.fn(async () => undefined);
  const reportUnloadError = vi.fn();
  const deps: PanelResourcePolicyDeps = {
    tracksAssignedResources: true,
    maximumLoadedPanels: null,
    idleUnloadMs: null,
    idleSweepIntervalMs: 50,
    now: () => Date.now(),
    getFocusedPanelId: () => state.focusedPanelId,
    isPinned: (panelId) => state.pinned.has(panelId),
    isKeepLoaded: (panelId) => state.keepLoaded.has(panelId),
    panelExists: (panelId) => state.panels.has(panelId),
    unload,
    reportUnloadError,
    ...overrides,
  };
  return {
    authority: new PanelResourcePolicy(deps),
    state,
    unload,
    reportUnloadError,
  };
}

describe("PanelResourcePolicy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("idle-unloads only unprotected tracked panels", async () => {
    const harness = createHarness({ idleUnloadMs: 100 });
    for (const panelId of ["focused", "pinned", "automated", "idle"]) {
      harness.state.panels.add(panelId);
      harness.authority.track(panelId);
    }
    harness.state.focusedPanelId = "focused";
    harness.state.pinned.add("pinned");
    harness.state.keepLoaded.add("automated");
    harness.authority.start();

    await vi.advanceTimersByTimeAsync(100);

    expect(harness.unload).toHaveBeenCalledOnce();
    expect(harness.unload).toHaveBeenCalledWith("idle", "idle-timeout");
  });

  it("keeps original activity while pinned so unpinning is effective on the next sweep", async () => {
    const harness = createHarness({ idleUnloadMs: 100 });
    harness.state.panels.add("panel-1");
    harness.state.pinned.add("panel-1");
    harness.authority.track("panel-1");
    harness.authority.start();

    await vi.advanceTimersByTimeAsync(200);
    expect(harness.unload).not.toHaveBeenCalled();

    harness.state.pinned.delete("panel-1");
    await vi.advanceTimersByTimeAsync(50);
    expect(harness.unload).toHaveBeenCalledWith("panel-1", "idle-timeout");
  });

  it("refreshes loaded activity without manufacturing phantom resources", async () => {
    const harness = createHarness({ idleUnloadMs: 100 });
    harness.state.panels.add("loaded");
    harness.state.panels.add("unloaded");
    harness.authority.track("loaded");
    harness.authority.start();

    await vi.advanceTimersByTimeAsync(75);
    harness.authority.refreshActivity("loaded");
    harness.authority.refreshActivity("unloaded");
    await vi.advanceTimersByTimeAsync(75);

    expect(harness.unload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(harness.unload).toHaveBeenCalledOnce();
    expect(harness.unload).toHaveBeenCalledWith("loaded", "idle-timeout");
  });

  it("evicts the oldest unprotected panel while retaining the new and pinned panels", async () => {
    const harness = createHarness({ maximumLoadedPanels: 2 });
    for (const panelId of ["pinned", "old", "new"]) harness.state.panels.add(panelId);
    harness.state.pinned.add("pinned");
    harness.authority.track("pinned");
    vi.setSystemTime(1);
    harness.authority.track("old");
    vi.setSystemTime(2);
    harness.authority.track("new");

    await harness.authority.enforceCap("new");

    expect(harness.unload).toHaveBeenCalledOnce();
    expect(harness.unload).toHaveBeenCalledWith("old", "resource-cap");
  });

  it("does not track resources for hosts that do not load assigned leases", async () => {
    const harness = createHarness({
      tracksAssignedResources: false,
      maximumLoadedPanels: 1,
      idleUnloadMs: 1,
    });
    harness.state.panels.add("panel-1");
    harness.authority.track("panel-1");
    harness.authority.start();

    await harness.authority.enforceCap("other");
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.unload).not.toHaveBeenCalled();
  });

  it("prunes missing panels and reports unload failures exactly once", async () => {
    const harness = createHarness({ maximumLoadedPanels: 1 });
    harness.authority.track("missing");
    harness.state.panels.add("broken");
    harness.authority.track("broken");
    harness.state.panels.add("new");
    harness.authority.track("new");
    harness.unload.mockRejectedValueOnce(new Error("unload failed"));

    await harness.authority.enforceCap("new");
    await harness.authority.enforceCap("new");

    expect(harness.unload).toHaveBeenCalledOnce();
    expect(harness.unload).toHaveBeenCalledWith("broken", "resource-cap");
    expect(harness.reportUnloadError).toHaveBeenCalledOnce();
  });
});
