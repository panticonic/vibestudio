/**
 * Notification surface of the client <-> host wire (capability `notifications`).
 *
 * The host owns every device-level part of push: the OS permission, the
 * FCM/APNs token and its refresh, the stable device id used to register that
 * token, displaying incoming pushes, and capturing what the person does with a
 * notification (including lock-screen actions while no client runs). A client
 * learns the token and registers it with each workspace it is connected to,
 * and is told when a notification was opened so it can navigate.
 *
 * Kept in its own module: the notification port owns this file's contents.
 */
import type { ClientCapability } from "@vibestudio/workspace-contracts/clients";
import type { WorkspaceApprovalTarget } from "@vibestudio/shared/workspacePushScope";
import type { PushUserInboxDataPayload } from "@vibestudio/shared/userNotifications";

export interface NotificationsStatus {
  /** Firebase/APNs is configured in this host build. */
  configured: boolean;
  permission: "granted" | "denied" | "undetermined";
  /** The current push token, once the host has one. */
  token: string | null;
  platform: "android" | "ios";
  /** Stable per-device id the server keys this device's registrations by. */
  deviceClientId: string;
}

/** A local notification a client asks the host to show. */
export interface LocalNotification {
  id: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface DisplayedNotification {
  id: string;
  data: Record<string, unknown>;
}

/** What the person opened. */
export type NotificationOpen =
  | { kind: "approval"; target: WorkspaceApprovalTarget }
  | { kind: "inbox"; payload: PushUserInboxDataPayload };

export interface NotificationsHostMethods {
  "notifications.status": { args: []; result: NotificationsStatus };
  "notifications.requestPermission": { args: []; result: boolean };
  "notifications.display": { args: [notification: LocalNotification]; result: void };
  "notifications.cancel": { args: [id: string]; result: void };
  "notifications.displayed": { args: []; result: DisplayedNotification[] };
  /** The notification that launched this instance, if it was started by one. */
  "notifications.takeInitialOpen": { args: []; result: NotificationOpen | null };
}

export type NotificationsHostEvent =
  | { type: "notification-token"; token: string }
  | { type: "notification-open"; open: NotificationOpen };

export const NOTIFICATIONS_METHOD_CAPABILITY: Readonly<
  Record<keyof NotificationsHostMethods, ClientCapability>
> = {
  "notifications.status": "notifications",
  "notifications.requestPermission": "notifications",
  "notifications.display": "notifications",
  "notifications.cancel": "notifications",
  "notifications.displayed": "notifications",
  "notifications.takeInitialOpen": "notifications",
};
