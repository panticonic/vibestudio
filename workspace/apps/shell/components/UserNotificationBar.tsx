import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Flex, IconButton, Spinner, Text } from "@radix-ui/themes";
import { ChatBubbleIcon, Cross2Icon, InfoCircledIcon, ReloadIcon } from "@radix-ui/react-icons";
import {
  userNotifications,
  type ShellChannelInvite,
  type ShellUserNotification,
} from "../shell/client";
import { useDirectShellEvent } from "../shell/useDirectShellEvent";
import { useShellEvent } from "../shell/useShellEvent";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Durable account inbox surface. State is loaded once, refreshed by targeted
 * account events, and reconciled after host reconnect. There is no timer poll.
 */
export function UserNotificationBar() {
  const [notifications, setNotifications] = useState<ShellUserNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyNotificationId, setBusyNotificationId] = useState<string | null>(null);
  const [openedNotificationId, setOpenedNotificationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);

  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      const next = await userNotifications.list();
      if (requestVersion.current !== version) return;
      setNotifications(next);
      setError(null);
    } catch (cause) {
      if (requestVersion.current === version) setError(errorMessage(cause));
    } finally {
      if (requestVersion.current === version) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      requestVersion.current += 1;
    };
  }, [refresh]);

  useDirectShellEvent(
    "user-notifications-changed",
    useCallback(() => void refresh(), [refresh])
  );
  useShellEvent(
    "server-connection-changed",
    useCallback(
      ({ status }: { status: "connected" | "connecting" | "disconnected" }) => {
        if (status === "connected") void refresh();
      },
      [refresh]
    )
  );

  const removeLocal = useCallback((id: string) => {
    requestVersion.current += 1;
    setNotifications((current) => current.filter((notification) => notification.id !== id));
    setOpenedNotificationId((current) => (current === id ? null : current));
    setError(null);
  }, []);

  const dismiss = useCallback(
    async (notification: ShellUserNotification) => {
      setBusyNotificationId(notification.id);
      setError(null);
      try {
        // False means another device already acknowledged it; either way this
        // local snapshot is stale and should converge immediately.
        await userNotifications.acknowledge(notification.id);
        removeLocal(notification.id);
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setBusyNotificationId(null);
      }
    },
    [removeLocal]
  );

  const joinChannel = useCallback(
    async (notification: ShellUserNotification, invite: ShellChannelInvite) => {
      setBusyNotificationId(notification.id);
      setError(null);
      let opened = false;
      try {
        const created = await userNotifications.openChannel(invite.channelId);
        opened = true;
        setOpenedNotificationId(notification.id);
        window.dispatchEvent(
          new CustomEvent("shell-panel-created", { detail: { panelId: created.id } })
        );
        await userNotifications.acknowledge(notification.id);
        removeLocal(notification.id);
      } catch (cause) {
        const message = errorMessage(cause);
        setError(
          opened
            ? `Conversation opened, but the notification could not be cleared: ${message}`
            : message
        );
      } finally {
        setBusyNotificationId(null);
      }
    },
    [removeLocal]
  );

  if (notifications.length === 0) {
    if (!error || loading) return null;
    return (
      <Flex
        role="status"
        align="center"
        gap="2"
        px="3"
        py="1"
        style={{
          minHeight: 30,
          background: "var(--amber-a3)",
          borderBottom: "1px solid var(--amber-a6)",
        }}
      >
        <Text size="1" color="amber" style={{ flex: 1 }} title={error}>
          Notifications could not be loaded: {error}
        </Text>
        <Button size="1" variant="ghost" color="amber" onClick={() => void refresh()}>
          <ReloadIcon /> Retry
        </Button>
      </Flex>
    );
  }

  const notification = notifications[0]!;
  const invite = notification.channelInvite;
  const busy = busyNotificationId === notification.id;
  const opened = openedNotificationId === notification.id;
  const inviter = invite
    ? invite.inviter
      ? invite.inviter.displayName || `@${invite.inviter.handle}`
      : invite.addedBy.startsWith("user:")
        ? "a workspace member"
        : invite.addedBy
    : null;

  return (
    <Flex
      role="region"
      aria-label="User notifications"
      aria-live="polite"
      align="center"
      gap="2"
      px="3"
      py="1"
      wrap="wrap"
      style={{
        minHeight: 34,
        background: "var(--accent-a3)",
        borderBottom: "1px solid var(--accent-a6)",
      }}
    >
      {invite ? <ChatBubbleIcon aria-hidden /> : <InfoCircledIcon aria-hidden />}
      <Badge color="blue" variant="soft" radius="full">
        {invite ? "Invitation" : "Notification"}
      </Badge>
      <Text size="2" style={{ flex: "1 1 220px", minWidth: 0 }} truncate>
        <Text weight="medium">{invite?.channelTitle ?? notification.title}</Text>
        {invite ? <Text color="gray"> · invited by {inviter}</Text> : null}
        {!invite && notification.message ? (
          <Text color="gray"> · {notification.message}</Text>
        ) : null}
      </Text>
      {notifications.length > 1 ? (
        <Badge color="gray" variant="soft" title={`${notifications.length} pending notifications`}>
          +{notifications.length - 1}
        </Badge>
      ) : null}
      {error ? (
        <Text size="1" color="red" title={error}>
          {error}
        </Text>
      ) : null}
      {invite ? (
        <Button
          size="1"
          disabled={busy || opened}
          onClick={() => void joinChannel(notification, invite)}
        >
          {busy ? <Spinner size="1" /> : null}
          {opened ? "Opened" : "Join"}
        </Button>
      ) : null}
      <IconButton
        size="1"
        variant="ghost"
        color="gray"
        disabled={busy}
        onClick={() => void dismiss(notification)}
        aria-label={
          invite ? `Dismiss invitation to ${invite.channelTitle}` : `Dismiss ${notification.title}`
        }
      >
        <Cross2Icon />
      </IconButton>
    </Flex>
  );
}
