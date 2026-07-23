// Layout data model for the multi-column panel viewport.
// See docs/multi-column-panel-layout-plan.md §3.

export interface PanelLayout {
  columns: LayoutColumn[]; // left-to-right
  focusedPaneId: string | null; // layout-level focus (not DOM focus)
}

export interface LayoutColumn {
  id: string; // stable pane-position id, e.g. "col-a3f2"
  widthFr: number; // proportional width (fr units), normalized
  panes: LayoutPane[]; // top-to-bottom
}

export interface LayoutPane {
  id: string; // stable, e.g. "pane-9c1d" — is the *position* id
  heightFr: number; // proportional height within the column
  panelId: string; // content currently shown here
}

// Local copy of the placement hint (§3.2) until the shared type lands in
// @vibestudio/types / PackageManifest plumbing (W4).
export interface PanelPlacementHint {
  disposition?: "side" | "replace" | "split-below"; // default "side"
  preferredWidth?: number; // px, default PREFERRED_COLUMN_WIDTH
  minWidth?: number; // px, default MIN_COLUMN_WIDTH
}

// Per-device persistence schema (§3.3). Treated as untrusted on restore.
export interface PersistedLayout {
  version: 1;
  workspaceId: string;
  layout: PanelLayout; // panelIds validated against tree on restore
  updatedAt: string;
}

export const MIN_COLUMN_WIDTH = 420;
export const PREFERRED_COLUMN_WIDTH = 560;
export const MIN_PANE_HEIGHT = 160;
export const SINGLE_COLUMN_BREAKPOINT = 900;
export const COLUMN_DIVIDER_WIDTH = 7;
export const PARKED_EDGE_TAB_WIDTH = 32;

function mintId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

export function mintPaneId(): string {
  return mintId("pane");
}

export function mintColumnId(): string {
  return mintId("col");
}

export function nativeSlotIdForPane(paneId: string): string {
  return `panel-stack:${paneId}`;
}
