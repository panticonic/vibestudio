// Pure placement engine for the multi-column panel layout.
// See docs/multi-column-panel-layout-plan.md §4. No React, no Electron,
// no service calls — unit-testable in isolation.

import {
  COLUMN_DIVIDER_WIDTH,
  MIN_COLUMN_WIDTH,
  MIN_PANE_HEIGHT,
  PARKED_EDGE_TAB_WIDTH,
  PREFERRED_COLUMN_WIDTH,
  SINGLE_COLUMN_BREAKPOINT,
  mintColumnId,
  mintPaneId,
} from "./types";
import type {
  LayoutColumn,
  LayoutPane,
  PanelLayout,
  PanelPlacementHint,
  PersistedLayout,
} from "./types";

export type TreeRelation = "self" | "ancestor" | "descendant" | "sibling" | "none";
type ShowPanelOrigin = "tree-click" | "navigation-click" | "navigate-event";

export type LayoutAction =
  | {
      type: "show-panel";
      panelId: string;
      origin: ShowPanelOrigin;
    }
  | { type: "open-child"; panelId: string; parentId: string; hint?: PanelPlacementHint }
  | {
      type: "present-panel";
      panelId: string;
      anchorPanelId?: string;
      hint: PanelPlacementHint;
    }
  | { type: "open-beside"; panelId: string; anchorPaneId: string }
  | { type: "move-pane-to-new-column"; paneId: string }
  | { type: "split-below"; panelId: string; anchorPaneId: string }
  | { type: "place-in-pane"; panelId: string; paneId: string } // explicit drop on a pane handle (D8)
  | { type: "close-pane"; paneId: string }
  | { type: "tree-reconcile"; removed: Array<{ panelId: string; fallbackCandidates: string[] }> }
  | { type: "focus-pane"; paneId: string }
  | { type: "resize-columns"; columnFrs: number[] }
  | { type: "resize-panes"; columnId: string; paneFrs: number[] };

export interface LayoutEnv {
  viewportWidth: number;
  viewportHeight: number; // vertical fit tests (rule 2c/3) need it
  paneChromeHeight: number; // thin drop handle + divider per pane
  firstRootPanelId(): string | null; // seed after closing the last pane; null = empty workspace
  minWidthOf(panelId: string): number; // from placement hints / defaults
  treeRelation(a: string, b: string): TreeRelation;
  nearestVisibleRelative(panelId: string, layout: PanelLayout): string | null; // paneId
}

export interface PaneLocation {
  column: LayoutColumn;
  columnIndex: number;
  pane: LayoutPane;
  paneIndex: number;
}

// ---------------------------------------------------------------------------
// Helpers

function findLocation(
  layout: PanelLayout,
  match: (pane: LayoutPane) => boolean
): PaneLocation | null {
  let columnIndex = 0;
  for (const column of layout.columns) {
    let paneIndex = 0;
    for (const pane of column.panes) {
      if (match(pane)) return { column, columnIndex, pane, paneIndex };
      paneIndex += 1;
    }
    columnIndex += 1;
  }
  return null;
}

export function findPane(layout: PanelLayout, paneId: string): PaneLocation | null {
  return findLocation(layout, (pane) => pane.id === paneId);
}

export function paneForPanel(layout: PanelLayout, panelId: string): PaneLocation | null {
  return findLocation(layout, (pane) => pane.panelId === panelId);
}

function cloneLayout(layout: PanelLayout): PanelLayout {
  return {
    focusedPaneId: layout.focusedPaneId,
    columns: layout.columns.map((column) => ({
      ...column,
      panes: column.panes.map((pane) => ({ ...pane })),
    })),
  };
}

function sanitizeFr(fr: number): number {
  return Number.isFinite(fr) && fr > 0 ? fr : 1;
}

function renormalizeFrs<T>(
  items: T[],
  get: (item: T) => number,
  set: (item: T, fr: number) => void
): void {
  if (items.length === 0) return;
  const frs = items.map((item) => sanitizeFr(get(item)));
  const total = frs.reduce((sum, fr) => sum + fr, 0);
  const scale = items.length / total;
  items.forEach((item, i) => set(item, (frs[i] ?? 1) * scale));
}

/** Prune empty columns, renormalize fractions, and repair dangling focus. */
export function normalizeLayout(layout: PanelLayout): PanelLayout {
  const next = cloneLayout(layout);
  next.columns = next.columns.filter((column) => column.panes.length > 0);
  renormalizeFrs(
    next.columns,
    (c) => c.widthFr,
    (c, fr) => (c.widthFr = fr)
  );
  for (const column of next.columns) {
    renormalizeFrs(
      column.panes,
      (p) => p.heightFr,
      (p, fr) => (p.heightFr = fr)
    );
  }
  const firstPane = next.columns[0]?.panes[0];
  if (firstPane === undefined) {
    next.focusedPaneId = null;
  } else if (next.focusedPaneId === null || findPane(next, next.focusedPaneId) === null) {
    next.focusedPaneId = firstPane.id;
  }
  return next;
}

export function columnMinWidth(column: LayoutColumn, env: LayoutEnv): number {
  let min = MIN_COLUMN_WIDTH;
  for (const pane of column.panes) {
    min = Math.max(min, env.minWidthOf(pane.panelId), pane.minWidthOverride ?? 0);
  }
  return min;
}

function setPaneMinWidth(pane: LayoutPane, minWidth: number | undefined): void {
  if (minWidth === undefined) delete pane.minWidthOverride;
  else pane.minWidthOverride = minWidth;
}

function setPanePanel(
  pane: LayoutPane,
  panelId: string,
  hint?: Pick<PanelPlacementHint, "minWidth">
): void {
  pane.panelId = panelId;
  setPaneMinWidth(pane, hint?.minWidth);
}

function newPane(panelId: string, heightFr = 1, minWidth?: number): LayoutPane {
  return {
    id: mintPaneId(),
    heightFr,
    panelId,
    ...(minWidth !== undefined ? { minWidthOverride: minWidth } : {}),
  };
}

function newColumn(panelId: string, widthFr = 1): LayoutColumn {
  return { id: mintColumnId(), widthFr, panes: [newPane(panelId)] };
}

// ---------------------------------------------------------------------------
// Viewport residency (§3.1 / D10) — parking is derived, never stored.

export function computeViewport(
  layout: PanelLayout,
  env: LayoutEnv
): { residentColumnIds: string[]; parkedLeft: string[]; parkedRight: string[] } {
  const columns = layout.columns;
  if (columns.length === 0) {
    return { residentColumnIds: [], parkedLeft: [], parkedRight: [] };
  }
  const focusedLoc = layout.focusedPaneId ? findPane(layout, layout.focusedPaneId) : null;
  const focusIndex = focusedLoc ? focusedLoc.columnIndex : 0;

  if (env.viewportWidth < SINGLE_COLUMN_BREAKPOINT) {
    return {
      residentColumnIds: columns.slice(focusIndex, focusIndex + 1).map((c) => c.id),
      parkedLeft: columns.slice(0, focusIndex).map((c) => c.id),
      parkedRight: columns.slice(focusIndex + 1).map((c) => c.id),
    };
  }

  const minWidths = columns.map((column) => columnMinWidth(column, env));
  const minWidthAt = (index: number): number => minWidths[index] ?? MIN_COLUMN_WIDTH;
  // Contiguous run anchored on the focused column: always contains it, then
  // greedily extends right, then left, while the run still fits at min widths.
  let start = focusIndex;
  let end = focusIndex;
  const requiredWidth = (candidateStart: number, candidateEnd: number): number => {
    let width = 0;
    for (let index = candidateStart; index <= candidateEnd; index += 1) {
      width += minWidthAt(index);
    }
    width += Math.max(0, candidateEnd - candidateStart) * COLUMN_DIVIDER_WIDTH;
    if (candidateStart > 0) width += PARKED_EDGE_TAB_WIDTH;
    if (candidateEnd < columns.length - 1) width += PARKED_EDGE_TAB_WIDTH;
    return width;
  };
  while (end + 1 < columns.length && requiredWidth(start, end + 1) <= env.viewportWidth) {
    end += 1;
  }
  while (start > 0 && requiredWidth(start - 1, end) <= env.viewportWidth) {
    start -= 1;
  }
  return {
    residentColumnIds: columns.slice(start, end + 1).map((c) => c.id),
    parkedLeft: columns.slice(0, start).map((c) => c.id),
    parkedRight: columns.slice(end + 1).map((c) => c.id),
  };
}

// ---------------------------------------------------------------------------
// Persistence validation (§7 / §3.3) — persisted blobs are untrusted input.

export function validateRestoredLayout(
  persisted: unknown,
  existingPanelIds: Set<string>
): PanelLayout | null {
  if (typeof persisted !== "object" || persisted === null) return null;
  const blob = persisted as Partial<PersistedLayout>;
  if (blob.version !== 1) return null;
  const layout = blob.layout;
  if (typeof layout !== "object" || layout === null) return null;
  const rawColumns = (layout as PanelLayout).columns;
  if (!Array.isArray(rawColumns)) return null;
  const rawFocus = (layout as PanelLayout).focusedPaneId;
  if (rawFocus !== null && typeof rawFocus !== "string") return null;

  const seenPanelIds = new Set<string>();
  const seenPaneIds = new Set<string>();
  const seenColumnIds = new Set<string>();
  const columns: LayoutColumn[] = [];
  for (const rawColumn of rawColumns) {
    if (typeof rawColumn !== "object" || rawColumn === null) return null;
    const { id, widthFr, panes } = rawColumn as LayoutColumn;
    if (typeof id !== "string" || id.length === 0 || seenColumnIds.has(id)) return null;
    if (!Number.isFinite(widthFr) || widthFr <= 0) return null;
    if (!Array.isArray(panes)) return null;
    seenColumnIds.add(id);
    const keptPanes: LayoutPane[] = [];
    for (const rawPane of panes) {
      if (typeof rawPane !== "object" || rawPane === null) return null;
      const pane = rawPane as LayoutPane;
      if (typeof pane.id !== "string" || pane.id.length === 0 || seenPaneIds.has(pane.id))
        return null;
      if (typeof pane.panelId !== "string" || pane.panelId.length === 0) return null;
      if (!Number.isFinite(pane.heightFr) || pane.heightFr <= 0) return null;
      if (
        pane.minWidthOverride !== undefined &&
        (!Number.isFinite(pane.minWidthOverride) || pane.minWidthOverride <= 0)
      ) {
        return null;
      }
      seenPaneIds.add(pane.id);
      // Prune panes whose panel no longer exists, and duplicate panelIds (D3).
      if (!existingPanelIds.has(pane.panelId) || seenPanelIds.has(pane.panelId)) continue;
      seenPanelIds.add(pane.panelId);
      keptPanes.push({
        id: pane.id,
        heightFr: pane.heightFr,
        panelId: pane.panelId,
        ...(pane.minWidthOverride !== undefined ? { minWidthOverride: pane.minWidthOverride } : {}),
      });
    }
    if (keptPanes.length > 0) {
      columns.push({ id, widthFr, panes: keptPanes });
    }
  }
  if (columns.length === 0) return null;
  return normalizeLayout({ columns, focusedPaneId: rawFocus });
}

// ---------------------------------------------------------------------------
// Action application

export function applyLayoutAction(
  layout: PanelLayout,
  action: LayoutAction,
  env: LayoutEnv
): PanelLayout {
  switch (action.type) {
    case "focus-pane":
      return applyFocusPane(layout, action.paneId);
    case "show-panel":
      return applyShowPanel(cloneLayout(layout), action.panelId, action.origin, env);
    case "open-child":
      return applyHintedPlacement(
        cloneLayout(layout),
        action.panelId,
        action.parentId,
        action.hint,
        env
      );
    case "present-panel":
      return applyHintedPlacement(
        cloneLayout(layout),
        action.panelId,
        action.anchorPanelId,
        action.hint,
        env
      );
    case "open-beside":
      return applyOpenBeside(cloneLayout(layout), action.panelId, action.anchorPaneId, env);
    case "move-pane-to-new-column":
      return applyMovePaneToNewColumn(layout, action.paneId);
    case "split-below":
      return applySplitBelow(cloneLayout(layout), action.panelId, action.anchorPaneId, env);
    case "place-in-pane":
      return applyPlaceInPane(cloneLayout(layout), action.panelId, action.paneId);
    case "close-pane":
      return applyClosePane(cloneLayout(layout), action.paneId, env);
    case "tree-reconcile":
      return applyTreeReconcile(cloneLayout(layout), action.removed, env);
    case "resize-columns":
      return applyResizeColumns(cloneLayout(layout), action.columnFrs);
    case "resize-panes":
      return applyResizePanes(cloneLayout(layout), action.columnId, action.paneFrs);
  }
}

function applyFocusPane(layout: PanelLayout, paneId: string): PanelLayout {
  if (findPane(layout, paneId) === null) return layout;
  if (layout.focusedPaneId === paneId) return layout;
  const next = cloneLayout(layout);
  next.focusedPaneId = paneId;
  return next;
}

/**
 * Rule 1: show-panel — focus if visible. Direct tree/breadcrumb navigation
 * replaces the focused slot; programmatic navigation may use the nearest
 * visible relative when no slot was explicitly chosen.
 */
function applyShowPanel(
  next: PanelLayout,
  panelId: string,
  origin: ShowPanelOrigin,
  env: LayoutEnv
): PanelLayout {
  const existing = paneForPanel(next, panelId);
  if (existing) {
    next.focusedPaneId = existing.pane.id; // 1a (D3)
    return next;
  }
  const firstPane = next.columns[0]?.panes[0];
  if (firstPane === undefined) {
    next.columns = [newColumn(panelId)];
    return normalizeLayout(next);
  }
  // User navigation is how a slot is retargeted. Do not let tree proximity
  // override the pane the user deliberately focused.
  const targetPaneId =
    origin === "tree-click" || origin === "navigation-click"
      ? next.focusedPaneId
      : (env.nearestVisibleRelative(panelId, next) ?? next.focusedPaneId);
  const targetPane =
    (targetPaneId !== null ? findPane(next, targetPaneId)?.pane : undefined) ?? firstPane;
  // 1c: replace in place; the pane id (position) survives.
  setPanePanel(targetPane, panelId);
  next.focusedPaneId = targetPane.id;
  return next;
}

function horizontalFits(
  next: PanelLayout,
  childPanelId: string,
  env: LayoutEnv,
  hint?: PanelPlacementHint
): boolean {
  if (env.viewportWidth < SINGLE_COLUMN_BREAKPOINT) return false; // rule 7
  const columnsMin = next.columns.reduce((sum, column) => sum + columnMinWidth(column, env), 0);
  return (
    columnsMin +
      Math.max(MIN_COLUMN_WIDTH, env.minWidthOf(childPanelId), hint?.minWidth ?? 0) +
      next.columns.length * COLUMN_DIVIDER_WIDTH <=
    env.viewportWidth
  );
}

export function canSplitColumnVertically(
  column: LayoutColumn,
  viewportHeight: number,
  paneChromeHeight: number
): boolean {
  return (column.panes.length + 1) * (MIN_PANE_HEIGHT + paneChromeHeight) <= viewportHeight;
}

function verticalFits(column: LayoutColumn, env: LayoutEnv): boolean {
  return canSplitColumnVertically(column, env.viewportHeight, env.paneChromeHeight);
}

function insertColumnAfter(
  next: PanelLayout,
  columnIndex: number,
  panelId: string,
  env: LayoutEnv,
  hint?: PanelPlacementHint
): PanelLayout {
  const preferred = hint?.preferredWidth ?? PREFERRED_COLUMN_WIDTH;
  const pane = newPane(panelId, 1, hint?.minWidth);
  const column: LayoutColumn = {
    id: mintColumnId(),
    widthFr: preferred / PREFERRED_COLUMN_WIDTH,
    panes: [pane],
  };
  next.columns.splice(columnIndex + 1, 0, column);
  next.focusedPaneId = pane.id;
  return normalizeLayout(next);
}

function insertPaneBelow(
  next: PanelLayout,
  location: PaneLocation,
  panelId: string,
  hint?: PanelPlacementHint
): PanelLayout {
  const pane = newPane(panelId, 1, hint?.minWidth);
  location.column.panes.splice(location.paneIndex + 1, 0, pane);
  next.focusedPaneId = pane.id;
  return normalizeLayout(next);
}

/** Rule 2: hint-driven placement relative to a semantic parent or presentation anchor. */
function applyHintedPlacement(
  next: PanelLayout,
  panelId: string,
  anchorPanelId: string | undefined,
  hint: PanelPlacementHint | undefined,
  env: LayoutEnv
): PanelLayout {
  const existing = paneForPanel(next, panelId);
  if (existing) {
    if (hint !== undefined) setPaneMinWidth(existing.pane, hint.minWidth);
    next.focusedPaneId = existing.pane.id; // D3 / rule 9
    return next;
  }
  const focused = next.focusedPaneId ? findPane(next, next.focusedPaneId) : null;
  const semanticAnchor = anchorPanelId ? paneForPanel(next, anchorPanelId) : focused;
  const anchor = semanticAnchor ?? focused;
  const disposition = hint?.disposition ?? "side";

  // 2b: replace is semantic: use the requested anchor, or ordinary show rules
  // when that panel is not visible.
  if (disposition === "replace") {
    if (!semanticAnchor) return applyShowPanel(next, panelId, "navigate-event", env);
    setPanePanel(semanticAnchor.pane, panelId, hint);
    next.focusedPaneId = semanticAnchor.pane.id;
    return next;
  }

  // Visual placements fall back to the focused pane when their semantic parent
  // is hidden, preserving an explicit beside/below request from a tree menu.
  if (!anchor) return applyShowPanel(next, panelId, "navigate-event", env);

  // 2c: split-below — only if the column has vertical room; else fall through.
  if (disposition === "split-below" && verticalFits(anchor.column, env)) {
    return insertPaneBelow(next, anchor, panelId, hint);
  }

  // 2d: side (default, and split-below fallthrough) — beside if it fits, else replace (D4).
  if (horizontalFits(next, panelId, env, hint)) {
    return insertColumnAfter(next, anchor.columnIndex, panelId, env, hint);
  }
  setPanePanel(anchor.pane, panelId, hint);
  next.focusedPaneId = anchor.pane.id;
  return next;
}

/** Rule 3: explicit open-beside — always honored (may exceed the fit limit). */
function applyOpenBeside(
  next: PanelLayout,
  panelId: string,
  anchorPaneId: string,
  env: LayoutEnv
): PanelLayout {
  const existing = paneForPanel(next, panelId);
  if (existing) {
    next.focusedPaneId = existing.pane.id;
    return next;
  }
  const anchor = findPane(next, anchorPaneId);
  if (!anchor) return applyShowPanel(next, panelId, "navigate-event", env);
  return insertColumnAfter(next, anchor.columnIndex, panelId, env);
}

/** Move an existing pane as one state transition, preserving its position id. */
function applyMovePaneToNewColumn(layout: PanelLayout, paneId: string): PanelLayout {
  const location = findPane(layout, paneId);
  if (!location) return layout;
  if (location.column.panes.length === 1) {
    return applyFocusPane(layout, paneId);
  }
  const next = cloneLayout(layout);
  const nextLocation = findPane(next, paneId);
  if (!nextLocation) return layout;
  const [pane] = nextLocation.column.panes.splice(nextLocation.paneIndex, 1);
  if (!pane) return layout;
  pane.heightFr = 1;
  next.columns.splice(nextLocation.columnIndex + 1, 0, {
    id: mintColumnId(),
    widthFr: nextLocation.column.widthFr,
    panes: [pane],
  });
  next.focusedPaneId = pane.id;
  return normalizeLayout(next);
}

/** Rule 3: explicit split-below — honored iff the vertical fit test passes; else open-beside. */
function applySplitBelow(
  next: PanelLayout,
  panelId: string,
  anchorPaneId: string,
  env: LayoutEnv
): PanelLayout {
  const existing = paneForPanel(next, panelId);
  if (existing) {
    next.focusedPaneId = existing.pane.id;
    return next;
  }
  const anchor = findPane(next, anchorPaneId);
  if (!anchor) return applyShowPanel(next, panelId, "navigate-event", env);
  if (!verticalFits(anchor.column, env)) {
    return applyOpenBeside(next, panelId, anchorPaneId, env);
  }
  return insertPaneBelow(next, anchor, panelId);
}

/** Explicit drop on a pane handle: show the panel in exactly that pane (D8/D3). */
function applyPlaceInPane(next: PanelLayout, panelId: string, paneId: string): PanelLayout {
  const target = findPane(next, paneId);
  if (!target) return next;
  const existing = paneForPanel(next, panelId);
  if (existing) {
    // Already visible elsewhere: focus its pane, never duplicate (D3).
    next.focusedPaneId = existing.pane.id;
    return next;
  }
  setPanePanel(target.pane, panelId);
  next.focusedPaneId = target.pane.id;
  return next;
}

/** Rule 4: close-pane — layout-only removal with fr redistribution and last-pane reseed. */
function applyClosePane(next: PanelLayout, paneId: string, env: LayoutEnv): PanelLayout {
  const location = findPane(next, paneId);
  if (!location) return next;
  const wasFocused = next.focusedPaneId === paneId;
  location.column.panes.splice(location.paneIndex, 1);

  if (location.column.panes.length === 0) {
    next.columns.splice(location.columnIndex, 1);
  }

  if (next.columns.length === 0) {
    // Closing the last pane reseeds from the first root panel (§4.4).
    const seed = env.firstRootPanelId();
    if (seed === null) {
      return { columns: [], focusedPaneId: null };
    }
    return normalizeLayout({ columns: [newColumn(seed)], focusedPaneId: null });
  }

  if (wasFocused) {
    // Same column first: nearest surviving pane by index; then the left
    // neighbor column (or the new first column when none).
    const neighborIndex = Math.max(0, Math.min(location.columnIndex - 1, next.columns.length - 1));
    const focusPane =
      location.column.panes[Math.min(location.paneIndex, location.column.panes.length - 1)] ??
      next.columns[neighborIndex]?.panes[0];
    next.focusedPaneId = focusPane?.id ?? null;
  }
  return normalizeLayout(next);
}

/** Rule 5 / rule 8: one atomic pass for every panel removed by a tree update. */
function applyTreeReconcile(
  next: PanelLayout,
  removed: Array<{ panelId: string; fallbackCandidates: string[] }>,
  env: LayoutEnv
): PanelLayout {
  const removedIds = new Set(removed.map((entry) => entry.panelId));
  const panesToClose: string[] = [];
  for (const entry of removed) {
    const location = paneForPanel(next, entry.panelId);
    if (!location) continue;
    const candidate = entry.fallbackCandidates.find(
      (candidateId) => !removedIds.has(candidateId) && paneForPanel(next, candidateId) === null
    );
    if (candidate !== undefined) {
      setPanePanel(location.pane, candidate);
    } else {
      panesToClose.push(location.pane.id);
    }
  }
  let result: PanelLayout = next;
  for (const paneId of panesToClose) {
    result = applyClosePane(cloneLayout(result), paneId, env);
  }
  return normalizeLayout(result);
}

/** Rule 6: dividers write fractions; clamping happens at render time. */
function applyResizeColumns(next: PanelLayout, columnFrs: number[]): PanelLayout {
  if (columnFrs.length !== next.columns.length) return next;
  next.columns.forEach((column, i) => {
    column.widthFr = sanitizeFr(columnFrs[i] ?? 1);
  });
  renormalizeFrs(
    next.columns,
    (c) => c.widthFr,
    (c, fr) => (c.widthFr = fr)
  );
  return next;
}

function applyResizePanes(next: PanelLayout, columnId: string, paneFrs: number[]): PanelLayout {
  const column = next.columns.find((c) => c.id === columnId);
  if (!column || paneFrs.length !== column.panes.length) return next;
  column.panes.forEach((pane, i) => {
    pane.heightFr = sanitizeFr(paneFrs[i] ?? 1);
  });
  renormalizeFrs(
    column.panes,
    (p) => p.heightFr,
    (p, fr) => (p.heightFr = fr)
  );
  return next;
}
