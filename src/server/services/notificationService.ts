/**
 * Notification Service — centralized notification management.
 *
 * Bridges server-side code (OAuth, import, etc.) with the shell's
 * NotificationBar via the EventService. Also provides `waitForAction()`
 * for blocking consent flows.
 */

import { randomUUID } from "node:crypto";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { EventService } from "@vibestudio/shared/eventsService";
import type { NotificationPayload } from "@vibestudio/shared/events";
import { notificationMethods } from "@vibestudio/shared/serviceSchemas/notification";

/**
 * Internal interface for server-side code to push notifications
 * and wait for user actions (e.g., OAuth consent approval).
 */
export interface NotificationServiceInternal {
  show(
    notification: Omit<NotificationPayload, "id"> & { id?: string },
    targetUserId?: string
  ): string;
  dismiss(id: string, targetUserId?: string): void;
  waitForAction(id: string, timeoutMs?: number): Promise<string>;
}

export function createNotificationService(deps: { eventService: EventService }): {
  definition: ServiceDefinition;
  internal: NotificationServiceInternal;
} {
  const { eventService } = deps;
  const emit = <E extends "notification:show" | "notification:dismiss" | "notification:action">(
    event: E,
    payload: Parameters<EventService["emit"]>[1],
    targetUserId?: string
  ): void => {
    if (targetUserId && targetUserId !== "system") {
      eventService.emitToUser(targetUserId, event, payload as never);
    } else {
      eventService.emit(event, payload as never);
    }
  };

  /** Pending action resolvers keyed by notification ID */
  const pendingActions = new Map<
    string,
    {
      resolve: (actionId: string) => void;
      reject: (reason: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  const internal: NotificationServiceInternal = {
    show(opts, targetUserId) {
      const id = opts.id ?? `notif-${randomUUID()}`;
      const payload: NotificationPayload = { ...opts, id };
      emit("notification:show", payload, targetUserId);
      return id;
    },

    dismiss(id, targetUserId) {
      emit("notification:dismiss", { id }, targetUserId);
      // Also reject any pending waitForAction
      const pending = pendingActions.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Notification dismissed"));
        pendingActions.delete(id);
      }
    },

    waitForAction(id, timeoutMs = 120_000) {
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingActions.delete(id);
          reject(new Error(`Notification action timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        pendingActions.set(id, { resolve, reject, timer });
      });
    },
  };

  const definition: ServiceDefinition = {
    name: "notification",
    description: "Push notifications to the shell chrome area",
    policy: { allowed: ["shell", "app", "panel", "worker", "do", "extension", "server"] },
    methods: notificationMethods,
    handler: async (ctx, method, args) => {
      const targetUserId = ctx.caller.subject?.userId;
      switch (method) {
        case "show": {
          const [opts] = args as [Omit<NotificationPayload, "id"> & { id?: string }];
          return internal.show(opts, targetUserId);
        }
        case "dismiss": {
          const [id] = args as [string];
          internal.dismiss(id, targetUserId);
          return;
        }
        case "reportAction": {
          const [id, actionId] = args as [string, string];
          // Emit action event for any listeners
          emit("notification:action", { id, actionId }, targetUserId);
          // Resolve any pending waitForAction promise
          const pending = pendingActions.get(id);
          if (pending) {
            clearTimeout(pending.timer);
            pending.resolve(actionId);
            pendingActions.delete(id);
          }
          return;
        }
        case "signalUserInbox": {
          const [userId] = args as [string];
          return eventService.emitToUser(userId, "user-notifications-changed", {
            changedAt: Date.now(),
          });
        }
        default:
          throw new Error(`Unknown notification method: ${method}`);
      }
    },
  };

  return { definition, internal };
}
