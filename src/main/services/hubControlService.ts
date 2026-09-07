import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler, mapServiceHandlers } from "@vibestudio/shared/serviceHandlers";
import {
  HubWorkspaceRouteSchema,
  hubControlMethods,
  type HubWorkspaceRoute,
  type HubWorkspaceEntry,
} from "@vibestudio/service-schemas/hubControl";
import type { ServerClient } from "../serverClient.js";
import type { ViewManager } from "../viewManager.js";
import { requireChromeAppCallerOrHost } from "./appCapabilities.js";

/**
 * Electron's trusted-shell view of the stable hub session. This is transport
 * composition, not a server deputy: the main process already owns both client
 * connections and sends only `hubControl.*` to the hub connection.
 */
export function createHubControlHostService(deps: {
  client: ServerClient;
  getViewManager: () => ViewManager;
  onWorkspaceRoute: (route: HubWorkspaceRoute) => void | Promise<void>;
  onWorkspaceCatalog?(entries: HubWorkspaceEntry[]): void | Promise<void>;
}): ServiceDefinition {
  let routeGeneration = 0;
  return {
    name: "hubControl",
    description: "Stable server-wide account and workspace control",
    authority: { principals: ["user", "host", "code"] },
    methods: hubControlMethods,
    handler: defineServiceHandler(
      "hubControl",
      hubControlMethods,
      mapServiceHandlers(hubControlMethods, async (method, ctx, args) => {
        requireChromeAppCallerOrHost(ctx, deps.getViewManager(), `hubControl.${method}`);
        const generation = method === "routeWorkspace" ? ++routeGeneration : null;
        const result = await deps.client.call("hubControl", method, args);
        if (method === "listWorkspaces")
          await deps.onWorkspaceCatalog?.(hubControlMethods.listWorkspaces.returns.parse(result));
        if (method === "routeWorkspace" && generation === routeGeneration) {
          await deps.onWorkspaceRoute(HubWorkspaceRouteSchema.parse(result));
        }
        return result;
      })
    ),
  };
}
