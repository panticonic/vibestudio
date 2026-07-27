/**
 * Shell-facing client surfaces for the server-side `workspace-state` and
 * `runtime` services.
 *
 * These describe what the shell (Electron main / mobile main) sends over RPC.
 * They are pure type contracts — the concrete RPC client is wired separately
 * by each shell. `panelManager` consumes these via dependency injection.
 */

import type {
  EntityRecord,
  RuntimeCodeEntityCreateSpec,
  RuntimeEntityCreateSpec,
  RuntimeEntityHandle,
} from "@vibestudio/shared/runtime/entitySpec";
import type { PanelEntityId, PanelSlotId } from "@vibestudio/shared/panel/ids";
import type {
  WorkspacePanelTreeHistoryRow,
  WorkspacePanelTreeSlot,
  WorkspacePanelTreeStateSnapshot,
} from "@vibestudio/shared/panel/workspaceStateSnapshot";

export interface SlotHistoryEntryInput {
  entryKey: string;
  entityId: PanelEntityId;
  source: string;
  contextId: string;
  stateArgs?: unknown;
  /** Per-entry navigation options (env/ref), persisted so any client reconstructs them. */
  options?: unknown;
}

export type SlotPreparedNavigationMutation =
  | { kind: "append"; entry: SlotHistoryEntryInput }
  | { kind: "replace"; entry: SlotHistoryEntryInput }
  | { kind: "select"; entryKey: string };

export interface SlotCommitPreparedNavigationInput {
  slotId: PanelSlotId;
  /** Compare-and-swap guard: the entity current when preparation began. */
  expectedCurrentEntityId: PanelEntityId;
  mutation: SlotPreparedNavigationMutation;
}

export interface SlotCommitPreparedNavigationResult {
  previousEntityId: PanelEntityId;
  currentEntityId: PanelEntityId;
  currentEntryKey: string;
  cursor: number;
}

export interface SlotCreateInput {
  slotId: PanelSlotId;
  parentSlotId: PanelSlotId | null;
  positionId: string;
  initialEntry?: SlotHistoryEntryInput;
}

export type SlotRow = WorkspacePanelTreeSlot;
export type SlotHistoryRow = WorkspacePanelTreeHistoryRow;
export type PanelTreeStateSnapshot = WorkspacePanelTreeStateSnapshot;

/**
 * Client surface mirroring the `workspace-state` server service.
 * Read methods (the panel-tree aggregate, slot list/get/history, and entity
 * resolution) are available to any kind; write methods (everything starting
 * with `slot` other than reads) are only routable from shell/server callers.
 */
export interface WorkspaceStateClient {
  getPanelTreeStateSnapshot(): Promise<PanelTreeStateSnapshot>;
  listSlots(): Promise<SlotRow[]>;
  getSlot(slotId: PanelSlotId): Promise<SlotRow | null>;
  getSlotHistory(slotId: PanelSlotId): Promise<SlotHistoryRow[]>;
  resolveActiveEntity(id: string): Promise<EntityRecord | null>;
  resolveEntity(id: string): Promise<EntityRecord | null>;
  /**
   * Durable nav→slot: the OPEN slot id whose current runtime entity is `entityId`, or null.
   * Returns a raw string; callers brand it via `asPanelSlotId` (validated) at the use site.
   */
  resolveSlotByEntity(entityId: string): Promise<string | null>;

  createSlot(input: SlotCreateInput): Promise<void>;
  commitPreparedNavigation(
    input: SlotCommitPreparedNavigationInput
  ): Promise<SlotCommitPreparedNavigationResult>;
  updateCurrentStateArgs(slotId: PanelSlotId, stateArgs: unknown): Promise<void>;
  setSlotParent(slotId: PanelSlotId, parentSlotId: PanelSlotId | null): Promise<void>;
  setSlotPosition(slotId: PanelSlotId, positionId: string): Promise<void>;
  moveSlot(
    slotId: PanelSlotId,
    parentSlotId: PanelSlotId | null,
    positionId: string
  ): Promise<void>;
  closeSlot(slotId: PanelSlotId): Promise<void>;
}

/**
 * Client surface mirroring the `runtime` server service. Used by panelManager
 * (and any other code that creates panels/workers/DOs) to mint entities.
 */
export interface RuntimeClient {
  createEntity(spec: RuntimeEntityCreateSpec): Promise<RuntimeEntityHandle>;
  reserveEntity(spec: RuntimeCodeEntityCreateSpec): Promise<RuntimeEntityHandle>;
  activateReservedEntity(spec: RuntimeCodeEntityCreateSpec): Promise<RuntimeEntityHandle>;
  retireEntity(id: string): Promise<void>;
}
