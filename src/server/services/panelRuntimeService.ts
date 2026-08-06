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
  /** True only after the lease's exact panel-principal RPC session is registered. */
  isRuntimeRouteReachable?: (runtimeEntityId: string, connectionId: string) => boolean;
  /** Spawn the renderer of last resort before retrying a programmatic lease. */
  ensureDefaultHeadlessHost?: () => Promise<boolean>;
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
        // Reconnect grace preserves ownership for a short time, but the
        // disconnected channel cannot prove that its last page sample is
        // still live. Wait for markConnected/reportView before refreshing the
        // host or exposing readiness again.
        if (!current.lease || current.lease.expiresAt !== undefined) return current;
        // A host reports its first view as soon as navigation starts. Keep
        // polling the host until the boot probe reaches a terminal phase;
        // otherwise a cached `booting` observation makes every caller's
        // waitUntilReady loop forever even after the page has become ready.
        const phase = current.observation?.boot.phase;
        // Managed panels have an explicit terminal boot phase. An external
        // browser panel deliberately reports `unavailable`, so its native
        // URL/loading pair is the readiness input instead. That pair is live
        // host state, not a terminal durable fact: a cached `loading: false`
        // sample can be the pre-navigation about:blank view immediately
        // before Chromium starts the requested document. Always refresh an
        // unavailable observation so callers cannot mistake that stale sample
        // for a ready browser page.
        let refreshed = current;
        if (phase !== "ready" && phase !== "failed") {
          const observation = await deps.observeHostSlot(slotId);
          if (observation) {
            deps.coordinator.reportView(
              current.lease.runtimeEntityId,
              current.lease.connectionId,
              observation
            );
            refreshed = deps.coordinator.observeSlot(slotId);
          }
        }

        // Managed panels must not report ready before the exact
        // panel-principal RPC route authenticates. External browser documents
        // deliberately have no such route: their host reports boot=unavailable
        // and the URL/loading pair is their complete readiness contract.
        if (
          refreshed.observation?.boot.phase !== "unavailable" &&
          deps.isRuntimeRouteReachable &&
          !deps.isRuntimeRouteReachable(current.lease.runtimeEntityId, current.lease.connectionId)
        ) {
          return { lease: current.lease, observation: null };
        }
        return refreshed;
      },
      acquire: (ctx, [panelId, request]) => {
        assertOwnsClientSession(ctx.caller.runtime.id, request.clientSessionId);
        return deps.coordinator.acquire(panelId, request);
      },
      takeOver: (ctx, [panelId, request]) => {
        assertOwnsClientSession(ctx.caller.runtime.id, request.clientSessionId);
        return deps.coordinator.takeOver(panelId, request);
      },
      ensureSlot: async (_ctx, [slotId, entityId]) => {
        const current = await deps.currentEntityForSlot(slotId);
        if (current !== entityId) {
          throw new Error(
            `Panel runtime assignment target ${entityId} is not current for slot ${slotId}`
          );
        }
        let result = deps.coordinator.ensureDefaultCdpHostForSlot(slotId, entityId);
        if (
          !result.assigned &&
          result.reason === "no_default_cdp_host" &&
          deps.ensureDefaultHeadlessHost &&
          (await deps.ensureDefaultHeadlessHost())
        ) {
          result = deps.coordinator.ensureDefaultCdpHostForSlot(slotId, entityId);
        }
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
