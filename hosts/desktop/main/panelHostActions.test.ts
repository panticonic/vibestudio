import { describe, expect, it, vi } from "vitest";
import { PanelHostActions, PANEL_HOST_ACTIONS } from "./panelHostActions.js";

describe("panel commands while protected settings are open", () => {
  it("keeps underlying panels untouched while retaining window controls", async () => {
    const toggleWindowFullscreen = vi.fn();
    const openHostChromeClientDevTools = vi.fn();
    const focusedWorkspace = vi.fn();
    const cycler = vi.fn();
    const close = vi.fn();
    const actions = new PanelHostActions({
      viewManager: {
        hasBrowserDataSurface: () => true,
        toggleWindowFullscreen,
        openHostChromeClientDevTools,
      } as never,
      window: { close } as never,
      focusedWorkspace,
      cycler,
    });
    for (const action of PANEL_HOST_ACTIONS) await actions.run(action);
    expect(focusedWorkspace).not.toHaveBeenCalled();
    expect(cycler).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(toggleWindowFullscreen).toHaveBeenCalledOnce();
    expect(openHostChromeClientDevTools).toHaveBeenCalledOnce();
  });
});
