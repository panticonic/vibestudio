import { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import { createShellCore } from "@vibestudio/shell-core/createShellCore";
import type { PanelTreeSnapshot } from "@vibestudio/shared/types";
import type { MobileRpcClient } from "../services/mobileTransport";
import { parseHostConfig } from "../services/panelUrls";
import { createMobileLocalViewStateStore } from "./localViewState";

export function createMobileShellCore(deps: {
  workspaceId: string;
  serverUrl: string;
  transport: MobileRpcClient;
  onTreeUpdated?: (snapshot: PanelTreeSnapshot) => void;
}) {
  const registry = new PanelRegistry({
    onTreeUpdated: (snapshot: PanelTreeSnapshot) => deps.onTreeUpdated?.(snapshot),
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
