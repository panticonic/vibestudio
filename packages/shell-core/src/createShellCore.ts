import type { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import {
  PanelManager,
  type LocalPanelViewStateStore,
  type PanelManagerServerInfo,
} from "./panelManager.js";
import type { ShellServiceCall } from "./workspaceStateClient.js";
import {
  createQuickfireCleanupClient,
  createRuntimeClient,
  createWorkspaceStateClient,
} from "./workspaceStateClient.js";
import type { WorkspaceStateClient } from "./workspaceStateClient.js";

export {
  createQuickfireCleanupClient,
  createRuntimeClient,
  createWorkspaceStateClient,
  type ShellServiceCall,
} from "./workspaceStateClient.js";

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
  const call = <T>(service: string, method: string, args: unknown[]) =>
    deps.call(service, method, args) as Promise<T>;

  const workspaceState = deps.workspaceState ?? createWorkspaceStateClient(deps.call);
  const runtime = createRuntimeClient(deps.call);

  return {
    panelManager: new PanelManager({
      registry: deps.registry,
      workspaceState,
      runtime,
      quickfire: createQuickfireCleanupClient(deps.call),
      activationClient: {
        markPanelActive: (panelId) => call<void>("presence", "markPanelActive", [panelId]),
      },
      viewState: deps.viewState,
      workspacePath: deps.workspacePath,
      allowMissingManifests: deps.allowMissingManifests,
      workspaceConfig: deps.workspaceConfig,
      serverInfo: deps.serverInfo,
      grantConnection: (panelId) => call<{ token: string }>("auth", "grantConnection", [panelId]),
    }),
  };
}
