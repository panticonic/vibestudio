/**
 * NotificationBar — centralized notification display in the shell chrome area.
 *
 * Renders between TitleBar and the panel viewport. Normal DOM flow resizes the
 * measured native panel surface below it.
 *
 * Supports notification types: info/success/warning/error as auto-dismissing
 * toast banners. Consent prompts are handled by ConsentDialog.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { Flex, Text, Button, Badge } from "@radix-ui/themes";
import {
  InfoCircledIcon,
  CheckCircledIcon,
  ExclamationTriangleIcon,
  CrossCircledIcon,
  Cross2Icon,
  LockClosedIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from "@radix-ui/react-icons";
import { useShellEvent } from "../shell/useShellEvent";
import { useDirectShellEvent } from "../shell/useDirectShellEvent";
import {
  app,
  browserEnvironment,
  extensions,
  notification,
  panel,
  workspaceUnits,
} from "../shell/client";
import type { NotificationPayload } from "@vibestudio/shared/events";
import { assertPresent } from "../utils/assertPresent";

/** Default TTLs by notification type (ms). 0 = no auto-dismiss. */
const DEFAULT_TTLS: Record<NotificationPayload["type"], number> = {
  info: 5000,
  success: 3000,
  warning: 8000,
  error: 0,
  consent: 0,
};

// Map onto the unified semantic-intent tokens (tokens.css) so notifications,
// the approval bar, and chat all speak ONE color vocabulary in both themes.
const TYPE_BG: Record<NotificationPayload["type"], string> = {
  info: "var(--intent-info-surface)",
  success: "var(--intent-success-surface)",
  warning: "var(--intent-warning-surface)",
  error: "var(--intent-error-surface)",
  consent: "var(--intent-consent-surface)",
};

const TYPE_BORDER: Record<NotificationPayload["type"], string> = {
  info: "var(--intent-info-border)",
  success: "var(--intent-success-border)",
  warning: "var(--intent-warning-border)",
  error: "var(--intent-error-border)",
  consent: "var(--intent-consent-border)",
};

function TypeIcon({ type }: { type: NotificationPayload["type"] }) {
  switch (type) {
    case "info":
      return <InfoCircledIcon />;
    case "success":
      return <CheckCircledIcon />;
    case "warning":
      return <ExclamationTriangleIcon />;
    case "error":
      return <CrossCircledIcon />;
    case "consent":
      return <LockClosedIcon />;
  }
}

function panelOpenInstruction(value: unknown): {
  source: string;
  stateArgs?: Record<string, unknown>;
  name?: string;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const openPanel = (value as Record<string, unknown>)["openPanel"];
  if (!openPanel || typeof openPanel !== "object" || Array.isArray(openPanel)) return null;
  const record = openPanel as Record<string, unknown>;
  if (typeof record["source"] !== "string") return null;
  const stateArgs =
    record["stateArgs"] &&
    typeof record["stateArgs"] === "object" &&
    !Array.isArray(record["stateArgs"])
      ? (record["stateArgs"] as Record<string, unknown>)
      : undefined;
  return {
    source: record["source"],
    ...(typeof record["name"] === "string" ? { name: record["name"] } : {}),
    ...(stateArgs ? { stateArgs } : {}),
  };
}

export function NotificationBar() {
  const [notifications, setNotifications] = useState<Map<string, NotificationPayload>>(new Map());
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const timerCleanups = useRef<Map<string, () => void>>(new Map());
  const barRef = useRef<HTMLDivElement>(null);

  const showNotification = useCallback((payload: NotificationPayload) => {
    setNotifications((prev) => {
      const next = new Map(prev);
      next.set(payload.id, payload);
      return next;
    });
  }, []);

  // Host notifications are watched broadcasts; server notifications addressed
  // to this account arrive on the authenticated session. Keep the delivery
  // contracts explicit instead of folding direct events into EventsClient.
  useShellEvent("notification:show", showNotification);
  useDirectShellEvent("notification:show", showNotification);

  const dismissNotification = useCallback((id: string) => {
    setNotifications((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    setExpandedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    const cleanup = timerCleanups.current.get(id);
    if (cleanup) {
      cleanup();
      timerCleanups.current.delete(id);
    }
    // Report dismissal to server so waitForAction() resolves immediately
    // instead of hanging for the full timeout
    void notification.reportAction(id, "dismiss");
  }, []);

  const handleDismissRequest = useCallback(
    (payload: { id: string }) => {
      dismissNotification(payload.id);
    },
    [dismissNotification]
  );

  useShellEvent("notification:dismiss", handleDismissRequest);
  useDirectShellEvent("notification:dismiss", handleDismissRequest);

  const handleAction = useCallback(
    async (notificationId: string, action: NonNullable<NotificationPayload["actions"]>[number]) => {
      const actionId = action.id;
      // Main-side actions can fail (updater unavailable, OAuth cancel while
      // disconnected). Keep the original notification visible in that case.
      try {
        await notification.reportAction(notificationId, actionId);
      } catch (err) {
        void notification.show({
          type: "error",
          title: "Action failed",
          message: err instanceof Error ? err.message : String(err),
          ttl: 0,
        });
        return;
      }
      if (action.command?.type === "app.applyUpdate") {
        const appId = action.command.appId;
        void app
          .applyUpdate(appId)
          .then((result) => {
            if (!result.applied) {
              void notification.show({
                type: "warning",
                title: "No pending update",
                message: `${appId} does not have a pending desktop update.`,
              });
            }
          })
          .catch((err) => {
            void notification.show({
              type: "error",
              title: "Update failed",
              message: err instanceof Error ? err.message : String(err),
              ttl: 0,
            });
          });
      } else if (action.command?.type === "app.rollback") {
        void workspaceUnits
          .rollback(action.command.appId, { buildKey: action.command.buildKey })
          .catch((err) => {
            void notification.show({
              type: "error",
              title: "Rollback failed",
              message: err instanceof Error ? err.message : String(err),
              ttl: 0,
            });
          });
      } else if (action.command?.type === "workspace.restartUnit") {
        void workspaceUnits.restart(action.command.name).catch((err) => {
          void notification.show({
            type: "error",
            title: "Restart failed",
            message: err instanceof Error ? err.message : String(err),
            ttl: 0,
          });
        });
      }
      if (action.invoke?.kind === "extension") {
        void extensions
          .invoke(action.invoke.extension, action.invoke.method, action.invoke.args ?? [])
          .then((result) => {
            const open = panelOpenInstruction(result);
            if (open) {
              return panel.createPanel(open.source, {
                name: open.name,
                stateArgs: open.stateArgs,
              });
            }
            return undefined;
          })
          .catch((err) => {
            void notification.show({
              type: "error",
              title: "Action failed",
              message: err instanceof Error ? err.message : String(err),
              ttl: 0,
            });
          });
      } else if (action.command?.type === "browser.downloadOpen") {
        void browserEnvironment.openDownload(action.command.downloadId);
      } else if (action.command?.type === "browser.downloadReveal") {
        void browserEnvironment.revealDownload(action.command.downloadId);
      } else if (action.command?.type === "panel.focus") {
        void panel.focus(action.command.panelId);
      }
      dismissNotification(notificationId);
    },
    [dismissNotification]
  );

  // Auto-dismiss timers
  useEffect(() => {
    for (const [id, notif] of notifications) {
      if (timerCleanups.current.has(id)) continue;
      const ttl = notif.ttl ?? DEFAULT_TTLS[notif.type];
      if (ttl <= 0) continue;

      const timer = setTimeout(() => {
        dismissNotification(id);
      }, ttl);
      const cleanup = () => {
        clearTimeout(timer);
        timerCleanups.current.delete(id);
      };
      timerCleanups.current.set(id, cleanup);
    }

    // Clean up timers for removed notifications
    for (const [id, cleanup] of timerCleanups.current) {
      if (!notifications.has(id)) {
        cleanup();
      }
    }
  }, [notifications, dismissNotification]);

  // Clean up all timers on unmount
  useEffect(() => {
    return () => {
      for (const cleanup of timerCleanups.current.values()) {
        cleanup();
      }
    };
  }, []);

  const isVisible = notifications.size > 0;
  if (!isVisible) return null;

  // Keep persistent failures visible ahead of routine transient confirmations.
  const entries = Array.from(notifications.values());
  const priority: Record<NotificationPayload["type"], number> = {
    error: 5,
    warning: 4,
    consent: 3,
    info: 2,
    success: 1,
  };
  const current = assertPresent(
    entries.reduce((best, entry) => (priority[entry.type] >= priority[best.type] ? entry : best))
  );
  const queuedNotifications = entries.filter((entry) => entry.id !== current.id).reverse();
  const expanded = expandedIds.has(current.id);
  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div ref={barRef} data-shell-top-chrome="notification-bar">
      <ToastNotification
        notification={current}
        queuedNotifications={queuedNotifications}
        expanded={expanded}
        onToggleExpanded={toggleExpanded}
        onAction={handleAction}
        onDismiss={dismissNotification}
      />
    </div>
  );
}

// ---- Toast (info/success/warning/error) ----

function ToastNotification({
  notification,
  queuedNotifications,
  expanded,
  onToggleExpanded,
  onAction,
  onDismiss,
}: {
  notification: NotificationPayload;
  queuedNotifications: NotificationPayload[];
  expanded: boolean;
  onToggleExpanded: (id: string) => void;
  onAction: (id: string, action: NonNullable<NotificationPayload["actions"]>[number]) => void;
  onDismiss: (id: string) => void;
}) {
  const multilineMessage = notification.message?.includes("\n") ? notification.message : null;
  const summaryMessage = firstLine(notification.message);
  const hasExpandableContent =
    Boolean(multilineMessage) ||
    Boolean(notification.details?.length) ||
    Boolean(notification.history?.length) ||
    queuedNotifications.length > 0;

  return (
    <Flex
      direction="column"
      style={{
        backgroundColor: TYPE_BG[notification.type],
        borderBottom: `1px solid ${TYPE_BORDER[notification.type]}`,
        flexShrink: 0,
      }}
    >
      <Flex align="center" justify="between" px="3" py="2" gap="3" style={{ width: "100%" }}>
        <Flex align="center" gap="2" style={{ flex: 1, minWidth: 0 }}>
          {notification.iconDataUrl ? (
            <img
              src={notification.iconDataUrl}
              width={20}
              height={20}
              alt=""
              style={{ borderRadius: 4, flexShrink: 0 }}
            />
          ) : (
            <TypeIcon type={notification.type} />
          )}
          <Text size="2" weight="bold" truncate>
            {notification.title}
          </Text>
          {summaryMessage && (
            <Text size="2" color="gray" truncate>
              {summaryMessage}
            </Text>
          )}
          {queuedNotifications.length > 0 && (
            <Badge size="1" variant="soft">
              +{queuedNotifications.length}
            </Badge>
          )}
        </Flex>
        <Flex gap="2" align="center" style={{ flexShrink: 0 }}>
          {hasExpandableContent && (
            <Button
              size="1"
              variant="ghost"
              aria-expanded={expanded}
              onClick={() => onToggleExpanded(notification.id)}
            >
              {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
              Details
            </Button>
          )}
          {notification.actions?.map((action) => (
            <Button
              key={action.id}
              size="1"
              variant={action.variant ?? "soft"}
              onClick={() => onAction(notification.id, action)}
            >
              {action.label}
            </Button>
          ))}
          <Button
            size="1"
            variant="ghost"
            aria-label="Dismiss notification"
            onClick={() => onDismiss(notification.id)}
          >
            <Cross2Icon />
          </Button>
        </Flex>
      </Flex>
      {expanded && hasExpandableContent && (
        <NotificationDetails
          notification={notification}
          multilineMessage={multilineMessage}
          queuedNotifications={queuedNotifications}
        />
      )}
    </Flex>
  );
}

function NotificationDetails({
  notification,
  multilineMessage,
  queuedNotifications,
}: {
  notification: NotificationPayload;
  multilineMessage: string | null;
  queuedNotifications: NotificationPayload[];
}) {
  return (
    <div
      data-testid="notification-details-pane"
      style={{
        width: "100%",
        maxHeight: 280,
        overflowY: "auto",
        borderTop: `1px solid ${TYPE_BORDER[notification.type]}`,
        padding: "8px 12px 10px",
      }}
    >
      <Flex direction="column" gap="2">
        {multilineMessage && <DiagnosticBlock title="Message" value={multilineMessage} mono />}
        {notification.details?.map((detail) => (
          <DiagnosticBlock
            key={`${detail.label}:${detail.value}`}
            title={detail.label}
            value={detail.value}
            mono={detail.mono}
          />
        ))}
        {notification.history?.length ? (
          <Flex direction="column" gap="2">
            <Text size="1" weight="bold" color="gray">
              Recent errors
            </Text>
            {notification.history.map((item, index) => (
              <div
                key={`${item.timestamp ?? index}:${item.title ?? ""}`}
                style={{
                  border: "1px solid var(--gray-6)",
                  borderRadius: 6,
                  padding: "7px 8px",
                  background: "color-mix(in srgb, var(--gray-1) 72%, transparent)",
                }}
              >
                <Flex direction="column" gap="1">
                  <Text size="1" weight="bold">
                    {item.title ?? `Error ${index + 1}`}
                    {item.timestamp ? ` · ${new Date(item.timestamp).toLocaleTimeString()}` : ""}
                  </Text>
                  <DiagnosticValue value={item.message} mono />
                  {item.details?.map((detail) => (
                    <DiagnosticBlock
                      key={`${index}:${detail.label}:${detail.value}`}
                      title={detail.label}
                      value={detail.value}
                      mono={detail.mono}
                    />
                  ))}
                </Flex>
              </div>
            ))}
          </Flex>
        ) : null}
        {queuedNotifications.length > 0 && (
          <Flex direction="column" gap="2">
            <Text size="1" weight="bold" color="gray">
              Other notifications
            </Text>
            {queuedNotifications.map((queued) => (
              <div
                key={queued.id}
                style={{
                  border: "1px solid var(--gray-6)",
                  borderRadius: 6,
                  padding: "7px 8px",
                  background: "color-mix(in srgb, var(--gray-1) 72%, transparent)",
                }}
              >
                <Text size="1" weight="bold">
                  {queued.title}
                </Text>
                {queued.message ? <DiagnosticValue value={queued.message} /> : null}
              </div>
            ))}
          </Flex>
        )}
      </Flex>
    </div>
  );
}

function DiagnosticBlock({ title, value, mono }: { title: string; value: string; mono?: boolean }) {
  return (
    <Flex direction="column" gap="1">
      <Text size="1" weight="bold" color="gray">
        {title}
      </Text>
      <DiagnosticValue value={value} mono={mono} />
    </Flex>
  );
}

function DiagnosticValue({ value, mono }: { value: string; mono?: boolean }) {
  return (
    <Text
      as="div"
      size="1"
      style={{
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        fontFamily: mono ? "var(--font-mono)" : undefined,
        lineHeight: 1.45,
      }}
    >
      {value}
    </Text>
  );
}

function firstLine(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.split(/\r?\n/, 1)[0];
}
