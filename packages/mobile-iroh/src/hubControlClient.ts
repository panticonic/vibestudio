import { createTypedRpcServiceClient } from "@vibestudio/shared/typedRpcServiceClient";
import {
  HubWorkspaceEntrySchema,
  HubWorkspaceRouteSchema,
  hubControlMethods,
} from "@vibestudio/service-schemas/hubControl";
import { type TypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import type { IrohConnection } from "./connect.js";

const mobileHubControlMethods = {
  ensureUserWorkspaces: hubControlMethods.ensureUserWorkspaces,
  listWorkspaces: hubControlMethods.listWorkspaces,
  routeWorkspace: hubControlMethods.routeWorkspace,
} as const;

export type MobileHubControlClient = TypedServiceClient<typeof mobileHubControlMethods>;
export type MobileHubWorkspace = ReturnType<typeof HubWorkspaceEntrySchema.parse>;
export type MobileHubWorkspaceRoute = ReturnType<typeof HubWorkspaceRouteSchema.parse>;

/**
 * Bind the shared schema-derived hub-control surface to a mobile Iroh
 * connection. Both arguments and results are parsed at the client boundary so
 * malformed current-server responses never reach selection/persistence code.
 */
export function createMobileHubControlClient(
  connection: Pick<IrohConnection, "rpc">
): MobileHubControlClient {
  return createTypedRpcServiceClient(
    connection.rpc,
    { targetId: "main", namespace: "hubControl" },
    mobileHubControlMethods
  );
}
