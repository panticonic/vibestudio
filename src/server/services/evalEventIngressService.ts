import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { ServiceAccessError } from "@vibestudio/shared/serviceDispatcher";
import type { WorkspaceEntityStore } from "../workspaceEntityStore.js";
import type { EventService } from "@vibestudio/shared/eventsService";
import { evalEventIngressMethods } from "@vibestudio/service-schemas/evalEventIngress";

interface EvalEventSinkRoute {
  nonce: string;
  runtimeId: string;
  runId: string;
  contextId: string;
  ownerCallerId: string;
  initiatorCallerId: string;
  subKey: string;
  onTerminal?: () => void;
}

type ClosedEvalEventSinkRoute = Omit<EvalEventSinkRoute, "onTerminal">;

export class EvalEventSinkRegistry {
  private static readonly MAX_CLOSED_ROUTES = 1_000;
  private readonly byNonce = new Map<string, EvalEventSinkRoute>();
  private readonly closedByNonce = new Map<string, ClosedEvalEventSinkRoute>();

  register(route: EvalEventSinkRoute): void {
    const existing = this.byNonce.get(route.nonce);
    if (
      existing &&
      (existing.runtimeId !== route.runtimeId ||
        existing.runId !== route.runId ||
        existing.contextId !== route.contextId ||
        existing.ownerCallerId !== route.ownerCallerId ||
        existing.initiatorCallerId !== route.initiatorCallerId ||
        existing.subKey !== route.subKey)
    ) {
      throw new Error("Eval event sink nonce was reused for a different route");
    }
    this.closedByNonce.delete(route.nonce);
    this.byNonce.set(route.nonce, Object.freeze({ ...route }));
  }

  resolve(nonce: string): EvalEventSinkRoute | null {
    return this.byNonce.get(nonce) ?? null;
  }

  close(nonce: string): void {
    const route = this.byNonce.get(nonce);
    if (!route) return;
    this.byNonce.delete(nonce);
    this.rememberClosed(route);
  }

  resolveClosed(nonce: string): ClosedEvalEventSinkRoute | null {
    return this.closedByNonce.get(nonce) ?? null;
  }

  terminal(nonce: string): void {
    const route = this.byNonce.get(nonce);
    if (!route) return;
    this.byNonce.delete(nonce);
    this.rememberClosed(route);
    route.onTerminal?.();
  }

  private rememberClosed(route: EvalEventSinkRoute): void {
    const identity: ClosedEvalEventSinkRoute = {
      nonce: route.nonce,
      runtimeId: route.runtimeId,
      runId: route.runId,
      contextId: route.contextId,
      ownerCallerId: route.ownerCallerId,
      initiatorCallerId: route.initiatorCallerId,
      subKey: route.subKey,
    };
    this.closedByNonce.delete(route.nonce);
    this.closedByNonce.set(route.nonce, Object.freeze(identity));
    while (this.closedByNonce.size > EvalEventSinkRegistry.MAX_CLOSED_ROUTES) {
      const oldest = this.closedByNonce.keys().next().value as string | undefined;
      if (!oldest) break;
      this.closedByNonce.delete(oldest);
    }
  }
}

/**
 * Producer-side live delivery for durable eval events. The caller cannot name
 * an owner, scope, context, or transport: all routing is re-derived from the
 * authenticated EvalDO entity and its exact live execution session.
 */
export function createEvalEventIngressService(deps: {
  entityStore: WorkspaceEntityStore;
  eventService: EventService;
  sinks: EvalEventSinkRegistry;
}): ServiceDefinition {
  return {
    name: "evalEventIngress",
    description: "Internal producer ingress for durable eval run events",
    authority: { principals: ["session"] },
    methods: evalEventIngressMethods,
    handler: defineServiceHandler("evalEventIngress", evalEventIngressMethods, {
      publish: async (ctx, [sinkNonce, runId, event]) => {
        const execution = ctx.caller.executionSession;
        const route = deps.sinks.resolve(sinkNonce);
        const closedRoute = route ? null : deps.sinks.resolveClosed(sinkNonce);
        const authenticatedRoute = route ?? closedRoute;
        if (
          !execution ||
          !authenticatedRoute ||
          execution.eval.eventSinkNonce !== sinkNonce ||
          execution.eval.runtimeId !== ctx.caller.runtime.id ||
          execution.eval.runId !== runId ||
          authenticatedRoute.runtimeId !== execution.eval.runtimeId ||
          authenticatedRoute.runId !== runId ||
          authenticatedRoute.contextId !== execution.contextId
        ) {
          throw new ServiceAccessError(
            "evalEventIngress",
            "publish",
            "Live eval event does not belong to the authenticated execution session",
            "EACCES"
          );
        }
        // The durable event is canonical. Once the host observer closes, an
        // already queued producer delivery is expected and must terminate as
        // a benign no-op. Closed routes are retained only as a small bounded
        // identity tombstone, so unknown/forged sink nonces still fail.
        if (!route) return { delivered: false };
        const entity = deps.entityStore.cache.resolveActive(ctx.caller.runtime.id);
        const entityState =
          entity?.stateArgs &&
          typeof entity.stateArgs === "object" &&
          !Array.isArray(entity.stateArgs)
            ? (entity.stateArgs as Record<string, unknown>)
            : null;
        if (
          entity?.kind !== "do" ||
          entity.className !== "EvalDO" ||
          entity.source.repoPath !== "vibestudio/internal" ||
          entity.contextId !== route.contextId ||
          typeof entity.parentId !== "string" ||
          entityState?.["ownerPrincipalId"] !== route.ownerCallerId ||
          entityState?.["subKey"] !== route.subKey
        ) {
          throw new ServiceAccessError(
            "evalEventIngress",
            "publish",
            "Authenticated eval event producer no longer has an exact live owner binding",
            "EACCES"
          );
        }
        let delivered = false;
        for (const callerId of new Set([route.ownerCallerId, route.initiatorCallerId])) {
          delivered =
            deps.eventService.emitToWatchesOfCaller(callerId, "eval:run-event", {
              runId,
              scopeKey: route.subKey,
              event: { ...event, payload: event.payload },
            }) || delivered;
        }
        const terminalState =
          event.kind === "state" &&
          event.payload &&
          typeof event.payload === "object" &&
          !Array.isArray(event.payload)
            ? (event.payload as Record<string, unknown>)["status"]
            : null;
        if (
          terminalState === "succeeded" ||
          terminalState === "failed" ||
          terminalState === "cancelled" ||
          terminalState === "expired" ||
          terminalState === "interrupted"
        ) {
          deps.sinks.terminal(sinkNonce);
        }
        return { delivered };
      },
    }),
  };
}
