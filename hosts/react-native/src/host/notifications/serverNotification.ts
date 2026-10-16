import {
  readWorkspacePushScope,
  type WorkspacePushScope,
} from "@vibestudio/shared/workspacePushScope";

/**
 * A server-defined notification pushed to this device (docs/client-hosts-and-clients-plan.md
 * 4.7.3): the producer names the notification and its actions, the host draws
 * them natively and returns the person's choice, with reply text for an action
 * that takes input, through `notification.reportAction`. No client runs for
 * any of it, so a reply typed on a lock screen works while every client is closed.
 *
 * Push data is a string map, so the actions travel as one JSON string:
 * `{ kind: "server-notification", serverId, workspaceId, userId, notificationId,
 * title, body?, actionsJson }`.
 */
export const SERVER_NOTIFICATION_KIND = "server-notification";

export interface ServerNotificationAction {
  id: string;
  title: string;
  /** `text` draws a reply field and reports what was typed. */
  input?: "text";
}

export interface ServerNotification {
  scope: WorkspacePushScope;
  notificationId: string;
  title: string;
  body: string;
  actions: ServerNotificationAction[];
}

/** `open` is the press on the notification body, never a producer action. */
const RESERVED_ACTION_IDS: ReadonlySet<string> = new Set(["open"]);

function readActions(raw: unknown): ServerNotificationAction[] | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const actions: ServerNotificationAction[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") return null;
    const { id, title, input } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !id || RESERVED_ACTION_IDS.has(id)) return null;
    if (typeof title !== "string" || !title) return null;
    if (input !== undefined && input !== "text") return null;
    if (actions.some((action) => action.id === id)) return null;
    actions.push({ id, title, ...(input === "text" ? { input } : {}) });
  }
  return actions;
}

/** The notification a push or a notification event's data describes; null when it is not a valid one. */
export function readServerNotification(data: unknown): ServerNotification | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (record["kind"] !== SERVER_NOTIFICATION_KIND) return null;
  const scope = readWorkspacePushScope(record);
  const { notificationId, title, body } = record;
  if (!scope || typeof notificationId !== "string" || !notificationId) return null;
  if (typeof title !== "string" || !title) return null;
  if (body !== undefined && typeof body !== "string") return null;
  const actions = readActions(record["actionsJson"]);
  if (!actions) return null;
  return { scope, notificationId, title, body: body ?? "", actions };
}

/** The action as notifee draws it on Android; an input action carries a reply field. */
export function androidServerActions(
  actions: readonly ServerNotificationAction[]
): Array<{
  title: string;
  pressAction: { id: string };
  input?: { placeholder: string; allowFreeFormInput: true };
}> {
  return actions.map((action) => ({
    title: action.title,
    pressAction: { id: action.id },
    ...(action.input === "text"
      ? { input: { placeholder: action.title, allowFreeFormInput: true as const } }
      : {}),
  }));
}
