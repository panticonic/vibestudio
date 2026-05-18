import type { PanelRegistry } from "@natstack/shared/panelRegistry";
import { PanelManager } from "@natstack/shared/shell/panelManager";
import type { ServerClient } from "../serverClient.js";
import type {
  AppendPanelOpsResult,
  PanelOpsSinceResult,
  PanelSnapshotResult,
  SubmittedPanelOp,
} from "@natstack/shared/panelOpsTypes";
import { createElectronLocalViewStateStore } from "./localViewState.js";

export function createElectronShellCore(deps: {
  statePath: string;
  workspaceId: string;
  workspacePath: string;
  allowMissingManifests?: boolean;
  registry: PanelRegistry;
  serverClient: ServerClient;
  gatewayConfig: { serverUrl: string };
  workspaceConfig?: import("@natstack/shared/workspace/types").WorkspaceConfig;
}) {
  const panelManager = new PanelManager({
    registry: deps.registry,
    workspaceSync: {
      getSnapshot: () =>
        deps.serverClient.call("workspace-sync", "getSnapshot", []) as Promise<PanelSnapshotResult>,
      getOpsSince: (baseRevision) =>
        deps.serverClient.call("workspace-sync", "getOpsSince", [
          baseRevision,
        ]) as Promise<PanelOpsSinceResult>,
      submitOps: (baseRevision, ops: SubmittedPanelOp[]) =>
        deps.serverClient.call("workspace-sync", "submitOps", [
          baseRevision,
          ops,
        ]) as Promise<AppendPanelOpsResult>,
    },
    activationClient: {
      markPanelActive: (panelId) =>
        deps.serverClient.call("presence", "markPanelActive", [panelId]) as Promise<void>,
    },
    viewState: createElectronLocalViewStateStore(deps.statePath),
    workspacePath: deps.workspacePath,
    allowMissingManifests: deps.allowMissingManifests,
    searchIndex: null,
    workspaceConfig: deps.workspaceConfig,
    serverInfo: {
      gatewayConfig: deps.gatewayConfig,
    },
    identityClient: {
      register: (panelId, contextId, parentId, source) =>
        deps.serverClient.call("principals", "register", [
          panelId,
          "panel",
          { contextId, parentId, source },
        ]) as Promise<void>,
      unregister: (panelId) =>
        deps.serverClient.call("principals", "unregister", [panelId]) as Promise<void>,
      bindContext: (panelId, contextId) =>
        deps.serverClient.call("principals", "bindContext", [panelId, contextId]) as Promise<void>,
      setParent: (panelId, parentId) =>
        deps.serverClient.call("principals", "setParent", [panelId, parentId]) as Promise<void>,
      grantConnection: (panelId) =>
        deps.serverClient.call("auth", "grantConnection", [panelId]) as Promise<{ token: string }>,
    },
  });

  return {
    panelManager,
    shutdown: () => {},
  };
}
