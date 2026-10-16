/**
 * Notification Service — centralized notification management.
 *
 * Bridges server-side code (OAuth, import, etc.) with the shell's
 * NotificationBar via the EventService. A host relays the person's choice
 * (and reply text, for an action that takes input) back through
 * `reportAction`; producers observe it as a `notification:action` event.
 */

import { createHash, randomUUID } from "node:crypto";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { EventService } from "@vibestudio/shared/eventsService";
import type { NotificationPayload } from "@vibestudio/shared/events";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { notificationMethods } from "@vibestudio/service-schemas/notification";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { isTrustedDeviceCaller, type CapabilityTrustDeps } from "./clientTrust.js";
import type { UserInboxPushRequest } from "@vibestudio/service-schemas/notification";
import type { PushUserInboxDataPayload } from "@vibestudio/shared/userNotifications";
import type { PushServiceInternal } from "./pushService.js";

/**
 * Internal interface for server-side code to push notifications
 * and wait for user actions (e.g., OAuth consent approval).
 */
export interface NotificationServiceInternal {
  show(notification: Omit<NotificationPayload, "id">, targetUserId?: string): string;
  dismiss(id: string, targetUserId?: string): void;
}

export interface NotificationServiceDeps {
  eventService: EventService;
  hasClientCapability?: CapabilityTrustDeps["hasClientCapability"];
  /**
   * The push half of a userland inbox escalation (messaging plan §4.5 step 5).
   * Optional so callers without a device registry (tests, headless hosts) still
   * get the in-app surfaces; `pushUserInbox` then reaches zero devices.
   */
  push?: Pick<PushServiceInternal, "listRegistrations" | "sendToTargets">;
  /** This child's workspace member userIds — the only accounts a push may reach. */
  workspaceMemberUserIds?: () => readonly string[];
}

/** Turn one inbox push request into the string-only FCM data map. */
export function userInboxPushData(
  request: UserInboxPushRequest
): Omit<PushUserInboxDataPayload, "workspaceId" | "serverId" | "userId"> {
  return {
    kind: "user-inbox",
    notificationId: request.notificationId,
    inboxKind: request.kind,
    title: request.title,
    ...(request.body ? { body: request.body } : {}),
    priority: request.priority ?? "normal",
    ...(request.channelId ? { channelId: request.channelId } : {}),
    ...(request.channelTargetId ? { channelTargetId: request.channelTargetId } : {}),
    ...(request.messageId ? { messageId: request.messageId } : {}),
    ...(request.senderParticipantId ? { senderParticipantId: request.senderParticipantId } : {}),
    ...(request.senderHandle ? { senderHandle: request.senderHandle } : {}),
  };
}

export function createNotificationService(deps: NotificationServiceDeps): {
  definition: ServiceDefinition;
  internal: NotificationServiceInternal;
} {
  const { eventService } = deps;

  /**
   * Push one durable inbox entry to a member's registered devices. The host
   * never stores the entry — userland does — it only forwards what a phone
   * needs to render it and deep-link back. Non-members and unknown accounts
   * reach nobody; that is a silent zero, not an error, because the durable
   * entry is already the record and the caller has nothing to retry.
   */
  const pushUserInbox = async (userId: string, request: UserInboxPushRequest): Promise<number> => {
    if (!deps.push) return 0;
    if (deps.workspaceMemberUserIds && !deps.workspaceMemberUserIds().includes(userId)) {
      return 0;
    }
    const targets = deps.push
      .listRegistrations()
      .filter((registration) => registration.userId === userId)
      .map((registration) => ({ userId: registration.userId, clientId: registration.clientId }));
    if (targets.length === 0) return 0;
    const results = await deps.push.sendToTargets(targets, {
      title: request.title,
      ...(request.body ? { body: request.body } : {}),
      category: "vibestudio-user-inbox",
      data: userInboxPushData(request),
    });
    return results.filter((result) => result.sent).length;
  };
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

  type NotificationOwner = (
    | { kind: "caller"; runtimeKey: string }
    | { kind: "host" }
  ) & {
    targetUserId?: string;
    /** Actions that take reply text (`input: "text"`). */
    textActions: ReadonlySet<string>;
  };
  const notificationOwners = new Map<string, NotificationOwner>();

  const textActionsOf = (opts: Pick<NotificationPayload, "actions">): ReadonlySet<string> =>
    new Set((opts.actions ?? []).filter((action) => action.input === "text").map((a) => a.id));

  const callerRuntimeKey = (caller: VerifiedCaller): string =>
    `${caller.runtime.kind}\0${caller.runtime.id}`;

  const callerNotificationId = (caller: VerifiedCaller): string => {
    const callerDigest = createHash("sha256")
      .update(callerRuntimeKey(caller))
      .digest("hex")
      .slice(0, 16);
    return `notif-${caller.runtime.kind}-${callerDigest}-${randomUUID()}`;
  };

  const showForCaller = (
    caller: VerifiedCaller,
    opts: Omit<NotificationPayload, "id" | "sourcePanelId" | "iconDataUrl">,
    targetUserId?: string
  ): string => {
    const id = callerNotificationId(caller);
    const payload: NotificationPayload = {
      ...opts,
      id,
      ...(caller.runtime.kind === "panel" ? { sourcePanelId: caller.runtime.id } : {}),
    };
    notificationOwners.set(id, {
      kind: "caller",
      runtimeKey: callerRuntimeKey(caller),
      ...(targetUserId ? { targetUserId } : {}),
      textActions: textActionsOf(opts),
    });
    emit("notification:show", payload, targetUserId);
    return id;
  };

  const assertCallerOwns = (id: string, caller: VerifiedCaller): void => {
    const owner = notificationOwners.get(id);
    if (owner?.kind !== "caller" || owner.runtimeKey !== callerRuntimeKey(caller)) {
      throw new Error("Notification does not belong to this caller");
    }
  };

  const internal: NotificationServiceInternal = {
    show(opts, targetUserId) {
      const id = `notif-host-${randomUUID()}`;
      const payload: NotificationPayload = { ...opts, id };
      notificationOwners.set(id, {
        kind: "host",
        ...(targetUserId ? { targetUserId } : {}),
        textActions: textActionsOf(opts),
      });
      emit("notification:show", payload, targetUserId);
      return id;
    },

    dismiss(id, targetUserId) {
      notificationOwners.delete(id);
      emit("notification:dismiss", { id }, targetUserId);
    },
  };

  const definition: ServiceDefinition = {
    name: "notification",
    description: "Push notifications to the shell chrome area",
    authority: { principals: ["user", "code", "host"] },
    methods: notificationMethods,
    handler: defineServiceHandler("notification", notificationMethods, {
      show: (ctx, [opts]) => {
        const targetUserId = ctx.caller.subject?.userId;
        return showForCaller(ctx.caller, opts, targetUserId);
      },
      showToUser: (ctx, [userId, opts]) => showForCaller(ctx.caller, opts, userId),
      dismiss: (ctx, [id]) => {
        assertCallerOwns(id, ctx.caller);
        internal.dismiss(id, ctx.caller.subject?.userId);
      },
      reportAction: (ctx, [id, actionId, text]) => {
        if (!isTrustedDeviceCaller(ctx.caller, deps)) {
          throw new Error("Only trusted workspace chrome can report a notification action");
        }
        const targetUserId = ctx.caller.subject?.userId;
        const owner = notificationOwners.get(id);
        if (
          owner?.targetUserId &&
          owner.targetUserId !== "system" &&
          owner.targetUserId !== targetUserId
        ) {
          throw new Error("Notification does not belong to this user");
        }
        if (text !== undefined && !owner?.textActions.has(actionId)) {
          throw new Error(`Notification action ${actionId} does not take reply text`);
        }
        emit(
          "notification:action",
          { id, actionId, ...(text !== undefined ? { text } : {}) },
          targetUserId
        );
        notificationOwners.delete(id);
      },
      signalUserInbox: (_ctx, [userId]) =>
        eventService.emitToUser(userId, "user-notifications-changed", {
          changedAt: Date.now(),
        }),
      pushUserInbox: (_ctx, [userId, request]) => pushUserInbox(userId, request),
    }),
  };

  return { definition, internal };
}
