import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { panelRuntimeMethods } from "@vibestudio/service-schemas/panelRuntime";
import type { PanelRuntimeCoordinator } from "../panelRuntimeCoordinator.js";
import type { PanelBootProbeResult } from "@vibestudio/shared/panel/observation";
import { browserUrlFromPanelSource, isBrowserPanelSource } from "@vibestudio/shared/panelChrome";

interface PanelHostViewReport {
  url: string;
  loading: boolean;
  boot: PanelBootProbeResult;
  failure?: {
    reporter: "build" | "materialization" | "host";
    failure: import("@vibestudio/shared/panel/observation").PanelAttemptFailure;
  };
}

export function createPanelRuntimeService(deps: {
  coordinator: PanelRuntimeCoordinator;
  currentEntityForSlot(slotId: string): Promise<string | null>;
  observeHostSlot(slotId: string): Promise<PanelHostViewReport | null>;
  browserSourceForSlot?: (slotId: string) => Promise<string | null>;
  /** True only after the lease's exact panel-principal RPC session is registered. */
  isRuntimeRouteReachable?: (runtimeEntityId: string, connectionId: string) => boolean;
  /** Spawn the renderer of last resort before retrying a programmatic lease. */
  ensureDefaultHeadlessHost?: () => Promise<boolean>;
}): ServiceDefinition {
  const normalizeHostObservation = async (
    slotId: string,
    observation: PanelHostViewReport | null
  ): Promise<PanelHostViewReport | null> => {
    if (!observation || observation.boot.kind !== "unavailable" || !deps.browserSourceForSlot) {
      return observation;
    }
    const source = await deps.browserSourceForSlot(slotId);
    if (
      source &&
      isBrowserPanelSource(source) &&
      !observation.loading &&
      browserDocumentMatchesSource(observation.url, source)
    ) {
      return { ...observation, boot: { kind: "observed", observation: { phase: "ready" } } };
    }
    return observation;
  };
  deps.coordinator.setAttemptProbe(async (slotId) =>
    normalizeHostObservation(slotId, await deps.observeHostSlot(slotId))
  );
  const observationSnapshot = (slotId: string) => deps.coordinator.observeSlotLifecycle(slotId);
  const sameVersion = (
    left: { epoch: string; counter: number },
    right: { epoch: string; counter: number }
  ) => left.epoch === right.epoch && left.counter === right.counter;
  const attemptCannotAdvance = (result: ReturnType<PanelRuntimeCoordinator["getAttempt"]>) =>
    result.kind === "report" &&
    (result.attempt.phase === "ready" ||
      result.attempt.phase === "failed" ||
      result.attempt.phase === "stopped");
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
      observeSlot: (_ctx, [slotId]) => observationSnapshot(slotId),
      getAttempt: (_ctx, [ref]) => deps.coordinator.getAttempt(ref),
      awaitAttempt: (ctx, [ref, afterRevision]) => {
        const current = deps.coordinator.getAttempt(ref);
        if (
          current.kind === "unknown-attempt" ||
          current.attempt.revision > afterRevision ||
          attemptCannotAdvance(current)
        ) {
          return current;
        }
        return new Promise((resolve, reject) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            unsubscribe();
            ctx.signal?.removeEventListener("abort", onAbort);
            resolve(deps.coordinator.getAttempt(ref));
          };
          const onAbort = () => {
            if (settled) return;
            settled = true;
            unsubscribe();
            reject(ctx.signal?.reason ?? new Error("Panel attempt wait aborted"));
          };
          const unsubscribe = deps.coordinator.onAttemptChanged((attemptId) => {
            if (attemptId === ref.attemptId) finish();
          });
          ctx.signal?.addEventListener("abort", onAbort, { once: true });
          const raced = deps.coordinator.getAttempt(ref);
          if (
            raced.kind === "unknown-attempt" ||
            raced.attempt.revision > afterRevision ||
            attemptCannotAdvance(raced)
          )
            finish();
          else if (ctx.signal?.aborted) onAbort();
        });
      },
      awaitSlot: (ctx, [slotId, after]) => {
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
            reject(ctx.signal?.reason ?? new Error("Panel slot wait aborted"));
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
        deps.coordinator.ensureAttemptForSlot(slotId, entityId);
        const source = await deps.browserSourceForSlot?.(slotId);
        if (!source || !isBrowserPanelSource(source)) {
          const lifecycle = deps.coordinator.observeSlotLifecycle(slotId);
          if (!lifecycle.build) deps.coordinator.setBuildState(slotId, { state: "building" });
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
        const attempt = deps.coordinator.currentAttemptForSlot(slotId);
        if (attempt && attempt.runtimeEntityId !== entityId) {
          // A newer navigation committed while we awaited host assignment;
          // returning its attempt would hand the caller a wait target it did
          // not create.
          throw new Error(
            `Panel runtime assignment target ${entityId} is no longer current for slot ${slotId}`
          );
        }
        if (result.assigned) {
          return { status: "assigned" as const, lease: result.lease, attempt };
        }
        return {
          status:
            result.reason === "already_held"
              ? ("already-held" as const)
              : result.reason === "mobile_held"
                ? ("mobile-held" as const)
                : ("unavailable" as const),
          lease: result.lease ?? null,
          attempt,
        };
      },
      unloadSlot: (_ctx, [slotId]) => {
        const before = deps.coordinator.currentAttemptForSlot(slotId);
        const lease = deps.coordinator.unloadSlot(slotId);
        const stoppedAttempt = Boolean(
          before &&
          before.phase !== "failed" &&
          before.phase !== "stopped" &&
          deps.coordinator.currentAttemptForSlot(slotId)?.phase === "stopped"
        );
        return {
          panelId: slotId,
          operation: "unload" as const,
          status: lease || stoppedAttempt ? ("unloaded" as const) : ("already_unloaded" as const),
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
      reportView: async (ctx, [panelId, connectionId, observation]) => {
        const lease = deps.coordinator.getLease(panelId);
        if (!lease || lease.connectionId !== connectionId) {
          return "stale" as const;
        }
        assertOwnsClientSession(ctx.caller.runtime.id, lease.clientSessionId);
        const normalized = await normalizeHostObservation(lease.slotId, observation);
        if (!normalized) return "stale" as const;
        return deps.coordinator.reportView(panelId, connectionId, normalized, "host")
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
        return deps.coordinator.reportView(
          runtimeEntityId,
          lease.connectionId,
          observation,
          "renderer"
        )
          ? ("reported" as const)
          : ("stale" as const);
      },
    }),
  };
}

function browserDocumentMatchesSource(viewUrl: string, source: string): boolean {
  const requestedUrl = browserUrlFromPanelSource(source);
  if (!requestedUrl || !viewUrl) return false;
  try {
    const view = new URL(viewUrl);
    const requested = new URL(requestedUrl);
    return requested.hostname ? view.hostname === requested.hostname : view.href === requested.href;
  } catch {
    return viewUrl === requestedUrl;
  }
}
