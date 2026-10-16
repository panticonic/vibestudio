import {
  APPROVAL_CATEGORY_BROWSER_PERMISSION,
  APPROVAL_CATEGORY_DECIDE,
  APPROVAL_CATEGORY_INPUT_REQUIRED,
  NOTIFICATION_ACTION_IDS_BROWSER_PERMISSION,
  NOTIFICATION_ACTION_IDS_INPUT_REQUIRED,
  NOTIFICATION_ACTION_IDS_STANDARD,
} from "@vibestudio/shared/approvalContract";
import { USER_INBOX_REPLY_CATEGORY, type UserInboxAction } from "@vibestudio/shared/userNotifications";

export const APPROVAL_NOTIFICATION_CHANNEL_ID = "approvals";
/** Escalated agent messages and other durable inbox entries (messaging plan §4.5). */
export const INBOX_NOTIFICATION_CHANNEL_ID = "messages";

export type NotificationActionId =
  | (typeof NOTIFICATION_ACTION_IDS_STANDARD)[number]
  | (typeof NOTIFICATION_ACTION_IDS_INPUT_REQUIRED)[number]
  | (typeof NOTIFICATION_ACTION_IDS_BROWSER_PERMISSION)[number];

export interface NotificationActionDefinition {
  id: NotificationActionId;
  title: string;
  foreground?: boolean;
  destructive?: boolean;
}

export interface NotificationCategory {
  id: string;
  actions: Array<{
    id: string;
    title: string;
    foreground?: boolean;
    destructive?: boolean;
    /** The action draws a reply field (iOS `UNTextInputNotificationAction`). */
    input?: { placeholderText: string; buttonText: string };
    ios?: { foreground?: boolean; destructive?: boolean };
  }>;
}

const ACTION_COPY: Record<NotificationActionId, string> = {
  once: "Once",
  session: "Session",
  deny: "Deny",
  open: "Open",
  version: "Trust Version",
  always: "Always Allow",
  block: "Always Block",
};

export function getNotificationActionDefinitions(
  category: string | undefined
): NotificationActionDefinition[] {
  const ids =
    category === APPROVAL_CATEGORY_INPUT_REQUIRED
      ? NOTIFICATION_ACTION_IDS_INPUT_REQUIRED
      : category === APPROVAL_CATEGORY_BROWSER_PERMISSION
        ? NOTIFICATION_ACTION_IDS_BROWSER_PERMISSION
        : NOTIFICATION_ACTION_IDS_STANDARD;

  return ids.map((id) => ({
    id,
    title: ACTION_COPY[id],
    foreground: id === "open",
    destructive: id === "deny" || id === "block",
  }));
}

export function getAndroidNotificationActions(
  category: string | undefined,
  actionsJson?: string
): Array<{ title: string; pressAction: { id: string; launchActivity?: string } }> {
  const toAction = (action: { id: string; title: string }) => ({
    title: action.title,
    pressAction: {
      id: action.id,
      ...(action.id === "open" ? { launchActivity: "default" } : {}),
    },
  });
  const fallback = getNotificationActionDefinitions(category).map(toAction);
  if (!actionsJson) return fallback;

  try {
    const actions = JSON.parse(actionsJson) as unknown;
    if (!Array.isArray(actions)) return fallback;
    const parsed = actions
      .filter(
        (action): action is { id: string; title: string } =>
          typeof action === "object" &&
          action !== null &&
          typeof (action as { id?: unknown }).id === "string" &&
          typeof (action as { title?: unknown }).title === "string"
      )
      .map(toAction);
    return parsed.length > 0 ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** The actions of a reply entry as notifee draws them on Android: each carries a reply field (`RemoteInput`). */
export function androidReplyActions(actions: readonly UserInboxAction[]): Array<{
  title: string;
  pressAction: { id: string };
  input: { placeholder: string; allowFreeFormInput: true };
}> {
  return actions.map((action) => ({
    title: action.title,
    pressAction: { id: action.id },
    input: { placeholder: action.title, allowFreeFormInput: true as const },
  }));
}

/** The id of the one reply action iOS can draw: its category is fixed at launch, so the push cannot name others. */
export const IOS_REPLY_ACTION_ID = "reply";

/** The iOS categories notifee registers so the OS renders actions on a lock screen. */
export function notificationCategories(): NotificationCategory[] {
  return [
    {
      id: APPROVAL_CATEGORY_DECIDE,
      actions: getNotificationActionDefinitions(APPROVAL_CATEGORY_DECIDE).map((action) => ({
        id: action.id,
        title: action.title,
        foreground: action.foreground,
        destructive: action.destructive,
        ios: { foreground: action.foreground, destructive: action.destructive },
      })),
    },
    {
      id: APPROVAL_CATEGORY_INPUT_REQUIRED,
      actions: getNotificationActionDefinitions(APPROVAL_CATEGORY_INPUT_REQUIRED).map((action) => ({
        id: action.id,
        title: action.title,
        foreground: action.foreground,
        ios: { foreground: action.foreground },
      })),
    },
    {
      id: USER_INBOX_REPLY_CATEGORY,
      actions: [
        {
          id: IOS_REPLY_ACTION_ID,
          title: "Reply",
          input: { placeholderText: "Reply", buttonText: "Send" },
        },
      ],
    },
  ];
}
