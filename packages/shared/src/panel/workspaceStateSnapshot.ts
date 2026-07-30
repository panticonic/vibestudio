import type { EntityRecord } from "../runtime/entitySpec.js";
import type { PanelEntityId, PanelSlotId } from "./ids.js";
import type {
  PanelTreePage,
  PanelTreePageInput,
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
  slot: WorkspacePanelTreeSlot;
  currentHistory: WorkspacePanelTreeHistoryRow;
  entity: EntityRecord;
}

export interface WorkspacePanelCloseResult {
  closeId: string;
  closedCount: number;
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

/** Query-first tree contracts exposed by durable workspace state. */
export type WorkspacePanelTreePage = PanelTreePage;
export type WorkspacePanelTreePageInput = PanelTreePageInput;
export type WorkspacePanelTreePath = PanelTreePath;
export type WorkspacePanelTreeRootGroupPage = PanelTreeRootGroupPage;
export type WorkspacePanelTreeRootGroupPageInput = PanelTreeRootGroupPageInput;
export type WorkspacePanelTreeSearchInput = PanelTreeSearchInput;
export type WorkspacePanelTreeSearchPage = PanelTreeSearchPage;
export type WorkspacePanelTreePlacement = PanelTreePlacement;
