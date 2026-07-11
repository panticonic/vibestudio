import {
  HubWorkspaceEntrySchema,
  HubWorkspaceRouteSchema,
  hubControlMethods,
} from "@vibestudio/shared/serviceSchemas/hubControl";
import {
  createTypedServiceClient,
  type TypedServiceClient,
} from "@vibestudio/shared/typedServiceClient";
import type { WebRtcConnection } from "./connect.js";

const mobileHubControlMethods = {
  listWorkspaces: hubControlMethods.listWorkspaces,
  routeWorkspace: hubControlMethods.routeWorkspace,
} as const;

export type MobileHubControlClient = TypedServiceClient<typeof mobileHubControlMethods>;
export type MobileHubWorkspace = ReturnType<typeof HubWorkspaceEntrySchema.parse>;
export type MobileHubWorkspaceRoute = ReturnType<typeof HubWorkspaceRouteSchema.parse>;

/**
 * Bind the shared schema-derived hub-control surface to a mobile WebRTC
 * connection. Both arguments and results are parsed at the client boundary so
 * malformed current-server responses never reach selection/persistence code.
 */
export function createMobileHubControlClient(
  connection: Pick<WebRtcConnection, "rpc">
): MobileHubControlClient {
  return createTypedServiceClient(
    "hubControl",
    mobileHubControlMethods,
    async (_service, method, args) => {
      const definition = mobileHubControlMethods[method as keyof typeof mobileHubControlMethods];
      if (!definition) throw new Error(`Unknown mobile hub-control method: ${method}`);
      const parsedArgs = definition.args.parse(args);
      const result = await connection.rpc.call("main", `hubControl.${method}`, parsedArgs);
      return definition.returns.parse(result);
    }
  );
}
