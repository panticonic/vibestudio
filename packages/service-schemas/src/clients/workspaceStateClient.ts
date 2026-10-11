import { JsonObjectSchema } from "@vibestudio/shared/wireValues";
import { callTypedServiceMethod, type MethodFn } from "@vibestudio/shared/typedServiceClient";
import type { WorkspaceStateClient } from "@vibestudio/shell-core/workspaceStateClient";
import type { ShellServiceCall } from "@vibestudio/shell-core/workspaceStateClient";
import { workspaceStateMethods } from "../workspaceState.js";

export type { ShellServiceCall } from "@vibestudio/shell-core/workspaceStateClient";

/** Canonical schema-validated workspace-state client, without shell assembly imports. */
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
