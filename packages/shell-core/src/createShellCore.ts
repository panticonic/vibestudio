import type { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import type { PanelSearchIndex, PanelSearchResult } from "@vibestudio/shared/panelSearchTypes";
import type {
  EntityRecord,
  RuntimeEntityHandle,
  RuntimeEntitySummary,
} from "@vibestudio/shared/runtime/entitySpec";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import {
  PanelManager,
  type LocalPanelViewStateStore,
  type PanelManagerServerInfo,
} from "./panelManager.js";
import type {
  RuntimeClient,
  SlotHistoryRow,
  SlotRow,
  WorkspaceStateClient,
} from "./workspaceStateClient.js";

export type ShellServiceCall = (
  service: string,
  method: string,
  args: unknown[]
) => Promise<unknown>;

/**
 * Platform-neutral shell core. Electron and mobile supply only their transport,
 * registry and local persistence adapters; panel/runtime/state wiring lives
 * here once.
 */
export function createShellCore(deps: {
  registry: PanelRegistry;
  call: ShellServiceCall;
  viewState: LocalPanelViewStateStore;
  serverInfo: PanelManagerServerInfo;
  workspacePath: string;
  workspaceConfig?: WorkspaceConfig;
  allowMissingManifests?: boolean;
}): { panelManager: PanelManager } {
  const call = <T>(service: string, method: string, args: unknown[]) =>
    deps.call(service, method, args) as Promise<T>;

  const workspaceState: WorkspaceStateClient = {
    listSlots: () => call<SlotRow[]>("workspace-state", "slot.list", []),
    getSlot: (slotId) => call<SlotRow | null>("workspace-state", "slot.get", [slotId]),
    getSlotHistory: (slotId) => call<SlotHistoryRow[]>("workspace-state", "slot.history", [slotId]),
    resolveActiveEntity: (id) =>
      call<EntityRecord | null>("workspace-state", "entity.resolveActive", [id]),
    resolveSlotByEntity: (entityId) =>
      call<string | null>("workspace-state", "slot.resolveByEntity", [entityId]),
    createSlot: (input) => call<void>("workspace-state", "slot.create", [input]),
    appendSlotHistory: (slotId, entry) =>
      call<number>("workspace-state", "slot.appendHistory", [slotId, entry]),
    setSlotCurrent: (slotId, entryKey) =>
      call<void>("workspace-state", "slot.setCurrent", [slotId, entryKey]),
    updateCurrentStateArgs: (slotId, stateArgs) =>
      call<void>("workspace-state", "slot.updateCurrentStateArgs", [slotId, stateArgs]),
    replaceSlotHistory: (slotId, entries, cursor) =>
      call<void>("workspace-state", "slot.replaceHistory", [slotId, entries, cursor]),
    setSlotParent: (slotId, parentSlotId) =>
      call<void>("workspace-state", "slot.setParent", [slotId, parentSlotId]),
    setSlotPosition: (slotId, positionId) =>
      call<void>("workspace-state", "slot.setPosition", [slotId, positionId]),
    moveSlot: (slotId, parentSlotId, positionId) =>
      call<void>("workspace-state", "slot.move", [slotId, parentSlotId, positionId]),
    closeSlot: (slotId) => call<void>("workspace-state", "slot.close", [slotId]),
  };

  const runtime: RuntimeClient = {
    createEntity: (spec) => call<RuntimeEntityHandle>("runtime", "createEntity", [spec]),
    listEntities: (kind) =>
      call<RuntimeEntitySummary[]>("runtime", "listEntities", [kind ? { kind } : undefined]),
    retireEntity: (id) => call<void>("runtime", "retireEntity", [{ id }]),
  };

  const searchIndex: PanelSearchIndex = {
    indexPanel: (panel) => call<void>("workspace-state", "panel.index", [panel]),
    search: (query, limit) =>
      call<PanelSearchResult[]>("workspace-state", "panel.search", [query, limit]),
    incrementAccessCount: (panelId) =>
      call<void>("workspace-state", "panel.incrementAccess", [panelId]),
    updateTitle: (panelId, title) =>
      call<void>("workspace-state", "panel.updateTitle", [panelId, title]),
    rebuildIndex: () => call<void>("workspace-state", "panel.rebuildIndex", []),
  };

  return {
    panelManager: new PanelManager({
      registry: deps.registry,
      workspaceState,
      runtime,
      searchIndex,
      activationClient: {
        markPanelActive: (panelId) => call<void>("presence", "markPanelActive", [panelId]),
      },
      viewState: deps.viewState,
      metadataResolver: {
        getPanelMetadata: (source) =>
          call<{ title?: string } | null>("build", "getPanelMetadata", [source]),
      },
      workspacePath: deps.workspacePath,
      allowMissingManifests: deps.allowMissingManifests,
      workspaceConfig: deps.workspaceConfig,
      serverInfo: deps.serverInfo,
      grantConnection: (panelId) => call<{ token: string }>("auth", "grantConnection", [panelId]),
    }),
  };
}
