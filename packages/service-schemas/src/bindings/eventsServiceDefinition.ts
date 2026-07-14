import type { EventName, EventPayloads } from "@vibestudio/shared/events";
import { isValidEventName } from "@vibestudio/shared/events";
import type { EventService } from "@vibestudio/shared/eventsService";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { eventsMethods } from "../events.js";

export type EventSnapshotProviders = {
  [E in EventName]?: () => EventPayloads[E] | undefined;
};

/** Bind the events wire contract to an existing in-process event service. */
export function createEventsServiceDefinition(
  eventService: EventService,
  opts: { snapshots?: EventSnapshotProviders } = {}
): ServiceDefinition {
  return {
    name: "events",
    hostRouting: { panel: "session" },
    description: "Event subscriptions",
    authority: { principals: ["user", "code", "host"] },
    methods: eventsMethods,
    handler: defineServiceHandler("events", eventsMethods, {
      subscribe: async (ctx, [eventName]) => {
        if (!isValidEventName(eventName)) throw new Error(`Unknown event: ${eventName}`);
        const subscriber = eventService.getOrCreateSubscriber(ctx);
        eventService.subscribe(eventName, ctx.caller.runtime.id, subscriber, ctx.connectionId);
        const snapshot = opts.snapshots?.[eventName]?.();
        if (snapshot !== undefined) subscriber.send(`event:${eventName}`, snapshot);
        return;
      },
      unsubscribe: (ctx, [eventName]) => {
        if (!isValidEventName(eventName)) throw new Error(`Unknown event: ${eventName}`);
        eventService.unsubscribe(eventName, ctx.caller.runtime.id, ctx.connectionId);
        return;
      },
      unsubscribeAll: (ctx) => {
        eventService.unsubscribeAll(ctx.caller.runtime.id, ctx.connectionId);
        return;
      },
    }),
  };
}
