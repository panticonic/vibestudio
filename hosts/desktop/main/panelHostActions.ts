import type { BaseWindow } from "electron";
import type { BridgePanelLifecycle } from "@vibestudio/shared/panelInterfaces";
import type { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import type { PanelCycler } from "./panelCycleController.js";
import type { ViewManager } from "./viewManager.js";
import { workspaceNativeViewId } from "./workspaceNativeViews.js";

/**
 * What a panel-hosting client may ask the host to do to the panel surface it
 * hosts. Each action needs the compositor (zoom, fullscreen, display repair,
 * devtools) or the cross-workspace panel walk, which only the host holds.
 * Everything else a client's menus do is the client's own business.
 */
export const PANEL_HOST_ACTIONS = [
  "zoom-in",
  "zoom-out",
  "reset-zoom",
  "toggle-fullscreen",
  "toggle-panel-fullscreen",
  "refresh-display",
  "copy-display-diagnostics",
  "toggle-client-devtools",
  "close-focused-panel",
  "next-panel",
  "previous-panel",
] as const;

export type PanelHostAction = (typeof PANEL_HOST_ACTIONS)[number];

export function isPanelHostAction(value: unknown): value is PanelHostAction {
  return typeof value === "string" && (PANEL_HOST_ACTIONS as readonly string[]).includes(value);
}

export interface FocusedWorkspace {
  workspaceId: string;
  registry: PanelRegistry;
  orchestrator: Pick<BridgePanelLifecycle, "closePanel">;
}

export interface PanelHostActionDeps {
  viewManager: ViewManager;
  window: BaseWindow;
  focusedWorkspace(): FocusedWorkspace | null;
  cycler(): PanelCycler | null;
}

export class PanelHostActions {
  constructor(private readonly deps: PanelHostActionDeps) {}

  async run(action: PanelHostAction): Promise<void> {
    const { viewManager: vm } = this.deps;
    switch (action) {
      case "zoom-in":
      case "zoom-out": {
        const viewId = this.focusedViewId();
        if (viewId) vm.stepZoom(viewId, action === "zoom-in" ? 1 : -1);
        return;
      }
      case "reset-zoom": {
        const viewId = this.focusedViewId();
        if (viewId) vm.resetZoom(viewId);
        return;
      }
      case "toggle-fullscreen":
        await vm.toggleWindowFullscreen();
        return;
      case "toggle-panel-fullscreen": {
        const viewId = this.focusedViewId();
        if (viewId) await vm.togglePanelFullscreen(viewId);
        return;
      }
      case "refresh-display":
        vm.refreshVisiblePanel();
        vm.forceRepaintVisiblePanel();
        return;
      case "copy-display-diagnostics":
        await vm.copyPanelDisplayDiagnosticsToClipboard();
        return;
      case "toggle-client-devtools":
        vm.openHostChromeClientDevTools();
        return;
      case "close-focused-panel": {
        const workspace = this.deps.focusedWorkspace();
        const focusedId = workspace?.registry.getFocusedPanelId();
        if (workspace && focusedId) await workspace.orchestrator.closePanel(focusedId);
        else this.deps.window.close();
        return;
      }
      case "next-panel":
      case "previous-panel": {
        const cycler = this.deps.cycler();
        if (!cycler) throw new Error("Panel cycling is not ready");
        cycler.cycle(action === "next-panel");
        return;
      }
    }
  }

  private focusedViewId(): string | null {
    const workspace = this.deps.focusedWorkspace();
    const focusedId = workspace?.registry.getFocusedPanelId();
    if (!workspace || !focusedId) return null;
    return workspaceNativeViewId({ workspaceId: workspace.workspaceId, runtimeId: focusedId });
  }
}
