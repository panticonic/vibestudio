import { PanelRegistry } from "@natstack/shared/panelRegistry";
import { PanelManager } from "@natstack/shared/shell/panelManager";
import type { MobileTransport } from "../services/mobileTransport";
import { parseHostConfig } from "../services/panelUrls";
import type {
  AppendPanelOpsResult,
  PanelOpsSinceResult,
  PanelSnapshotResult,
  SubmittedPanelOp,
} from "@natstack/shared/panelOpsTypes";
import { createMobileLocalViewStateStore } from "./localViewState";

export function createMobileShellCore(deps: {
  workspaceId: string;
  serverUrl: string;
  transport: MobileTransport;
  onTreeUpdated?: (tree: import("@natstack/shared/types").Panel[]) => void;
}) {
  const registry = new PanelRegistry({ onTreeUpdated: deps.onTreeUpdated });
  const host = parseHostConfig(deps.serverUrl);
  const hostWithPort = `${host.host}${host.port ? `:${host.port}` : ""}`;

  const panelManager = new PanelManager({
    registry,
    workspaceSync: {
      getSnapshot: () =>
        deps.transport.call(
          "main",
          "workspace-sync.getSnapshot",
          []
        ) as Promise<PanelSnapshotResult>,
      getOpsSince: (baseRevision) =>
        deps.transport.call("main", "workspace-sync.getOpsSince", [
          baseRevision,
        ]) as Promise<PanelOpsSinceResult>,
      submitOps: (baseRevision, ops: SubmittedPanelOp[]) =>
        deps.transport.call("main", "workspace-sync.submitOps", [
          baseRevision,
          ops,
        ]) as Promise<AppendPanelOpsResult>,
    },
    activationClient: {
      markPanelActive: (panelId) =>
        deps.transport.call("main", "presence.markPanelActive", [panelId]) as Promise<void>,
    },
    viewState: createMobileLocalViewStateStore(deps.workspaceId),
    workspacePath: "",
    allowMissingManifests: true,
    serverInfo: {
      gatewayConfig: { serverUrl: `${host.protocol}://${hostWithPort}` },
    },
    identityClient: {
      register: (panelId, contextId, parentId, source) =>
        deps.transport.call("main", "principals.register", [
          panelId,
          "panel",
          { contextId, parentId, source },
        ]) as Promise<void>,
      unregister: (panelId) =>
        deps.transport.call("main", "principals.unregister", [panelId]) as Promise<void>,
      bindContext: (panelId, contextId) =>
        deps.transport.call("main", "principals.bindContext", [
          panelId,
          contextId,
        ]) as Promise<void>,
      setParent: (panelId, parentId) =>
        deps.transport.call("main", "principals.setParent", [panelId, parentId]) as Promise<void>,
      grantConnection: (panelId) =>
        deps.transport.call("main", "auth.grantConnection", [panelId]) as Promise<{
          token: string;
        }>,
    },
  });

  return {
    registry,
    panelManager,
  };
}
