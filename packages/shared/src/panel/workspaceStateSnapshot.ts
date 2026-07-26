import type { EntityRecord } from "../runtime/entitySpec.js";
import type { PanelEntityId, PanelSlotId } from "./ids.js";

/** Durable slot row used to reconstruct the authoritative panel forest. */
export interface WorkspacePanelTreeSlot {
  slot_id: PanelSlotId;
  parent_slot_id: PanelSlotId | null;
  current_entity_id: PanelEntityId | null;
  current_entity_title?: string | null;
  current_entry_key: string | null;
  position_id: string;
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

/**
 * One internally consistent read of every durable input needed to reconstruct
 * the panel tree. `revision` changes whenever a row visible through this
 * projection changes.
 */
export interface WorkspacePanelTreeStateSnapshot {
  revision: number;
  slots: WorkspacePanelTreeSlot[];
  histories: WorkspacePanelTreeHistoryRow[];
  entities: EntityRecord[];
}
