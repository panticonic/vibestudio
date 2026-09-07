import type { EventName, EventPayloads } from "@vibestudio/shared/events";
import { isValidEventName } from "@vibestudio/shared/events";
import { EventService } from "@vibestudio/shared/eventsService";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import {
  verifiedInitiator,
  type ServiceContext,
} from "@vibestudio/shared/serviceDispatcher";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { eventsMethods } from "../events.js";
import type { ServiceMethodSchemas } from "@vibestudio/shared/typedServiceClient";

export type EventSnapshotProviders = {
  [E in EventName]?: (context: ServiceContext) => EventPayloads[E] | undefined;
};

export interface EventsServiceDefinitionOptions {
  /** Explicit RPC endpoint name for this event domain. */
  serviceName?: string;
  snapshots?: EventSnapshotProviders;
  onWatchOpened?: (
    events: readonly EventName[],
    context: ServiceContext
  ) => (() => void) | undefined;
  methods?: ServiceMethodSchemas;
}

/** Delivery owner: authenticated transport identity plus its verified human audience. */
export function eventWatchOwner(context: ServiceContext) {
  const userId = verifiedInitiator(context).subject?.userId;
  return {
    callerId: context.caller.runtime.id,
    callerKind: context.caller.runtime.kind,
    ...(userId ? { userId } : {}),
  };
}

/** Bind the events wire contract to an existing in-process event service. */
export function createEventsServiceDefinition(
  eventService: EventService,
  opts: EventsServiceDefinitionOptions = {}
): ServiceDefinition {
  const serviceName = opts.serviceName ?? "events";
  const methods = opts.methods ?? eventsMethods;
  return {
    name: serviceName,
    description: "Event subscriptions",
    authority: { principals: ["user", "code", "host"] },
    methods,
    handler: defineServiceHandler(serviceName, methods, {
      watch: (ctx, [requestedEvents, watchId]) => {
        const events = (requestedEvents as string[]).map((eventName: string) => {
          if (!isValidEventName(eventName)) throw new Error(`Unknown event: ${eventName}`);
          return eventName;
        });
        const snapshots: Partial<Record<EventName, () => unknown>> = {};
        for (const event of events) {
          const snapshot = opts.snapshots?.[event];
          if (snapshot) snapshots[event] = () => snapshot(ctx);
        }
        const release = opts.onWatchOpened?.(events, ctx);
        return eventService.openWatch({
          ...eventWatchOwner(ctx),
          connectionId: ctx.connectionId ?? EventService.DEFAULT_CONNECTION_ID,
          watchId,
          events,
          snapshots,
          ...(release ? { onClosed: release } : {}),
        });
      },
    }),
  };
}
