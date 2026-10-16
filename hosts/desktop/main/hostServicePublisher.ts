import { StreamResponseSchema } from "@vibestudio/shared/streamResponse";
import type { HostServiceHandler } from "./serverClient.js";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { createHostCaller, type ServiceDispatcher } from "@vibestudio/shared/serviceDispatcher";
import type { ServerClient } from "./serverClient.js";

/**
 * Publish one explicitly host-owned Electron service through the desktop's
 * authenticated shell connection. ServerClient rejects direct workspace
 * callers before this trusted host identity is constructed.
 */
export function publishHostService(
  serverClient: Pick<ServerClient, "exposeHostMethod" | "exposeHostStream">,
  dispatcher: ServiceDispatcher,
  definition: ServiceDefinition
): void {
  if (!definition.authority?.principals.includes("host")) {
    throw new Error(
      `Cannot publish non-host service "${definition.name}" as a desktop host service`
    );
  }

  for (const [method, schema] of Object.entries(definition.methods)) {
    const dispatch: HostServiceHandler = ({ args, signal }) =>
      dispatcher.dispatch(
        {
          caller: createHostCaller(`host:${definition.name}`, "shell"),
          signal,
        },
        definition.name,
        method,
        args
      );
    if (schema.returns === StreamResponseSchema) {
      serverClient.exposeHostStream(`${definition.name}.${method}`, async (request) =>
        StreamResponseSchema.parse(await dispatch(request))
      );
    } else {
      serverClient.exposeHostMethod(`${definition.name}.${method}`, dispatch);
    }
  }
}
