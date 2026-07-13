import type { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import { createShellCore } from "@vibestudio/shell-core/createShellCore";
import type { ServerClient } from "../serverClient.js";
import { createElectronLocalViewStateStore } from "./localViewState.js";

export function createElectronShellCore(deps: {
  statePath: string;
  workspaceId: string;
  workspacePath: string;
  allowMissingManifests?: boolean;
  registry: PanelRegistry;
  serverClient: ServerClient;
  gatewayConfig: { serverUrl: string };
  workspaceConfig?: import("@vibestudio/workspace-contracts/types").WorkspaceConfig;
}) {
  const { panelManager } = createShellCore({
    registry: deps.registry,
    call: (service, method, args) => deps.serverClient.call(service, method, args),
    viewState: createElectronLocalViewStateStore(deps.statePath),
    workspacePath: deps.workspacePath,
    allowMissingManifests: deps.allowMissingManifests,
    workspaceConfig: deps.workspaceConfig,
    serverInfo: {
      gatewayConfig: deps.gatewayConfig,
    },
  });

  return {
    panelManager,
    shutdown: () => {},
  };
}
