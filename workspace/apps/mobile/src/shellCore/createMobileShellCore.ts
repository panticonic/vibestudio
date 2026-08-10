import { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import { createShellCore } from "@vibestudio/shell-core/createShellCore";
import type { MobileRpcClient } from "../services/mobileTransport";
import { parseHostConfig } from "../services/panelUrls";
import { createMobileLocalViewStateStore } from "./localViewState";

export function createMobileShellCore(deps: {
  workspaceId: string;
  serverUrl: string;
  transport: MobileRpcClient;
  onPresentationUpdated?: (update: { revision: number; panelIds: string[] }) => void;
}) {
  const registry = new PanelRegistry({
    onPresentationUpdated: deps.onPresentationUpdated,
  });
  const host = parseHostConfig(deps.serverUrl);
  const hostWithPort = `${host.host}${host.port ? `:${host.port}` : ""}`;
  const serverUrl = `${host.protocol}://${hostWithPort}${host.basePath}`;

  const { panelManager } = createShellCore({
    registry,
    call: (service, method, args) => deps.transport.call("main", `${service}.${method}`, args),
    viewState: createMobileLocalViewStateStore(deps.workspaceId),
    workspacePath: "",
    allowMissingManifests: true,
    serverInfo: {
      gatewayConfig: { serverUrl, workspace: deps.workspaceId },
    },
  });

  return {
    registry,
    panelManager,
  };
}
