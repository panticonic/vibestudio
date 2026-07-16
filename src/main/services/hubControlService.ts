import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler, mapServiceHandlers } from "@vibestudio/shared/serviceHandlers";
import {
  HubWorkspaceRouteSchema,
  hubControlMethods,
  type HubWorkspaceRoute,
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
  onWorkspaceRoute: (route: HubWorkspaceRoute) => void;
}): ServiceDefinition {
  return {
    name: "hubControl",
    description: "Stable server-wide account and workspace control",
    policy: { allowed: ["shell", "app"] },
    methods: hubControlMethods,
    handler: defineServiceHandler(
      "hubControl",
      hubControlMethods,
      mapServiceHandlers(hubControlMethods, async (method, ctx, args) => {
        requireChromeAppCallerOrHost(ctx, deps.getViewManager(), `hubControl.${method}`);
        const result = await deps.client.call("hubControl", method, args);
        if (method === "routeWorkspace") {
          deps.onWorkspaceRoute(HubWorkspaceRouteSchema.parse(result));
        }
        return result;
      })
    ),
  };
}
