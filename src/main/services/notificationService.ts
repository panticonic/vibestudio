import { randomUUID } from "node:crypto";
import type { EventService } from "@vibestudio/shared/eventsService";
import { notificationMethods } from "@vibestudio/service-schemas/notification";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { ViewManager } from "../viewManager.js";
import { requireAppCapability } from "./appCapabilities.js";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";

export function createNotificationService(deps: {
  eventService: EventService;
  getViewManager: () => ViewManager;
  onAction?: (id: string, actionId: string) => void | Promise<void>;
}): ServiceDefinition {
  return {
    name: "notification",
    description: "Host notification surface for workspace apps and panels",
    policy: { allowed: ["shell", "app", "panel"] },
    methods: notificationMethods,
    handler: defineServiceHandler("notification", notificationMethods, {
      show: (ctx, [opts]) => {
        if (ctx.caller.runtime.kind === "app") {
          requireAppCapability(ctx, deps.getViewManager(), "notifications", "notification.show");
        }
        const id = opts.id ?? `notif-${randomUUID()}`;
        deps.eventService.emit("notification:show", { ...opts, id });
        return id;
      },
      dismiss: (ctx, [id]) => {
        if (ctx.caller.runtime.kind === "app") {
          requireAppCapability(ctx, deps.getViewManager(), "notifications", "notification.dismiss");
        }
        deps.eventService.emit("notification:dismiss", { id });
        return;
      },
      reportAction: async (ctx, [id, actionId]) => {
        if (ctx.caller.runtime.kind === "app") {
          requireAppCapability(
            ctx,
            deps.getViewManager(),
            "notifications",
            "notification.reportAction"
          );
        }
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
