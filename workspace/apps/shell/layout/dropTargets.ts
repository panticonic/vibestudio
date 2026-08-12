// Tree→layout drag placement: one explicit viewport shelf owns the available
// presentation choices and hands the selected position to PanelStack.

export const LAYOUT_DROP_EVENT = "shell-layout-drop";

const VIEWPORT_PREFIX = "layout-drop:viewport:";

export type ViewportDropPosition = "left" | "full" | "right";

export interface LayoutDropDetail {
  panelId: string;
  target: LayoutDropTarget;
}

export type LayoutDropTarget = { kind: "viewport"; position: ViewportDropPosition };

export function viewportDropId(position: ViewportDropPosition): string {
  return `${VIEWPORT_PREFIX}${position}`;
}

export function parseLayoutDropId(id: string): LayoutDropTarget | null {
  if (!id.startsWith(VIEWPORT_PREFIX)) return null;
  const position = id.slice(VIEWPORT_PREFIX.length);
  if (position === "left" || position === "full" || position === "right") {
    return { kind: "viewport", position };
  }
  return null;
}

export function dispatchLayoutDrop(panelId: string, target: LayoutDropTarget): void {
  window.dispatchEvent(
    new CustomEvent<LayoutDropDetail>(LAYOUT_DROP_EVENT, { detail: { panelId, target } })
  );
}
