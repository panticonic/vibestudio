import { z } from "zod";
import { readWorkspacePushScope } from "./workspacePushScope.js";
import { ChannelInviteSchema, type ChannelInvite } from "./channelInvites.js";

/**
 * Durable, account-scoped userland notification.
 *
 * The host only transports an opaque "inbox changed" signal. Notification
 * content remains in the workspace semantic control plane and is returned only to a
 * caller whose host-stamped `AuthenticatedCaller.userId` matches `userId`.
 */
export interface UserNotification {
  /** Stable, globally producer-namespaced id used for idempotent upsert/acknowledgement. */
  id: string;
  /** Bare workspace account id. */
  userId: string;
  /** Extensible notification discriminator, e.g. `channel.invite`. */
  kind: string;
  title: string;
  message?: string;
  /** Kind-specific structured data. Must be JSON-serializable. */
  data?: unknown;
  createdAt: number;
  /** Producer-scoped monotonic revision for stale retry/tombstone ordering. */
  revision: number;
  /** When the account acknowledged it; present only in history listings. */
  acknowledgedAt?: number;
}

export interface UserNotificationListInput {
  /** Also return acknowledged entries (the durable history). */
  includeAcknowledged?: boolean;
  limit?: number;
}

export type PutUserNotificationInput = UserNotification;

export interface UserNotificationListResult {
  notifications: UserNotification[];
}

export interface UserNotificationAcknowledgementResult {
  acknowledged: boolean;
}

export const CHANNEL_INVITE_NOTIFICATION_KIND = "channel.invite";

/**
 * An agent addressed a person through `notify` at the `inbox` rung or above
 * (messaging plan §4.5). The entry is the durable half of that escalation; the
 * envelope on the channel is the canonical copy, and `data` is what lets a
 * surface open it.
 */
export const AGENT_MESSAGE_NOTIFICATION_KIND = "agent.message";

export const TEMPLATE_UPDATE_NOTIFICATION_KIND = "workspace.template-update";

/** The producer supplies the review request; opening it starts an ordinary
 * agent conversation and grants no publication authority. */
export function templateUpdateNotificationPrompt(notification: UserNotification): string | null {
  if (notification.kind !== TEMPLATE_UPDATE_NOTIFICATION_KIND) return null;
  const data = notification.data;
  if (!data || typeof data !== "object") return null;
  const prompt = (data as { prompt?: unknown }).prompt;
  return typeof prompt === "string" && prompt.trim() ? prompt : null;
}

export interface AgentMessageNotificationData {
  channelId: string;
  channelTargetId: string;
  /**
   * The sender's message id — deliberately the correlation key the channel's
   * read receipts already use, so "the user read it" and "the entry retires"
   * are the same fact rather than two ids that can drift (plan D16).
   */
  messageId: string;
  senderParticipantId: string;
  senderHandle?: string;
  /** The rung the sender chose: "inbox" or "interrupt". */
  rung: "inbox" | "interrupt";
}

/** The OS notification category of a pushed inbox entry; iOS draws actions only for categories registered at launch. */
export const USER_INBOX_CATEGORY = "vibestudio-user-inbox";
/** The category of a pushed inbox entry that carries a reply action. */
export const USER_INBOX_REPLY_CATEGORY = "vibestudio-user-inbox-reply";

/** `open` is the press on the notification body, never a producer action. */
const RESERVED_USER_INBOX_ACTION_IDS: ReadonlySet<string> = new Set(["open"]);
export const USER_INBOX_ACTIONS_MAX = 3;

/**
 * Reply actions of a pushed inbox entry. Each draws a native reply field; the
 * device posts the typed text, as the person, into the entry's conversation
 * (`channelTargetId`) with no client running.
 */
export const UserInboxActionsSchema = z
  .array(
    z
      .object({
        id: z.string().min(1),
        title: z.string().min(1),
        input: z.literal("text"),
      })
      .strict()
  )
  .min(1)
  .max(USER_INBOX_ACTIONS_MAX)
  .superRefine((actions, ctx) => {
    const seen = new Set<string>();
    for (const [index, action] of actions.entries()) {
      if (RESERVED_USER_INBOX_ACTION_IDS.has(action.id) || seen.has(action.id)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "id"],
          message: `Action id "${action.id}" is reserved or repeated`,
        });
      }
      seen.add(action.id);
    }
  });
export type UserInboxAction = z.infer<typeof UserInboxActionsSchema>[number];

/** The actions a push's `actionsJson` carries; null when absent or invalid. */
export function readUserInboxActions(raw: unknown): UserInboxAction[] | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = UserInboxActionsSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * FCM data payload for a pushed inbox entry (messaging plan §4.5 step 5,
 * §4.10.9). Values are strings because FCM data maps are string-only. The
 * device deep-links to the producer-owned channel target and envelope, then
 * acknowledges `notificationId` — the same acknowledgement any other surface
 * would make.
 */
export type PushUserInboxDataPayload = import("./workspacePushScope.js").WorkspacePushScope & {
  kind: "user-inbox";
  notificationId: string;
  inboxKind: string;
  title: string;
  body?: string;
  priority: "normal" | "high";
  channelId?: string;
  channelTargetId?: string;
  messageId?: string;
  senderParticipantId?: string;
  senderHandle?: string;
  /** JSON of `UserInboxAction[]` (FCM data is string-only); requires `channelTargetId`. */
  actionsJson?: string;
};

export function isPushUserInboxDataPayload(value: unknown): value is PushUserInboxDataPayload {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const base =
    readWorkspacePushScope(record) !== null &&
    record["kind"] === "user-inbox" &&
    typeof record["notificationId"] === "string" &&
    typeof record["title"] === "string";
  if (!base) return false;
  if (record["actionsJson"] !== undefined) {
    const target = record["channelTargetId"];
    if (
      readUserInboxActions(record["actionsJson"]) === null ||
      typeof target !== "string" ||
      !target.trim()
    ) {
      return false;
    }
  }
  return (
    record["inboxKind"] !== AGENT_MESSAGE_NOTIFICATION_KIND ||
    (typeof record["channelTargetId"] === "string" && record["channelTargetId"].trim().length > 0)
  );
}

export function agentMessageNotificationId(messageId: string, userId: string): string {
  // Per-target dedup: a redriven notify re-writes the same entry rather than
  // producing a second one (plan §4.3).
  return `${AGENT_MESSAGE_NOTIFICATION_KIND}:${messageId}:${userId}`;
}

export function agentMessageNotificationData(
  notification: UserNotification
): AgentMessageNotificationData | null {
  if (notification.kind !== AGENT_MESSAGE_NOTIFICATION_KIND) return null;
  const data = notification.data;
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const channelId = record["channelId"];
  const channelTargetId = record["channelTargetId"];
  const messageId = record["messageId"];
  const senderParticipantId = record["senderParticipantId"];
  if (
    typeof channelId !== "string" ||
    typeof channelTargetId !== "string" ||
    !channelTargetId.trim() ||
    typeof messageId !== "string" ||
    typeof senderParticipantId !== "string"
  ) {
    return null;
  }
  const handle = record["senderHandle"];
  return {
    channelId,
    channelTargetId,
    messageId,
    senderParticipantId,
    ...(typeof handle === "string" ? { senderHandle: handle } : {}),
    rung: record["rung"] === "interrupt" ? "interrupt" : "inbox",
  };
}

export function channelInviteNotificationId(channelId: string): string {
  return `channel.invite:${channelId}`;
}

export function channelInviteNotification(
  invite: ChannelInvite,
  revision: number
): UserNotification {
  return {
    id: channelInviteNotificationId(invite.channelId),
    userId: invite.userId,
    kind: CHANNEL_INVITE_NOTIFICATION_KIND,
    title: "Channel invitation",
    message: `You were invited to ${invite.channelId}.`,
    data: invite,
    createdAt: invite.addedAt,
    revision,
  };
}

export function channelInviteFromNotification(
  notification: UserNotification
): ChannelInvite | null {
  if (notification.kind !== CHANNEL_INVITE_NOTIFICATION_KIND) return null;
  const value = notification.data;
  const parsed = ChannelInviteSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
