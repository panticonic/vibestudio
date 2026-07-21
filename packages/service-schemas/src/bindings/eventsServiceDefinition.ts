import type { EventName, EventPayloads } from "@vibestudio/shared/events";
import { isValidEventName } from "@vibestudio/shared/events";
import { EventService } from "@vibestudio/shared/eventsService";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { eventsMethods } from "../events.js";

export type EventSnapshotProviders = {
  [E in EventName]?: () => EventPayloads[E] | undefined;
};

export interface EventsServiceDefinitionOptions {
  /** Explicit RPC endpoint name for this event domain. */
  serviceName?: string;
  snapshots?: EventSnapshotProviders;
  onWatchOpened?: (
    events: readonly EventName[],
    context: ServiceContext
  ) => (() => void) | undefined;
}

/** Bind the events wire contract to an existing in-process event service. */
export function createEventsServiceDefinition(
  eventService: EventService,
  opts: EventsServiceDefinitionOptions = {}
): ServiceDefinition {
  const serviceName = opts.serviceName ?? "events";
  return {
    name: serviceName,
    description: "Event subscriptions",
    authority: { principals: ["user", "code", "host"] },
    methods: eventsMethods,
    handler: defineServiceHandler(serviceName, eventsMethods, {
      watch: (ctx, [requestedEvents, watchId]) => {
        const events = requestedEvents.map((eventName) => {
          if (!isValidEventName(eventName)) throw new Error(`Unknown event: ${eventName}`);
          return eventName;
        });
        const snapshots: Partial<Record<EventName, () => unknown>> = {};
        for (const event of events) {
          const snapshot = opts.snapshots?.[event];
          if (snapshot) snapshots[event] = snapshot;
        }
        const release = opts.onWatchOpened?.(events, ctx);
        return eventService.openWatch({
          callerId: ctx.caller.runtime.id,
          callerKind: ctx.caller.runtime.kind,
          connectionId: ctx.connectionId ?? EventService.DEFAULT_CONNECTION_ID,
          watchId,
          ...(ctx.caller.subject?.userId ? { userId: ctx.caller.subject.userId } : {}),
          events,
          snapshots,
          ...(release ? { onClosed: release } : {}),
        });
      },
    }),
  };
}
