import { randomUUID } from "node:crypto";
import type { EventService } from "@vibestudio/shared/eventsService";
import { notificationMethods } from "@vibestudio/service-schemas/notification";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";

export function createNotificationService(deps: {
  eventService: EventService;
  onAction?: (id: string, actionId: string) => void | Promise<void>;
}): ServiceDefinition {
  return {
    name: "notification",
    description: "Host notification surface for workspace apps and panels",
    authority: { principals: ["user", "code"] },
    methods: notificationMethods,
    handler: defineServiceHandler("notification", notificationMethods, {
      show: (_ctx, [opts]) => {
        const id = opts.id ?? `notif-${randomUUID()}`;
        deps.eventService.emit("notification:show", { ...opts, id });
        return id;
      },
      dismiss: (_ctx, [id]) => {
        deps.eventService.emit("notification:dismiss", { id });
        return;
      },
      reportAction: async (_ctx, [id, actionId]) => {
        deps.eventService.emit("notification:action", { id, actionId });
        await deps.onAction?.(id, actionId);
        return;
      },
      signalUserInbox: (_ctx, [userId]) =>
        deps.eventService.emitToUser(userId, "user-notifications-changed", {
          changedAt: Date.now(),
        }),
    }),
  };
}
