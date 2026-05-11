import { PanelRegistry } from "@natstack/shared/panelRegistry";
import { PanelManager } from "@natstack/shared/shell/panelManager";
import { PanelStoreRpc } from "@natstack/shared/shell/panelStoreRpc";
import type { MobileTransport } from "../services/mobileTransport";
import { parseHostConfig } from "../services/panelUrls";

export function createMobileShellCore(deps: {
  workspaceId: string;
  serverUrl: string;
  transport: MobileTransport;
  onTreeUpdated?: (tree: import("@natstack/shared/types").Panel[]) => void;
}) {
  const registry = new PanelRegistry({ onTreeUpdated: deps.onTreeUpdated });
  // Server-backed panel store via `panel-persistence` service (same backend
  // Electron uses). Mobile no longer keeps a device-local panel-tree cache,
  // so wiping the server's user-data directory now also wipes panel tree
  // state as the user expects.
  const store = new PanelStoreRpc((method, args) =>
    deps.transport.call("main", `panel-persistence.${method}`, ...args),
  );
  const host = parseHostConfig(deps.serverUrl);
  const hostWithPort = `${host.host}${host.port ? `:${host.port}` : ""}`;

  const panelManager = new PanelManager({
    store,
    registry,
    workspacePath: "",
    allowMissingManifests: true,
    serverInfo: {
      gatewayConfig: { serverUrl: `${host.protocol}://${hostWithPort}` },
    },
    tokenClient: {
      ensurePanelToken: (panelId, contextId, parentId) =>
        deps.transport.call("main", "tokens.ensurePanelToken", panelId, contextId, parentId) as Promise<{ token: string }>,
      revokePanelToken: (panelId) =>
        deps.transport.call("main", "tokens.revokePanelToken", panelId) as Promise<void>,
      updatePanelContext: (panelId, contextId) =>
        deps.transport.call("main", "tokens.updatePanelContext", panelId, contextId) as Promise<void>,
      updatePanelParent: (panelId, parentId) =>
        deps.transport.call("main", "tokens.updatePanelParent", panelId, parentId) as Promise<void>,
    },
  });

  return {
    registry,
    panelManager,
  };
}
