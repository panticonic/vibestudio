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

/**
 * One durable quickfire mapping: the panel slot a micro-conversation is bound
 * to, and the channel/agent that back it. Timestamps are display and lifecycle
 * markers only — quickfire conversations never expire on a clock.
 */
export interface WorkspaceQuickfireSession {
  slotId: PanelSlotId;
  channelId: string;
  agentEntityId: string | null;
  contextId: string;
  createdAt: number;
  clearedAt: number | null;
  promotedAt: number | null;
}

/** Result of binding a slot to a quickfire conversation. */
export interface WorkspaceQuickfireBindResult {
  session: WorkspaceQuickfireSession;
  /** False when a concurrent bind already owned the slot and won. */
  created: boolean;
}

/** One queued quickfire archival, drained host-side exactly like panel close cleanup. */
export interface WorkspaceQuickfireCleanupItem {
  channelId: string;
  slotId: PanelSlotId;
  agentEntityId: string | null;
  contextId: string;
}

export interface WorkspaceQuickfireCleanupPage {
  items: WorkspaceQuickfireCleanupItem[];
  nextCursor: string | null;
}

export interface WorkspaceQuickfireCleanupPageInput {
  closeId?: string;
  cursor?: string;
  limit?: number;
}

/** Raw durable topology produced by WorkspaceDO before Base presentation composition. */
export type WorkspacePanelTopologyNode = Omit<
  PanelTreeNode,
  "title" | "icon" | "kind" | "ref" | "placement"
> & { options?: string | null };
/** @deprecated Internal raw topology alias retained for the Base presentation composer. */
export type WorkspacePanelTreeNode = WorkspacePanelTopologyNode;
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
