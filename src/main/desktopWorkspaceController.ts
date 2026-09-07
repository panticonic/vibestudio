import { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import type { EventService } from "@vibestudio/shared/eventsService";
import { PanelOrchestrator } from "./panelOrchestrator.js";
import { createElectronShellCore } from "./shellCore/createElectronShellCore.js";
import type { WorkspaceSessionConnection } from "./serverSession.js";

type PresentationDependencies = Omit<
  ConstructorParameters<typeof PanelOrchestrator>[0],
  | "registry"
  | "eventService"
  | "serverClient"
  | "shellCore"
  | "panelHttpServer"
  | "externalHost"
  | "protocol"
  | "gatewayPort"
  | "gatewayBasePath"
  | "workspaceConfig"
>;

/**
 * Workspace-owned runtime state beneath the single desktop window. Every
 * callback in presentation belongs to this connection; selecting another tree
 * never reassigns the registry, core client, leases or operation queues.
 */
export function createDesktopWorkspaceController(deps: {
  connection: WorkspaceSessionConnection;
  eventService: EventService;
  presentation: PresentationDependencies;
}) {
  const connection = deps.connection;
  const registry = new PanelRegistry({
    workspaceId: connection.workspaceId,
    onPresentationUpdated: (payload) =>
      deps.eventService.emit("panel-presentation-changed", payload),
  });
  const core = createElectronShellCore({
    workspaceId: connection.workspaceId,
    workspacePath: connection.workspacePath,
    allowMissingManifests: connection.connectionMode === "remote",
    registry,
    serverClient: connection.serverClient,
    gatewayConfig: connection.gatewayConfig,
    workspaceConfig: connection.workspaceConfig,
  });
  const pathname = new URL(connection.gatewayConfig.serverUrl).pathname.replace(/\/+$/, "");
  const orchestrator = new PanelOrchestrator({
    ...deps.presentation,
    registry,
    eventService: deps.eventService,
    serverClient: connection.serverClient,
    shellCore: core.panelManager,
    panelHttpServer: connection.panelHttpServer,
    externalHost: connection.externalHost,
    protocol: connection.protocol,
    gatewayPort: connection.gatewayPort,
    gatewayBasePath: pathname === "/" ? "" : pathname,
    workspaceConfig: connection.workspaceConfig,
  });
  return {
    workspaceId: connection.workspaceId,
    connection,
    registry,
    core,
    orchestrator,
    eventService: deps.eventService,
  };
}

export type DesktopWorkspaceController = ReturnType<typeof createDesktopWorkspaceController>;
