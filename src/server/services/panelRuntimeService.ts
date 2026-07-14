import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { panelRuntimeMethods } from "@vibestudio/service-schemas/panelRuntime";
import type { PanelRuntimeCoordinator } from "../panelRuntimeCoordinator.js";

export function createPanelRuntimeService(deps: {
  coordinator: PanelRuntimeCoordinator;
}): ServiceDefinition {
  const assertOwnsClientSession = (callerId: string, clientSessionId: string) => {
    if (deps.coordinator.ownsClientSession(clientSessionId, callerId)) return;
    const error = new Error(
      `Panel runtime client session ${clientSessionId} is not owned by ${callerId}`
    ) as Error & { code?: string };
    error.code = "PANEL_RUNTIME_CLIENT_FORBIDDEN";
    throw error;
  };
  return {
    name: "panelRuntime",
    description: "Panel runtime lease coordination",
    authority: {
      principals: ["user", "host"],
      description: "Authenticated clients and the product host control runtime leases",
    },
    methods: panelRuntimeMethods,
    handler: defineServiceHandler("panelRuntime", panelRuntimeMethods, {
      registerClient: (ctx, [client]) => {
        deps.coordinator.registerClient({
          ...client,
          ownerCallerId: ctx.caller.runtime.id,
        });
        return undefined;
      },
      unregisterClient: (ctx, [clientSessionId]) => {
        assertOwnsClientSession(ctx.caller.runtime.id, clientSessionId);
        deps.coordinator.unregisterClient(clientSessionId);
        return undefined;
      },
      getSnapshot: () => deps.coordinator.getSnapshot(),
      acquire: (ctx, [panelId, request]) => {
        assertOwnsClientSession(ctx.caller.runtime.id, request.clientSessionId);
        return deps.coordinator.acquire(panelId, request);
      },
      takeOver: (ctx, [panelId, request]) => {
        assertOwnsClientSession(ctx.caller.runtime.id, request.clientSessionId);
        return deps.coordinator.takeOver(panelId, request);
      },
      release: (ctx, [panelId, connectionId]) => {
        const lease = deps.coordinator.getLease(panelId);
        if (lease && lease.connectionId === connectionId) {
          assertOwnsClientSession(ctx.caller.runtime.id, lease.clientSessionId);
        }
        deps.coordinator.release(panelId, connectionId);
        return undefined;
      },
    }),
  };
}
