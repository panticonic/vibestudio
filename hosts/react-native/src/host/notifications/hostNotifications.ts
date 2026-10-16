/**
 * Device-level push, owned by the host runtime (docs/client-hosts-and-clients-plan.md
 * 4.1, 4.7.3, 5.3): OS permission, the FCM/APNs token and its refresh, the
 * stable device client id, displaying incoming pushes, capturing presses and
 * lock-screen actions, and the queue of decisions taken while no workspace
 * connection was available. It runs with the process, independent of any
 * client, so approving from a lock screen needs no client JS runtime.
 *
 * Plain TypeScript over injected ports. `nativePorts.ts` wires the real
 * firebase / notifee / keychain / async-storage modules.
 */
import {
  APPROVAL_CATEGORY_DECIDE,
  type PushApprovalDataPayload,
} from "@vibestudio/shared/approvalContract";
import {
  readWorkspacePushScope,
  workspaceNotificationKey,
  type WorkspaceApprovalTarget,
  type WorkspacePushScope,
} from "@vibestudio/shared/workspacePushScope";
import {
  isPushUserInboxDataPayload,
  type PushUserInboxDataPayload,
} from "@vibestudio/shared/userNotifications";
import type {
  DisplayedNotification,
  LocalNotification,
  NotificationOpen,
  NotificationsHostEvent,
  NotificationsHostMethods,
  NotificationsStatus,
} from "@vibestudio/rn-client-api/notificationsProtocol";
import {
  APPROVAL_NOTIFICATION_CHANNEL_ID,
  INBOX_NOTIFICATION_CHANNEL_ID,
  getAndroidNotificationActions,
  notificationCategories,
  type NotificationCategory,
} from "./categories";
import {
  androidServerActions,
  readServerNotification,
  type ServerNotification,
} from "./serverNotification";
import {
  enqueueAction,
  isBackgroundDecision,
  loadOpen,
  loadPendingActions,
  readApprovalTarget,
  sameApprovalTarget,
  sameQueuedAction,
  serializeOpen,
  serializePendingActions,
  type BackgroundApprovalDecision,
  type QueuedBackgroundAction,
} from "./actionQueue";

export const SYNCING_NOTIFICATION_BODY = "Sent — syncing…";
export const ACTION_QUEUE_KEY = "vibestudio:push:queued-actions";
export const PENDING_OPEN_KEY = "vibestudio:push:pending-open";

export type NotificationPermission = NotificationsStatus["permission"];
export type Unsubscribe = () => void;

/** The remote message fields the host reads. */
export interface RemoteMessage {
  notification?: { title?: string; body?: string };
  data?: Record<string, string | undefined>;
}

/** What notifee is asked to show. */
export interface DeviceNotification {
  id: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  android?: Record<string, unknown>;
  ios?: Record<string, unknown>;
}

/** A press on a notification or on one of its actions, as notifee reports it. */
export interface NotificationEvent {
  kind: "press" | "action" | "other";
  /** The action's id when `kind` is `"action"`. */
  actionId?: string;
  /** What was typed into the action's reply field, for an action that takes input. */
  input?: string;
  notification?: Partial<DeviceNotification>;
}

export interface FirebaseMessagingPort {
  /** Current OS permission without prompting. */
  permission(): Promise<NotificationPermission>;
  /** Prompt (once, per the OS) and report the outcome. */
  requestPermission(): Promise<NotificationPermission>;
  getToken(): Promise<string>;
  onTokenRefresh(listener: (token: string) => void): Unsubscribe;
  onMessage(listener: (message: RemoteMessage) => void): Unsubscribe;
  /** A system-tray FCM notification was pressed while the app was backgrounded. */
  onNotificationOpenedApp(listener: (message: RemoteMessage) => void): Unsubscribe;
  /** The FCM notification that cold-started the app. */
  getInitialNotification(): Promise<RemoteMessage | null>;
  /** Replaces any earlier handler; there is no way to remove one. */
  setBackgroundMessageHandler(handler: (message: RemoteMessage) => Promise<void>): void;
}

export interface NotifeePort {
  requestPermission(): Promise<void>;
  createChannel(channel: { id: string; name: string; important: boolean }): Promise<void>;
  setNotificationCategories(categories: NotificationCategory[]): Promise<void>;
  display(notification: DeviceNotification): Promise<void>;
  cancel(id: string): Promise<void>;
  displayed(): Promise<Array<{ id: string; data: Record<string, unknown> }>>;
  onForegroundEvent(listener: (event: NotificationEvent) => Promise<void>): Unsubscribe;
  /** Replaces any earlier handler; there is no way to remove one. */
  onBackgroundEvent(listener: (event: NotificationEvent) => Promise<void>): void;
}

export interface KeyValuePort {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** Secure storage of the stable device client id the server keys this device's registrations by. */
export interface DeviceIdPort {
  get(): Promise<string | null>;
  set(id: string): Promise<void>;
}

export interface HostNotificationsPorts {
  messaging: FirebaseMessagingPort;
  notifee: NotifeePort;
  store: KeyValuePort;
  deviceId: DeviceIdPort;
  platform: "android" | "ios";
  /** Firebase/APNs is configured in this build. When false the host does nothing and reports `configured: false`. */
  isConfigured(): boolean;
  /**
   * Resolve an approval in its own workspace. Rejects when that workspace has
   * no usable connection (or the server refuses); the decision then stays
   * queued and is retried by the next `drain()`.
   */
  decide(target: WorkspaceApprovalTarget, decision: BackgroundApprovalDecision): Promise<void>;
  /**
   * Return the person's choice on a server-defined notification, with reply
   * text for an action that takes input, to its producer in that workspace
   * (`notification.reportAction`). Rejects when the workspace has no usable
   * connection or the server refuses.
   */
  reportAction(
    scope: WorkspacePushScope,
    notificationId: string,
    actionId: string,
    text?: string
  ): Promise<void>;
  now?(): number;
}

/**
 * A listener returns `true` when it handed the event to a running client. An
 * open that no listener delivered is kept and returned by `takeInitialOpen`.
 */
export type HostNotificationsListener = (event: NotificationsHostEvent) => boolean | void;

type HandlerOf<K extends keyof NotificationsHostMethods> = (
  ...args: NotificationsHostMethods[K]["args"]
) => Promise<NotificationsHostMethods[K]["result"]>;

export type NotificationsHandlers = { [K in keyof NotificationsHostMethods]: HandlerOf<K> };

export interface HostNotifications {
  /** The `notifications.*` host methods, keyed by wire method name. */
  handlers: NotificationsHandlers;
  /**
   * Register the FCM/notifee listeners and the background handlers, then do
   * the one-time setup (channels, categories, the launch notification). The
   * listeners are all registered before the first `await`, so calling this at
   * host-runtime start, before any client exists, loses no push.
   */
  start(): Promise<void>;
  /** Remove the listeners that can be removed. */
  stop(): void;
  onEvent(listener: HostNotificationsListener): Unsubscribe;
  /** Resolve every queued decision whose workspace is reachable. Call when a workspace connection becomes available. */
  drain(): Promise<void>;
}

const LOG = "[HostNotifications]";

export function createHostNotifications(ports: HostNotificationsPorts): HostNotifications {
  const { messaging, notifee, store, platform } = ports;
  const now = ports.now ?? Date.now;
  const listeners = new Set<HostNotificationsListener>();
  let subscriptions: Unsubscribe[] = [];
  let started = false;
  let token: string | null = null;
  let deviceId: Promise<string> | null = null;

  // Storage is read-modify-write from several entry points (presses, drain,
  // takeInitialOpen); one chain serializes it. It is never held across a
  // `decide` call.
  let storageChain: Promise<unknown> = Promise.resolve();
  function mutate<T>(task: () => Promise<T>): Promise<T> {
    const next = storageChain.then(task);
    storageChain = next.catch(() => undefined);
    return next;
  }
  // Two drains would both submit the same queued decision.
  let drainChain: Promise<unknown> = Promise.resolve();

  async function readActions(at = now()): Promise<QueuedBackgroundAction[]> {
    return loadPendingActions(await store.getItem(ACTION_QUEUE_KEY), at);
  }
  async function writeActions(actions: QueuedBackgroundAction[]): Promise<void> {
    if (actions.length === 0) await store.removeItem(ACTION_QUEUE_KEY);
    else await store.setItem(ACTION_QUEUE_KEY, serializePendingActions(actions));
  }
  function pendingActions(): Promise<QueuedBackgroundAction[]> {
    return mutate(async () => {
      const actions = await readActions();
      await writeActions(actions);
      return actions;
    });
  }

  // ---- device identity ----
  function getDeviceClientId(): Promise<string> {
    deviceId ??= (async () => {
      try {
        const existing = await ports.deviceId.get();
        if (existing) return existing;
      } catch {
        // Keychain unavailable: fall through to generate.
      }
      const id = `device-${platform}-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        await ports.deviceId.set(id);
      } catch {
        // The id works for this session but will not persist.
      }
      return id;
    })();
    return deviceId;
  }

  // ---- events ----
  function emit(event: NotificationsHostEvent): boolean {
    let delivered = false;
    for (const listener of [...listeners]) {
      try {
        if (listener(event) === true) delivered = true;
      } catch (error) {
        console.error(`${LOG} event listener failed:`, error);
      }
    }
    return delivered;
  }

  /** The person opened a notification: tell a running client, otherwise keep it for the one that launches. */
  async function open(opened: NotificationOpen): Promise<void> {
    if (emit({ type: "notification-open", open: opened })) return;
    await mutate(() => store.setItem(PENDING_OPEN_KEY, serializeOpen(opened)));
  }

  function openFromMessage(message: RemoteMessage | null): NotificationOpen | null {
    if (!message) return null;
    if (isPushUserInboxDataPayload(message.data)) return { kind: "inbox", payload: message.data };
    const target = readApprovalTarget(message.data);
    return target ? { kind: "approval", target } : null;
  }

  // ---- display ----
  async function displayMessage(message: RemoteMessage): Promise<void> {
    if (isPushUserInboxDataPayload(message.data)) {
      await displayInbox(message.data, message);
      return;
    }
    const server = readServerNotification(message.data);
    if (server) {
      await displayServerNotification(server, message.data ?? {});
      return;
    }
    const data: Partial<PushApprovalDataPayload> = message.data ?? {};
    if (data.kind === "approval-cancel") {
      const cancelKey = data.cancelKey ?? data.approvalId;
      const scope = readWorkspacePushScope(data);
      if (cancelKey && scope) await notifee.cancel(workspaceNotificationKey(scope, cancelKey));
      return;
    }
    const target = readApprovalTarget(data);
    if (data.kind !== "approval-prompt" || !target) return;

    const category = data.category ?? APPROVAL_CATEGORY_DECIDE;
    await notifee.display({
      id: workspaceNotificationKey(target, data.cancelKey ?? target.approvalId),
      title: data.title ?? message.notification?.title ?? "Approval requested",
      body: data.body ?? message.notification?.body ?? "",
      data: { ...data, approvalId: data.approvalId, category },
      android: {
        channelId: APPROVAL_NOTIFICATION_CHANNEL_ID,
        pressAction: { id: "open", launchActivity: "default" },
        actions: getAndroidNotificationActions(category, data.actionsJson),
      },
      ios: { categoryId: category },
    });
  }

  /**
   * A pushed inbox entry (messaging plan 4.10.9). Its id is the durable entry's
   * id, so a redriven push replaces rather than stacks, and a press carries the
   * deep-link facts straight to the conversation.
   */
  async function displayInbox(data: PushUserInboxDataPayload, message: RemoteMessage): Promise<void> {
    await notifee.display({
      id: workspaceNotificationKey(data, data.notificationId),
      title: data.title || message.notification?.title || "New message",
      body: data.body ?? message.notification?.body ?? "",
      data: { ...data },
      android: {
        channelId: INBOX_NOTIFICATION_CHANNEL_ID,
        pressAction: { id: "open", launchActivity: "default" },
        ...(data.priority === "high" ? { importance: 4 } : {}),
      },
      ios: {},
    });
  }

  /**
   * A server-defined notification with its own actions. Android draws each
   * action, with a reply field where the producer asked for one. iOS can only
   * draw actions of categories registered at launch, so it shows the
   * notification without them.
   */
  async function displayServerNotification(
    notification: ServerNotification,
    data: Record<string, string | undefined>,
    body: string = notification.body
  ): Promise<void> {
    await notifee.display({
      id: workspaceNotificationKey(notification.scope, notification.notificationId),
      title: notification.title,
      body,
      data: { ...data },
      android: {
        channelId: INBOX_NOTIFICATION_CHANNEL_ID,
        pressAction: { id: "open", launchActivity: "default" },
        actions: androidServerActions(notification.actions),
      },
      ios: {},
    });
  }

  /**
   * The person chose an action of a server-defined notification. The choice
   * goes to the producer through the workspace's connection; success retires
   * the notification, and a failure is said on the notification itself with
   * its actions kept, so what was typed is never silently lost.
   */
  async function relayServerAction(
    notification: ServerNotification,
    data: Record<string, string | undefined>,
    event: NotificationEvent
  ): Promise<void> {
    const action = notification.actions.find((candidate) => candidate.id === event.actionId);
    if (!action) return;
    try {
      await ports.reportAction(
        notification.scope,
        notification.notificationId,
        action.id,
        action.input === "text" ? (event.input ?? "") : undefined
      );
    } catch (error) {
      console.warn(`${LOG} could not report ${action.id} for ${notification.notificationId}:`, error);
      await displayServerNotification(
        notification,
        data,
        `Not sent: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
    await notifee.cancel(workspaceNotificationKey(notification.scope, notification.notificationId));
  }

  async function showSyncing(
    target: WorkspaceApprovalTarget,
    notification: NotificationEvent["notification"]
  ): Promise<void> {
    await notifee.display({
      id: workspaceNotificationKey(target, target.approvalId),
      title: notification?.title ?? "Approval",
      body: SYNCING_NOTIFICATION_BODY,
      data: { ...notification?.data, ...target },
      android: notification?.android,
      ios: notification?.ios,
    });
  }

  // ---- queued decisions ----
  function drain(): Promise<void> {
    const run = drainChain.then(async () => {
      for (const action of await pendingActions()) {
        try {
          await ports.decide(action, action.decision);
        } catch (error) {
          console.warn(`${LOG} could not send queued decision for ${action.approvalId}:`, error);
          continue;
        }
        await mutate(async () =>
          writeActions((await readActions()).filter((current) => !sameQueuedAction(current, action)))
        );
        await notifee.cancel(workspaceNotificationKey(action, action.approvalId));
      }
    });
    drainChain = run.catch(() => undefined);
    return run;
  }

  async function handleNotificationEvent(event: NotificationEvent): Promise<void> {
    const notification = event.notification;
    const server = readServerNotification(notification?.data);
    if (server) {
      // Its press only brings the app forward; each action goes to its producer.
      if (event.kind === "action" && event.actionId !== "open") {
        await relayServerAction(server, notification?.data as Record<string, string | undefined>, event);
      }
      return;
    }
    const opens = event.kind === "press" || (event.kind === "action" && event.actionId === "open");
    if (isPushUserInboxDataPayload(notification?.data)) {
      if (opens) await open({ kind: "inbox", payload: notification.data });
      return;
    }
    const target = readApprovalTarget(notification?.data);
    if (!target) return;

    if (event.kind === "action" && isBackgroundDecision(event.actionId)) {
      const queuedAt = now();
      await mutate(async () =>
        writeActions(enqueueAction(await readActions(queuedAt), { ...target, decision: event.actionId as BackgroundApprovalDecision, queuedAt }, queuedAt))
      );
      await drain();
      const stillQueued = (await pendingActions()).some((entry) => sameApprovalTarget(entry, target));
      if (stillQueued) await showSyncing(target, notification);
      return;
    }
    if (opens) await open({ kind: "approval", target });
  }

  const guarded =
    <A>(what: string, run: (arg: A) => Promise<void>) =>
    (arg: A): Promise<void> =>
      run(arg).catch((error) => console.error(`${LOG} failed to ${what}:`, error));

  // ---- lifecycle ----
  async function requestPermission(): Promise<boolean> {
    if (!ports.isConfigured()) return false;
    const permission = await messaging.requestPermission();
    try {
      await notifee.requestPermission();
    } catch (error) {
      console.warn(`${LOG} local notification permission request failed:`, error);
    }
    return permission === "granted";
  }

  async function setUpDisplay(): Promise<void> {
    if (platform === "android") {
      for (const [id, name] of [
        [APPROVAL_NOTIFICATION_CHANNEL_ID, "Approvals"],
        [INBOX_NOTIFICATION_CHANNEL_ID, "Messages"],
      ] as const) {
        try {
          await notifee.createChannel({ id, name, important: true });
        } catch (error) {
          console.warn(`${LOG} failed to create the ${id} channel:`, error);
        }
      }
    }
    try {
      await notifee.setNotificationCategories(notificationCategories());
    } catch (error) {
      console.warn(`${LOG} failed to set notification categories:`, error);
    }
  }

  async function start(): Promise<void> {
    if (started) throw new Error("Host notifications are already started");
    started = true;
    if (!ports.isConfigured()) {
      console.info(`${LOG} Firebase is not configured. Push disabled.`);
      return;
    }
    const displayRemote = guarded("display a push", displayMessage);
    const onEvent = guarded("handle a notification event", handleNotificationEvent);
    messaging.setBackgroundMessageHandler(displayRemote);
    notifee.onBackgroundEvent(onEvent);
    subscriptions = [
      messaging.onTokenRefresh((next) => {
        token = next;
        emit({ type: "notification-token", token: next });
      }),
      messaging.onMessage((message) => void displayRemote(message)),
      notifee.onForegroundEvent(onEvent),
      messaging.onNotificationOpenedApp((message) => {
        const opened = openFromMessage(message);
        if (opened) void guarded("open a notification", open)(opened);
      }),
    ];

    await setUpDisplay();
    let initial: RemoteMessage | null = null;
    try {
      initial = await messaging.getInitialNotification();
    } catch (error) {
      console.warn(`${LOG} failed to read the launch notification:`, error);
    }
    const opened = openFromMessage(initial);
    if (opened) await open(opened);
  }

  function stop(): void {
    for (const unsubscribe of subscriptions) unsubscribe();
    subscriptions = [];
    started = false;
  }

  const handlers: NotificationsHandlers = {
    "notifications.status": async () => {
      const configured = ports.isConfigured();
      const permission = configured ? await messaging.permission() : "denied";
      if (configured && permission === "granted") token ??= await messaging.getToken();
      return {
        configured,
        permission,
        token: configured && permission === "granted" ? token : null,
        platform,
        deviceClientId: await getDeviceClientId(),
      };
    },
    "notifications.requestPermission": requestPermission,
    "notifications.display": async (notification: LocalNotification) => {
      await notifee.display({
        id: notification.id,
        title: notification.title,
        body: notification.body,
        data: notification.data,
        android: {
          channelId: INBOX_NOTIFICATION_CHANNEL_ID,
          pressAction: { id: "open", launchActivity: "default" },
        },
        ios: {},
      });
    },
    "notifications.cancel": (id: string) => notifee.cancel(id),
    "notifications.displayed": async (): Promise<DisplayedNotification[]> => notifee.displayed(),
    "notifications.takeInitialOpen": () =>
      mutate(async () => {
        const opened = loadOpen(await store.getItem(PENDING_OPEN_KEY));
        await store.removeItem(PENDING_OPEN_KEY);
        return opened;
      }),
  };

  return {
    handlers,
    start,
    stop,
    onEvent(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    drain,
  };
}
