import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { panelRuntimeMethods } from "@vibestudio/service-schemas/panelRuntime";
import type { PanelRuntimeCoordinator } from "../panelRuntimeCoordinator.js";
import type { PanelBootObservation } from "@vibestudio/shared/panel/observation";

interface PanelHostViewReport {
  url: string;
  loading: boolean;
  boot: PanelBootObservation;
}

export function createPanelRuntimeService(deps: {
  coordinator: PanelRuntimeCoordinator;
  currentEntityForSlot(slotId: string): Promise<string | null>;
  observeHostSlot(slotId: string): Promise<PanelHostViewReport | null>;
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
      observeSlot: async (_ctx, [slotId]) => {
        const current = deps.coordinator.observeSlot(slotId);
        if (!current.lease || current.observation) return current;
        const observation = await deps.observeHostSlot(slotId);
        if (!observation) return current;
        deps.coordinator.reportView(
          current.lease.runtimeEntityId,
          current.lease.connectionId,
          observation
        );
        return deps.coordinator.observeSlot(slotId);
      },
      acquire: (ctx, [panelId, request]) => {
        assertOwnsClientSession(ctx.caller.runtime.id, request.clientSessionId);
        return deps.coordinator.acquire(panelId, request);
      },
      takeOver: (ctx, [panelId, request]) => {
        assertOwnsClientSession(ctx.caller.runtime.id, request.clientSessionId);
        return deps.coordinator.takeOver(panelId, request);
      },
      handoffSlot: async (_ctx, [slotId, previousEntityId, nextEntityId]) => {
        const current = await deps.currentEntityForSlot(slotId);
        if (current !== nextEntityId) {
          throw new Error(
            `Panel runtime handoff target ${nextEntityId} is not current for slot ${slotId}`
          );
        }
        return deps.coordinator.replaceRuntimeEntityForSlot(slotId, previousEntityId, nextEntityId);
      },
      ensureSlot: async (_ctx, [slotId, entityId]) => {
        const current = await deps.currentEntityForSlot(slotId);
        if (current !== entityId) {
          throw new Error(
            `Panel runtime assignment target ${entityId} is not current for slot ${slotId}`
          );
        }
        const result = deps.coordinator.ensureDefaultCdpHostForSlot(slotId, entityId);
        if (result.assigned) return { status: "assigned" as const, lease: result.lease };
        return {
          status:
            result.reason === "already_held"
              ? ("already-held" as const)
              : result.reason === "mobile_held"
                ? ("mobile-held" as const)
                : ("unavailable" as const),
          lease: result.lease ?? null,
        };
      },
      unloadSlot: (_ctx, [slotId]) => {
        const lease = deps.coordinator.unloadSlot(slotId);
        return {
          panelId: slotId,
          operation: "unload" as const,
          status: lease ? ("unloaded" as const) : ("already_unloaded" as const),
          loaded: false,
          rebuilt: false,
          reloaded: false,
        };
      },
      takeOverSlot: async (ctx, [slotId]) => {
        if (ctx.caller.runtime.kind !== "panel") {
          throw new Error("Panel runtime takeover requires a panel caller");
        }
        const requesterLease = deps.coordinator.getLease(ctx.caller.runtime.id);
        if (!requesterLease) {
          throw new Error(
            "Panel runtime takeover requires the caller to have an active host lease"
          );
        }
        const runtimeEntityId = await deps.currentEntityForSlot(slotId);
        if (!runtimeEntityId) throw new Error(`Unknown panel slot: ${slotId}`);
        const result = deps.coordinator.takeOver(runtimeEntityId, {
          slotId,
          clientSessionId: requesterLease.clientSessionId,
          hostConnectionId: requesterLease.hostConnectionId,
          connectionId: `takeover-${slotId}-${crypto.randomUUID()}`,
        });
        return {
          panelId: slotId,
          status: "taken_over" as const,
          focused: true as const,
          loaded: true as const,
          holderLabel: result.lease.holderLabel,
        };
      },
      release: (ctx, [panelId, connectionId]) => {
        const lease = deps.coordinator.getLease(panelId);
        if (lease && lease.connectionId === connectionId) {
          assertOwnsClientSession(ctx.caller.runtime.id, lease.clientSessionId);
        }
        deps.coordinator.release(panelId, connectionId);
        return undefined;
      },
      reportView: (ctx, [panelId, connectionId, observation]) => {
        const lease = deps.coordinator.getLease(panelId);
        if (!lease || lease.connectionId !== connectionId) {
          throw new Error(`Panel runtime view report has no matching lease: ${panelId}`);
        }
        assertOwnsClientSession(ctx.caller.runtime.id, lease.clientSessionId);
        deps.coordinator.reportView(panelId, connectionId, observation);
        return undefined;
      },
    }),
  };
}
