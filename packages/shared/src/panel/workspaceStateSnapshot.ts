import type { EntityRecord } from "../runtime/entitySpec.js";
import type { PanelEntityId, PanelSlotId } from "./ids.js";
import type {
  PanelTreePage,
  PanelTreePageInput,
  PanelTreeNode,
  PanelTreePath,
  PanelTreePlacement,
  PanelTreeRootGroupPage,
  PanelTreeRootGroupPageInput,
  PanelTreeSearchInput,
  PanelTreeSearchPage,
} from "./treeIndex.js";

/** Durable slot row used to reconstruct the authoritative panel forest. */
export interface WorkspacePanelTreeSlot {
  slot_id: PanelSlotId;
  parent_slot_id: PanelSlotId | null;
  current_entity_id: PanelEntityId | null;
  current_entity_title?: string | null;
  current_entry_key: string | null;
  current_history_cursor?: number | null;
  history_count?: number;
  sort_key: number;
  owner_user_id?: string | null;
  created_at: number;
  closed_at: number | null;
}

/** One durable navigation-history row in an authoritative tree snapshot. */
export interface WorkspacePanelTreeHistoryRow {
  slot_id: PanelSlotId;
  cursor: number;
  entry_key: string;
  entity_id: PanelEntityId;
  source: string;
  context_id: string;
  state_args: string | null;
  options?: string | null;
  recorded_at: number;
}

/** Addressed runtime detail for one panel; bounded independently of tree size/history length. */
export interface WorkspacePanelDetail {
  revision: number;
  icon?: string;
  iconVersion?: string;
  iconState?: string;
  slot: WorkspacePanelTreeSlot;
  currentHistory: WorkspacePanelTreeHistoryRow;
  entity: EntityRecord;
}

export interface WorkspacePanelCloseResult {
  closeId: string;
  closedCount: number;
}

/**
 * One close that can be undone now. A close is identified by its root slot and
 * its `closedAt` stamp, which is unique per close operation. It is reopenable
 * while its root's parent is open (or it closed a root).
 */
export interface WorkspaceClosedPanel {
  slotId: PanelSlotId;
  parentSlotId: PanelSlotId | null;
  closedAt: number;
  /** Slots this close took down, the root included. */
  closedCount: number;
  /** The root's current entry when it closed. */
  entityId: PanelEntityId;
  source: string;
}

/** A closed panel as presented to shells: the raw close plus its display title. */
export interface WorkspacePresentedClosedPanel extends WorkspaceClosedPanel {
  title: string;
}

/** What reopening one close must reactivate before the close can be reversed. */
export interface WorkspacePanelReopenPlan {
  slotId: PanelSlotId;
  closedAt: number;
  /** Every slot the close took down, root first, each with its current history entry. */
  slots: Array<{ slotId: PanelSlotId; entry: WorkspacePanelTreeHistoryRow }>;
}

/** Keyset position just after `entry` in the most-recent-first closed-panel order. */
export function closedPanelCursor(entry: { closedAt: number; slotId: string }): string {
  return JSON.stringify([entry.closedAt, entry.slotId]);
}

/** One page of reopenable closes, most recent first. */
export interface WorkspacePresentedClosedPanelPage {
  items: WorkspacePresentedClosedPanel[];
  nextCursor: string | null;
}

export interface WorkspaceClosedPanelsInput {
  /** Only closes in trees this user owns; omitted means every tree. */
  ownerUserId?: string | null;
  limit?: number;
  cursor?: string;
  /** Case-insensitive match against the closed panel's title or source. */
  query?: string;
}

/** What permanently deleting one close removes. */
export interface WorkspacePanelPurgePlan {
  slotId: PanelSlotId;
  closedAt: number;
  /** The closed root's whole subtree, deepest first. */
  slotIds: PanelSlotId[];
  /** Contexts no surviving history entry or live entity uses; destroyed before the purge. */
  orphanContextIds: string[];
}

export interface WorkspacePanelReopenInput {
  slotId: PanelSlotId;
  /** The close being reversed; a later close of the same slot is a different close. */
  closedAt: number;
}

export interface WorkspacePanelReopenResult {
  slotId: PanelSlotId;
  reopenedCount: number;
}

export interface WorkspacePanelCloseCleanupPage {
  items: Array<{ slotId: PanelSlotId; entityId: PanelEntityId | null }>;
  nextCursor: string | null;
}

export interface WorkspacePanelCloseCleanupPageInput {
  closeId?: string;
  ownerUserId?: string | null;
  cursor?: string;
  limit?: number;
}

/** Raw durable topology produced by WorkspaceDO before Base presentation composition. */
export type WorkspacePanelTopologyNode = Omit<
  PanelTreeNode,
  "title" | "icon" | "kind" | "ref" | "placement"
> & { options?: string | null };
export interface WorkspacePanelTopologyPage {
  revision: number;
  group: import("./treeIndex.js").PanelTreeGroup;
  nodes: WorkspacePanelTopologyNode[];
  nextCursor: string | null;
}
export interface WorkspacePanelTopologyPath {
  revision: number;
  nodes: WorkspacePanelTopologyNode[];
}

/** Query-first tree contracts composed at the workspace-state service boundary. */
export type WorkspacePanelTreePage = PanelTreePage;
export type WorkspacePanelTreePageInput = PanelTreePageInput;
export type WorkspacePanelTreePath = PanelTreePath;
export type WorkspacePanelTreeRootGroupPage = PanelTreeRootGroupPage;
export type WorkspacePanelTreeRootGroupPageInput = PanelTreeRootGroupPageInput;
export type WorkspacePanelTreeSearchInput = PanelTreeSearchInput;
export type WorkspacePanelTreeSearchPage = PanelTreeSearchPage;
export type WorkspacePanelTreePlacement = PanelTreePlacement;
