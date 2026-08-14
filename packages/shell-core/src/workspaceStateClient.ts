/**
 * Shell-facing client surfaces for the server-side `workspace-state` and
 * `runtime` services.
 *
 * These describe what the shell (Electron main / mobile main) sends over RPC.
 * This module also owns their tiny transport adapters. Keeping those adapters
 * here lets panel runtimes use the client without importing the full shell
 * assembly and PanelManager implementation.
 */

import type {
  EntityRecord,
  RuntimeCodeEntityCreateSpec,
  RuntimeEntityCreateSpec,
  RuntimeEntityHandle,
} from "@vibestudio/shared/runtime/entitySpec";
import type { PanelEntityId, PanelSlotId } from "@vibestudio/shared/panel/idValues";
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

/**
 * Host-side executor for the quickfire archival the workspace DO only records.
 * Optional on purpose: a shell without it still closes panels correctly, it
 * just leaves the queued rows for the next drain that does have it.
 */
export interface QuickfireCleanupClient {
  drainCleanup(input?: { closeId?: string }): Promise<{ archived: number; failed: number }>;
}

export function createQuickfireCleanupClient(
  callService: ShellServiceCall
): QuickfireCleanupClient {
  return {
    drainCleanup: (input) =>
      callService("quickfire", "drainCleanup", input ? [input] : []) as Promise<{
        archived: number;
        failed: number;
      }>,
  };
}

export type ShellServiceCall = (
  service: string,
  method: string,
  args: unknown[]
) => Promise<unknown>;

export function createWorkspaceStateClient(callService: ShellServiceCall): WorkspaceStateClient {
  const call = <T>(method: string, args: unknown[]) =>
    callService("workspace-state", method, args) as Promise<T>;
  return {
    getPanelTreeRootGroups: (input) => call("panelTree.rootGroups", [input]),
    getPanelTreePage: (input) => call("panelTree.page", [input]),
    getPanelTreePath: (slotId) => call("panelTree.path", [slotId]),
    getPanelDetail: (slotId) => call("panelTree.detail", [slotId]),
    getSlot: (slotId) => call("slot.get", [slotId]),
    getRelativeSlotHistory: (slotId, delta) => call("slot.historyRelative", [slotId, delta]),
    resolveActiveEntity: (id) => call("entity.resolveActive", [id]),
    resolveEntity: (id) => call("entity.resolve", [id]),
    resolveSlotByEntity: (entityId) => call("slot.resolveByEntity", [entityId]),
    createSlot: (input) => call("slot.create", [input]),
    commitPreparedNavigation: (input) => call("slot.commitPreparedNavigation", [input]),
    updateCurrentStateArgs: (slotId, stateArgs) =>
      call("slot.updateCurrentStateArgs", [slotId, stateArgs]),
    moveSlot: (slotId, parentSlotId, placement) =>
      call("slot.move", [slotId, parentSlotId, placement]),
    closeSlot: (slotId) => call("slot.close", [slotId]),
    getCloseCleanupPage: (input) => call("slot.closeCleanupPage", [input]),
    acknowledgeCloseCleanup: (slotIds) => call("slot.closeCleanupAck", [slotIds]),
  };
}

export function createRuntimeClient(callService: ShellServiceCall): RuntimeClient {
  const call = <T>(method: string, args: unknown[]) =>
    callService("runtime", method, args) as Promise<T>;
  return {
    createEntity: (spec) => call("createEntity", [spec]),
    reserveEntity: (spec) => call("reserveEntity", [spec]),
    activateReservedEntity: (spec) => call("activateReservedEntity", [spec]),
    retireEntity: (id) => call("retireEntity", [{ id }]),
  };
}
