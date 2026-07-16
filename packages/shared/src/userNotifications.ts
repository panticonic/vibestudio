import type { ChannelInvite } from "./channelInvites.js";

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
}

export type PutUserNotificationInput = UserNotification;

export interface UserNotificationListResult {
  notifications: UserNotification[];
}

export interface UserNotificationAcknowledgementResult {
  acknowledged: boolean;
}

export const CHANNEL_INVITE_NOTIFICATION_KIND = "channel.invite";

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
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row["channelId"] !== "string" ||
    typeof row["userId"] !== "string" ||
    typeof row["memberId"] !== "string" ||
    typeof row["handle"] !== "string" ||
    typeof row["addedBy"] !== "string" ||
    typeof row["addedAt"] !== "number"
  ) {
    return null;
  }
  return {
    channelId: row["channelId"],
    userId: row["userId"],
    memberId: row["memberId"],
    handle: row["handle"],
    addedBy: row["addedBy"],
    addedAt: row["addedAt"],
  };
}
