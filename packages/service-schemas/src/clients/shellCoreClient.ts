import { JsonObjectSchema } from "@vibestudio/shared/wireValues";
import type { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import {
  PanelManager,
  type LocalPanelViewStateStore,
  type PanelManagerServerInfo,
} from "@vibestudio/shell-core/panelManager";
import type { ShellServiceCall } from "@vibestudio/shell-core/workspaceStateClient";
export type { ShellServiceCall } from "@vibestudio/shell-core/workspaceStateClient";
import type { WorkspaceStateClient } from "@vibestudio/shell-core/workspaceStateClient";
import type {
  RuntimeClient,
  PanelMetadataClient,
} from "@vibestudio/shell-core/workspaceStateClient";
import { callTypedServiceMethod, type MethodFn } from "@vibestudio/shared/typedServiceClient";
import { workspaceStateMethods } from "../workspaceState.js";
import { runtimeMethods } from "../runtime.js";
import { buildMethods } from "../build.js";
import { presenceMethods } from "../presence.js";
import { authMethods } from "../auth.js";

export function createWorkspaceStateClient(callService: ShellServiceCall): WorkspaceStateClient {
  const call = <K extends keyof typeof workspaceStateMethods & string>(
    method: K,
    args: Parameters<MethodFn<(typeof workspaceStateMethods)[K]>>
  ) => callTypedServiceMethod("workspace-state", workspaceStateMethods, callService, method, args);
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
    patchCurrentStateArgs: (slotId, patch) =>
      call("slot.patchCurrentStateArgs", [slotId, JsonObjectSchema.parse(patch)]),
    moveSlot: (slotId, parentSlotId, placement) =>
      call("slot.move", [slotId, parentSlotId, placement]),
    closeSlot: (slotId) => call("slot.close", [slotId]),
    getCloseCleanupPage: (input) => call("slot.closeCleanupPage", [input]),
    acknowledgeCloseCleanup: (slotIds) => call("slot.closeCleanupAck", [slotIds]),
  };
}

export function createRuntimeClient(callService: ShellServiceCall): RuntimeClient {
  const call = <K extends keyof typeof runtimeMethods & string>(
    method: K,
    args: Parameters<MethodFn<(typeof runtimeMethods)[K]>>
  ) => callTypedServiceMethod("runtime", runtimeMethods, callService, method, args);
  return {
    createEntity: (spec) => call("createEntity", [spec]),
    createContext: (input) => call("createContext", [input]),
    reserveEntity: (spec) => call("reserveEntity", [spec]),
    activateReservedEntity: (spec) => call("activateReservedEntity", [spec]),
    retireEntity: (id) => call("retireEntity", [{ id }]),
  };
}

export function createPanelMetadataClient(callService: ShellServiceCall): PanelMetadataClient {
  return {
    getPanelMetadata: (source, ref) =>
      callTypedServiceMethod("build", buildMethods, callService, "getPanelMetadata", [source, ref]),
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
  viewState?: LocalPanelViewStateStore;
  serverInfo: PanelManagerServerInfo;
  workspacePath: string;
  workspaceConfig?: WorkspaceConfig;
  allowMissingManifests?: boolean;
  /** Optional Base composition of raw topology with workspace.presentation facts. */
  workspaceState?: WorkspaceStateClient;
}): { panelManager: PanelManager } {
  const workspaceState = deps.workspaceState ?? createWorkspaceStateClient(deps.call);
  const runtime = createRuntimeClient(deps.call);

  return {
    panelManager: new PanelManager({
      registry: deps.registry,
      workspaceState,
      runtime,
      panelMetadata: createPanelMetadataClient(deps.call),
      activationClient: {
        markPanelActive: async (panelId) => {
          await callTypedServiceMethod("presence", presenceMethods, deps.call, "markPanelActive", [
            panelId,
          ]);
        },
      },
      viewState: deps.viewState,
      workspacePath: deps.workspacePath,
      allowMissingManifests: deps.allowMissingManifests,
      workspaceConfig: deps.workspaceConfig,
      serverInfo: deps.serverInfo,
      grantConnection: (panelId) =>
        callTypedServiceMethod("auth", authMethods, deps.call, "grantConnection", [panelId]),
    }),
  };
}
