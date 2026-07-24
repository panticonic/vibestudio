export type PaneChromeCommand =
  | { type: "new-child" }
  | { type: "open-child-beside"; panelId: string }
  | { type: "close-pane" };

export interface PaneChildOption {
  panelId: string;
  title: string;
}

export interface FocusedPaneChromeState {
  paneId: string;
  panelId: string;
  children: PaneChildOption[];
  selectedChildPanelId: string | null;
  /**
   * Panes currently on screen, across every resident column. Chrome uses this to
   * decide whether closing a pane is meaningful: at one, there is nothing to
   * close back to, so the affordance stays hidden.
   */
  visiblePaneCount: number;
}

export function preferredPaneChild(state: FocusedPaneChromeState): PaneChildOption | null {
  return (
    state.children.find((child) => child.panelId === state.selectedChildPanelId) ??
    state.children[0] ??
    null
  );
}
