import type { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import type { PanelSearchIndex, PanelSearchResult } from "@vibestudio/shared/panelSearchTypes";
import type { EntityRecord, RuntimeEntityHandle } from "@vibestudio/shared/runtime/entitySpec";
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
 * Complete shell adapters for the workspace-state/runtime service contracts.
 * Every host uses these factories so adding a required PanelManager operation
 * cannot silently leave one platform with a partial structural lookalike.
 */
export function createWorkspaceStateClient(callService: ShellServiceCall): WorkspaceStateClient {
  const call = <T>(service: string, method: string, args: unknown[]) =>
    callService(service, method, args) as Promise<T>;
  return {
    listSlots: () => call<SlotRow[]>("workspace-state", "slot.list", []),
    getSlot: (slotId) => call<SlotRow | null>("workspace-state", "slot.get", [slotId]),
    getSlotHistory: (slotId) =>
      call<SlotHistoryRow[]>("workspace-state", "slot.history", [slotId]),
    resolveActiveEntity: (id) =>
      call<EntityRecord | null>("workspace-state", "entity.resolveActive", [id]),
    resolveEntity: (id) => call<EntityRecord | null>("workspace-state", "entity.resolve", [id]),
    resolveSlotByEntity: (entityId) =>
      call<string | null>("workspace-state", "slot.resolveByEntity", [entityId]),
    createSlot: (input) => call<void>("workspace-state", "slot.create", [input]),
    commitPreparedNavigation: (input) =>
      call("workspace-state", "slot.commitPreparedNavigation", [input]),
    updateCurrentStateArgs: (slotId, stateArgs) =>
      call<void>("workspace-state", "slot.updateCurrentStateArgs", [slotId, stateArgs]),
    setSlotParent: (slotId, parentSlotId) =>
      call<void>("workspace-state", "slot.setParent", [slotId, parentSlotId]),
    setSlotPosition: (slotId, positionId) =>
      call<void>("workspace-state", "slot.setPosition", [slotId, positionId]),
    moveSlot: (slotId, parentSlotId, positionId) =>
      call<void>("workspace-state", "slot.move", [slotId, parentSlotId, positionId]),
    closeSlot: (slotId) => call<void>("workspace-state", "slot.close", [slotId]),
  };
}

export function createRuntimeClient(callService: ShellServiceCall): RuntimeClient {
  const call = <T>(service: string, method: string, args: unknown[]) =>
    callService(service, method, args) as Promise<T>;
  return {
    createEntity: (spec) => call<RuntimeEntityHandle>("runtime", "createEntity", [spec]),
    reservePanelEntity: (spec) =>
      call<RuntimeEntityHandle>("runtime", "reservePanelEntity", [spec]),
    activatePanelEntity: (spec) =>
      call<RuntimeEntityHandle>("runtime", "activatePanelEntity", [spec]),
    retireEntity: (id) => call<void>("runtime", "retireEntity", [{ id }]),
  };
}

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

  const workspaceState = createWorkspaceStateClient(deps.call);
  const runtime = createRuntimeClient(deps.call);

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
