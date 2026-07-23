// Tree→layout drag placement (W5, D8/D9): droppable ids for pane handles and
// column gutters, and the window event the dnd context uses to hand a drop to
// the layout engine host (PanelStack).

export const LAYOUT_DROP_EVENT = "shell-layout-drop";

const PANE_PREFIX = "layout-drop:pane:";
const GUTTER_PREFIX = "layout-drop:gutter:";

export interface LayoutDropDetail {
  panelId: string;
  target: LayoutDropTarget;
}

export type LayoutDropTarget =
  | { kind: "pane"; paneId: string } // drop on a pane handle → show in that pane
  | { kind: "gutter"; columnId: string }; // drop on a gutter → new column after it

export function paneDropId(paneId: string): string {
  return `${PANE_PREFIX}${paneId}`;
}

export function gutterDropId(columnId: string): string {
  return `${GUTTER_PREFIX}${columnId}`;
}

export function parseLayoutDropId(id: string): LayoutDropTarget | null {
  if (id.startsWith(PANE_PREFIX)) return { kind: "pane", paneId: id.slice(PANE_PREFIX.length) };
  if (id.startsWith(GUTTER_PREFIX)) {
    return { kind: "gutter", columnId: id.slice(GUTTER_PREFIX.length) };
  }
  return null;
}

export function dispatchLayoutDrop(panelId: string, target: LayoutDropTarget): void {
  window.dispatchEvent(
    new CustomEvent<LayoutDropDetail>(LAYOUT_DROP_EVENT, { detail: { panelId, target } })
  );
}
