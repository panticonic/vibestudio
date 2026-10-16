import type { Call } from "./launch.js";

export interface NotificationAction {
  id: string;
  title: string;
  /** `text` renders a reply field. */
  input?: "text";
}

export interface ActionableNotification {
  notificationId: string;
  actions: NotificationAction[];
}

/** Return the person's choice on a notification to its producer (§4.7.3). */
export async function respondToNotification(
  call: Call,
  notificationId: string,
  actionId: string,
  text?: string
): Promise<void> {
  await call("notification", "respond", [
    notificationId,
    actionId,
    ...(text === undefined ? [] : [text]),
  ]);
}
