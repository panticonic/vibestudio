import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { createHostCaller, type ServiceDispatcher } from "@vibestudio/shared/serviceDispatcher";
import type { ServerClient } from "./serverClient.js";

/**
 * Publish one explicitly host-owned Electron service through the desktop's
 * authenticated shell connection. ServerClient rejects direct workspace
 * callers before this trusted host identity is constructed.
 */
export function publishHostService(
  serverClient: Pick<ServerClient, "exposeHostMethod">,
  dispatcher: ServiceDispatcher,
  definition: ServiceDefinition
): void {
  if (!definition.authority?.principals.includes("host")) {
    throw new Error(
      `Cannot publish non-host service "${definition.name}" as a desktop host service`
    );
  }

  for (const method of Object.keys(definition.methods)) {
    serverClient.exposeHostMethod(`${definition.name}.${method}`, ({ args, signal }) =>
      dispatcher.dispatch(
        {
          caller: createHostCaller(`host:${definition.name}`, "shell"),
          signal,
        },
        definition.name,
        method,
        args
      )
    );
  }
}
