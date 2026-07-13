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
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { notificationMethods } from "@vibestudio/service-schemas/notification";

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
    handler: defineServiceHandler("notification", notificationMethods, {
      show: (ctx, [opts]) => {
        const targetUserId = ctx.caller.subject?.userId;
        return internal.show(opts, targetUserId);
      },
      dismiss: (ctx, [id]) => {
        internal.dismiss(id, ctx.caller.subject?.userId);
      },
      reportAction: (ctx, [id, actionId]) => {
        const targetUserId = ctx.caller.subject?.userId;
        // Emit action event for any listeners
        emit("notification:action", { id, actionId }, targetUserId);
        // Resolve any pending waitForAction promise
        const pending = pendingActions.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          pending.resolve(actionId);
          pendingActions.delete(id);
        }
      },
      signalUserInbox: (_ctx, [userId]) =>
        eventService.emitToUser(userId, "user-notifications-changed", {
          changedAt: Date.now(),
        }),
    }),
  };

  return { definition, internal };
}
