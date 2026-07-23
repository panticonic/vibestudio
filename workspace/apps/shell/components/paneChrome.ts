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
}

export function preferredPaneChild(state: FocusedPaneChromeState): PaneChildOption | null {
  return (
    state.children.find((child) => child.panelId === state.selectedChildPanelId) ??
    state.children[0] ??
    null
  );
}
