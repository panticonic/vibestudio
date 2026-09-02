/**
 * A sibling collection is the unit of tree paging and cache invalidation.
 * Root collections are owner-scoped; child collections are identified solely
 * by their parent.
 */
export type PanelTreeGroup =
  | { kind: "roots"; ownerUserId: string | null }
  | { kind: "children"; parentSlotId: string };

/** The bounded projection rendered by tree browsers. */
export interface PanelTreeNode {
  slotId: string;
  parentSlotId: string | null;
  ownerUserId: string | null;
  title: string;
  icon?: string;
  iconVersion?: string;
  iconState?: string;
  createdAt: number;
  childCount: number;
  source?: string;
  kind?: "workspace" | "browser";
  contextId?: string;
  runtimeEntityId?: string | null;
  effectiveVersion?: string | null;
  buildKey?: string | null;
  ref?: string | null;
  placement?: PanelTreePlacementHint;
}

export interface PanelTreePlacementHint {
  disposition?: "side" | "side-if-room" | "replace" | "split-below";
  preferredWidth?: number;
  minWidth?: number;
}

export interface PanelTreePage {
  revision: number;
  group: PanelTreeGroup;
  nodes: PanelTreeNode[];
  nextCursor: string | null;
}

export interface PanelTreePageInput {
  group: PanelTreeGroup;
  cursor?: string;
  limit?: number;
}

export interface PanelTreePageWindow {
  cursor?: string;
  limit?: number;
}

export interface PanelTreeRootGroup {
  ownerUserId: string | null;
  rootCount: number;
}

export interface PanelTreeRootGroupPage {
  revision: number;
  groups: PanelTreeRootGroup[];
  nextCursor: string | null;
}

export interface PanelTreeRootGroupPageInput {
  cursor?: string;
  limit?: number;
}

/** Root-to-target path. It is always bounded by tree depth, never tree size. */
export interface PanelTreePath {
  revision: number;
  nodes: PanelTreeNode[];
}

export interface PanelTreeSearchHit {
  node: PanelTreeNode;
  /** Root-to-parent breadcrumb, excluding `node`. */
  ancestors: PanelTreeNode[];
  /** True when only the nearest breadcrumb suffix is included. */
  ancestorsTruncated?: boolean;
}

export interface PanelTreeSearchPage {
  revision: number;
  hits: PanelTreeSearchHit[];
  nextCursor: string | null;
}

export interface PanelTreeSearchInput {
  /**
   * Plain-text search over indexed title, source/path, manifest
   * description/dependencies, tags, and keywords. Punctuation separates terms;
   * query-language operators are not accepted.
   */
  query: string;
  cursor?: string;
  limit?: number;
}

/**
 * Stable-neighbor placement. Omitted anchors mean "newest/top". At least one
 * anchor may be supplied for an explicit move; when both are supplied they
 * must be adjacent siblings in this order.
 */
export interface PanelTreePlacement {
  beforeSlotId?: string | null;
  afterSlotId?: string | null;
}

/**
 * Events are cache invalidations, not replicated state. A revision gap is
 * harmless: consumers discard affected cached pages and query current truth.
 */
export interface PanelTreeInvalidation {
  revision: number;
  /** True when callers should discard every cached page. */
  reset: boolean;
  groups: PanelTreeGroup[];
  changedSlotIds: string[];
  removedSlotIds: string[];
}

export function panelTreeGroupKey(group: PanelTreeGroup): string {
  return group.kind === "children"
    ? `children:${group.parentSlotId}`
    : `roots:${group.ownerUserId ?? ""}`;
}
