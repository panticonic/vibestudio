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
  WorkspacePanelDetail,
  WorkspacePanelCloseCleanupPage,
  WorkspacePanelCloseCleanupPageInput,
  WorkspacePanelCloseResult,
  WorkspacePanelTreeHistoryRow,
  WorkspacePanelTreePage,
  WorkspacePanelTreePageInput,
  WorkspacePanelTreePath,
  WorkspacePanelTreePlacement,
  WorkspacePanelTreeRootGroupPage,
  WorkspacePanelTreeRootGroupPageInput,
  WorkspacePanelTreeSearchInput,
  WorkspacePanelTreeSearchPage,
  WorkspacePanelTreeSlot,
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
  placement?: WorkspacePanelTreePlacement;
  initialEntry?: SlotHistoryEntryInput;
}

export type SlotRow = WorkspacePanelTreeSlot;
export type SlotHistoryRow = WorkspacePanelTreeHistoryRow;

/**
 * Client surface mirroring the `workspace-state` server service.
 * Tree reads are bounded queries. No method on this surface reconstructs the
 * complete panel forest or a slot's complete navigation history.
 */
export interface WorkspaceStateClient {
  getPanelTreeRootGroups(
    input: WorkspacePanelTreeRootGroupPageInput
  ): Promise<WorkspacePanelTreeRootGroupPage>;
  getPanelTreePage(input: WorkspacePanelTreePageInput): Promise<WorkspacePanelTreePage>;
  getPanelTreePath(slotId: PanelSlotId): Promise<WorkspacePanelTreePath | null>;
  getPanelDetail(slotId: PanelSlotId): Promise<WorkspacePanelDetail | null>;
  searchPanelTree(input: WorkspacePanelTreeSearchInput): Promise<WorkspacePanelTreeSearchPage>;
  getSlot(slotId: PanelSlotId): Promise<SlotRow | null>;
  getRelativeSlotHistory(slotId: PanelSlotId, delta: -1 | 1): Promise<SlotHistoryRow | null>;
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
  moveSlot(
    slotId: PanelSlotId,
    parentSlotId: PanelSlotId | null,
    placement?: WorkspacePanelTreePlacement
  ): Promise<void>;
  closeSlot(slotId: PanelSlotId): Promise<WorkspacePanelCloseResult>;
  getCloseCleanupPage(
    input: WorkspacePanelCloseCleanupPageInput
  ): Promise<WorkspacePanelCloseCleanupPage>;
  acknowledgeCloseCleanup(slotIds: PanelSlotId[]): Promise<void>;
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
