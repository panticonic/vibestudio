import { createTypedRpcServiceClient } from "@vibestudio/shared/typedRpcServiceClient";
import type { RpcClient } from "@vibestudio/rpc";
import { viewMethods } from "../view.js";
import { workspaceStateMethods } from "../workspaceState.js";

/** Typed panel-shell reads and native presentation effects shared by host implementations. */
export class PanelShellClient {
  private workspaceState: ReturnType<typeof createWorkspaceStateClient>;
  private view: ReturnType<typeof createViewClient>;

  constructor(rpc: Pick<RpcClient, "call">) {
    this.workspaceState = createWorkspaceStateClient(rpc);
    this.view = createViewClient(rpc);
  }

  getPanelDetail(slotId: string) {
    return this.workspaceState.panelTree.detail(slotId);
  }

  focusPanel(panelId: string) {
    return this.view.focusPanel(panelId, {});
  }
}

type MainRpc = Pick<RpcClient, "call">;
const createWorkspaceStateClient = (rpc: MainRpc) =>
  createTypedRpcServiceClient(
    rpc,
    { targetId: "main", namespace: "workspace-state" },
    workspaceStateMethods
  );
const createViewClient = (rpc: MainRpc) =>
  createTypedRpcServiceClient(rpc, { targetId: "main", namespace: "view" }, viewMethods);
