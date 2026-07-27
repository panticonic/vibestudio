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

export class EvalEventSinkRegistry {
  private readonly byNonce = new Map<string, EvalEventSinkRoute>();

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
    this.byNonce.set(route.nonce, Object.freeze({ ...route }));
  }

  resolve(nonce: string): EvalEventSinkRoute | null {
    return this.byNonce.get(nonce) ?? null;
  }

  close(nonce: string): void {
    this.byNonce.delete(nonce);
  }

  terminal(nonce: string): void {
    const route = this.byNonce.get(nonce);
    if (!route) return;
    this.byNonce.delete(nonce);
    route.onTerminal?.();
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
        if (
          !route ||
          !execution ||
          execution.eval.eventSinkNonce !== sinkNonce ||
          execution.eval.runtimeId !== ctx.caller.runtime.id ||
          execution.eval.runId !== runId ||
          route.runtimeId !== execution.eval.runtimeId ||
          route.runId !== runId ||
          route.contextId !== execution.contextId
        ) {
          throw new ServiceAccessError(
            "evalEventIngress",
            "publish",
            "Live eval event does not belong to the authenticated execution session",
            "EACCES"
          );
        }
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
