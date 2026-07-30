import type { RpcClient } from "@vibestudio/rpc";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { viewMethods } from "../view.js";
import { workspaceStateMethods } from "../workspaceState.js";

/** Typed panel-shell reads and native presentation effects shared by host implementations. */
export class PanelShellClient {
  private workspaceState: ReturnType<typeof createWorkspaceStateClient>;
  private view: ReturnType<typeof createViewClient>;

  constructor(rpc: Pick<RpcClient, "call">) {
    const callMain = (service: string, method: string, args: unknown[]) =>
      rpc.call("main", `${service}.${method}`, args);
    this.workspaceState = createWorkspaceStateClient(callMain);
    this.view = createViewClient(callMain);
  }

  getPanelDetail(slotId: string) {
    return this.workspaceState.panelTree.detail(slotId);
  }

  focusPanel(panelId: string) {
    return this.view.focusPanel(panelId, {});
  }
}

type MainCall = (service: string, method: string, args: unknown[]) => Promise<unknown>;
const createWorkspaceStateClient = (call: MainCall) =>
  createTypedServiceClient("workspace-state", workspaceStateMethods, call);
const createViewClient = (call: MainCall) => createTypedServiceClient("view", viewMethods, call);
