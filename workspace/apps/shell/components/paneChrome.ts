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
  /** All logical panes, including panes in columns currently parked off-screen. */
  layoutPaneCount: number;
}

export function preferredPaneChild(state: FocusedPaneChromeState): PaneChildOption | null {
  return (
    state.children.find((child) => child.panelId === state.selectedChildPanelId) ??
    state.children[0] ??
    null
  );
}
