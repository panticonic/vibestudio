import type { NotificationAction } from "@vibestudio/shared/events";

/** A server notification with an action that takes reply text. */
export interface ReplyNotification {
  id: string;
  title: string;
  message: string;
  action: Pick<NotificationAction, "id" | "label">;
}

/** The first reply-taking action of a `notification:show` payload, or null when it has none. */
export function replyNotificationOf(payload: unknown): ReplyNotification | null {
  if (typeof payload !== "object" || payload === null) return null;
  const notification = payload as {
    id?: unknown;
    title?: unknown;
    message?: unknown;
    actions?: unknown;
  };
  if (typeof notification.id !== "string" || !Array.isArray(notification.actions)) return null;
  const action = notification.actions.find(
    (candidate): candidate is NotificationAction =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as NotificationAction).input === "text" &&
      typeof (candidate as NotificationAction).id === "string"
  );
  if (!action) return null;
  return {
    id: notification.id,
    title: typeof notification.title === "string" ? notification.title : "",
    message: typeof notification.message === "string" ? notification.message : "",
    action: { id: action.id, label: typeof action.label === "string" ? action.label : "Reply" },
  };
}

/** The subset of Electron's `Notification` the reply relay uses. */
export interface NativeReplyNotification {
  on(event: "reply", listener: (event: unknown, reply: string) => void): unknown;
  on(event: "click", listener: () => void): unknown;
  show(): void;
}

export interface NativeReplyDeps {
  platform: NodeJS.Platform;
  isSupported(): boolean;
  create(options: {
    title: string;
    body: string;
    hasReply: true;
    replyPlaceholder: string;
  }): NativeReplyNotification;
  /** Report the person's reply through `notification.reportAction(id, actionId, text)`. */
  report(id: string, actionId: string, text: string): Promise<void>;
  /** The reply was delivered; the in-app copy of the notification is retired. */
  replied(id: string): void;
  failed(id: string, error: unknown): void;
  focus(): void;
}

/**
 * Show a server notification whose action takes text as a native notification
 * with a reply field, and report the reply as the action. Only macOS renders a
 * reply field in a system notification: on every other platform the in-app
 * notification bar carries the reply affordance and this does nothing.
 * Returns whether a native notification was shown.
 */
export function showNativeReplyNotification(
  notification: ReplyNotification,
  deps: NativeReplyDeps
): boolean {
  if (deps.platform !== "darwin" || !deps.isSupported()) return false;
  const native = deps.create({
    title: notification.title,
    body: notification.message,
    hasReply: true,
    replyPlaceholder: notification.action.label,
  });
  native.on("reply", (_event, reply) => {
    void deps.report(notification.id, notification.action.id, reply).then(
      () => deps.replied(notification.id),
      (error: unknown) => deps.failed(notification.id, error)
    );
  });
  native.on("click", () => deps.focus());
  native.show();
  return true;
}
