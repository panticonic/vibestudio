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
  const observationSnapshot = (slotId: string) => {
    const current = deps.coordinator.observeSlot(slotId);
    const managedRouteMissing =
      current.lease &&
      current.observation?.boot.phase !== "unavailable" &&
      deps.isRuntimeRouteReachable &&
      !deps.isRuntimeRouteReachable(current.lease.runtimeEntityId, current.lease.connectionId);
    return {
      version: deps.coordinator.observationVersion(slotId),
      lease: current.lease,
      observation: managedRouteMissing ? null : current.observation,
    };
  };
  const sameVersion = (
    left: { epoch: string; counter: number },
    right: { epoch: string; counter: number }
  ) => left.epoch === right.epoch && left.counter === right.counter;
  const refreshHostSnapshot = async (slotId: string): Promise<void> => {
    const current = deps.coordinator.observeSlot(slotId);
    if (!current.lease || current.lease.expiresAt !== undefined) return;
    const phase = current.observation?.boot.phase;
    if (phase === "ready" || phase === "failed") return;
    const observation = await deps.observeHostSlot(slotId);
    if (!observation) return;
    // Publication is a compare-and-set against the exact lease incarnation.
    // A concurrent replacement simply wins and makes this snapshot stale.
    deps.coordinator.reportView(
      current.lease.runtimeEntityId,
      current.lease.connectionId,
      observation
    );
  };
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
        await refreshHostSnapshot(slotId);
        return observationSnapshot(slotId);
      },
      awaitSlotChange: async (ctx, [slotId, after]) => {
        await refreshHostSnapshot(slotId);
        const current = observationSnapshot(slotId);
        if (!sameVersion(current.version, after)) return current;
        return new Promise((resolve, reject) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            unsubscribe();
            ctx.signal?.removeEventListener("abort", onAbort);
            resolve(observationSnapshot(slotId));
          };
          const onAbort = () => {
            if (settled) return;
            settled = true;
            unsubscribe();
            reject(ctx.signal?.reason ?? new Error("Panel observation wait aborted"));
          };
          const unsubscribe = deps.coordinator.onSlotObservationChanged((changedSlotId) => {
            if (changedSlotId === slotId) finish();
          });
          ctx.signal?.addEventListener("abort", onAbort, { once: true });
          // Close the snapshot/subscribe race: any transition between the
          // first read and listener registration is visible in the version.
          if (!sameVersion(observationSnapshot(slotId).version, after)) finish();
          else if (ctx.signal?.aborted) onAbort();
        });
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
          return "stale" as const;
        }
        assertOwnsClientSession(ctx.caller.runtime.id, lease.clientSessionId);
        return deps.coordinator.reportView(panelId, connectionId, observation)
          ? ("reported" as const)
          : ("stale" as const);
      },
      reportOwnView: (ctx, [observation]) => {
        if (ctx.caller.runtime.kind !== "panel") {
          throw new Error("Panel runtime self-observation requires a panel caller");
        }
        const runtimeEntityId = ctx.caller.runtime.id;
        const lease = deps.coordinator.getLease(runtimeEntityId);
        if (!lease) return "stale" as const;
        return deps.coordinator.reportView(runtimeEntityId, lease.connectionId, observation)
          ? ("reported" as const)
          : ("stale" as const);
      },
    }),
  };
}
