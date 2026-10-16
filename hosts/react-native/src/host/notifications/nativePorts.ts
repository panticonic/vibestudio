/**
 * The only file in the host runtime that touches the device's notification
 * modules: it adapts firebase messaging, notifee, the keychain and async
 * storage to the ports `createHostNotifications` is written against. The host
 * entry imports it; client instances never register these modules.
 */
import messaging, { type FirebaseMessagingTypes } from "@react-native-firebase/messaging";
import notifee, {
  AndroidImportance,
  EventType,
  type Event as NotifeeEvent,
} from "@notifee/react-native";
import * as Keychain from "react-native-keychain";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { NativeModules, Platform } from "react-native";
import type {
  DeviceIdPort,
  DeviceNotification,
  FirebaseMessagingPort,
  HostNotificationsPorts,
  NotificationEvent,
  NotificationPermission,
  NotifeePort,
  RemoteMessage,
} from "./hostNotifications";

const DEVICE_ID_SERVICE = "vibestudio-push-device-id";

/** firebase `AuthorizationStatus`: -1 not determined, 0 denied, 1 authorized, 2 provisional, 3 ephemeral. */
function permissionOf(status: number): NotificationPermission {
  if (status === 1 || status === 2 || status === 3) return "granted";
  return status === 0 ? "denied" : "undetermined";
}

/**
 * FCM data payloads are string maps on the wire; the typings widen values to
 * `object`. Anything that is not a string is dropped rather than guessed at.
 */
function remoteMessageOf(message: FirebaseMessagingTypes.RemoteMessage): RemoteMessage {
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(message.data ?? {})) {
    if (typeof value === "string") data[key] = value;
  }
  return {
    data,
    ...(message.notification
      ? { notification: { title: message.notification.title, body: message.notification.body } }
      : {}),
  };
}

const firebaseMessaging: FirebaseMessagingPort = {
  permission: async () => permissionOf(await messaging().hasPermission()),
  requestPermission: async () => permissionOf(await messaging().requestPermission()),
  getToken: () => messaging().getToken(),
  onTokenRefresh: (listener) => messaging().onTokenRefresh(listener),
  onMessage: (listener) => messaging().onMessage((message) => listener(remoteMessageOf(message))),
  onNotificationOpenedApp: (listener) => messaging().onNotificationOpenedApp((message) => listener(remoteMessageOf(message))),
  getInitialNotification: async () => {
    const message = await messaging().getInitialNotification();
    return message ? remoteMessageOf(message) : null;
  },
  setBackgroundMessageHandler: (handler) => messaging().setBackgroundMessageHandler((message) => handler(remoteMessageOf(message))),
};

function eventOf(event: NotifeeEvent): NotificationEvent {
  const notification = event.detail.notification as Partial<DeviceNotification> | undefined;
  if (event.type === EventType.ACTION_PRESS)
    return {
      kind: "action",
      actionId: event.detail.pressAction?.id,
      ...(event.detail.input !== undefined ? { input: event.detail.input } : {}),
      notification,
    };
  return { kind: event.type === EventType.PRESS ? "press" : "other", notification };
}

const notifeePort: NotifeePort = {
  requestPermission: async () => void (await notifee.requestPermission()),
  createChannel: async ({ id, name, important }) => {
    await notifee.createChannel({
      id,
      name,
      ...(important ? { importance: AndroidImportance.HIGH } : {}),
    });
  },
  setNotificationCategories: (categories) => notifee.setNotificationCategories(categories),
  display: async (notification) => {
    await notifee.displayNotification(notification as Parameters<typeof notifee.displayNotification>[0]);
  },
  cancel: (id) => notifee.cancelNotification(id),
  displayed: async () =>
    (await notifee.getDisplayedNotifications()).flatMap((entry) => {
      const id = entry.notification.id ?? entry.id;
      return id ? [{ id, data: { ...entry.notification.data } }] : [];
    }),
  onForegroundEvent: (listener) =>
    notifee.onForegroundEvent((event) => void listener(eventOf(event))),
  onBackgroundEvent: (listener) => notifee.onBackgroundEvent((event) => listener(eventOf(event))),
};

const deviceIdPort: DeviceIdPort = {
  get: async () => {
    const stored = await Keychain.getGenericPassword({ service: DEVICE_ID_SERVICE });
    return stored ? stored.password : null;
  },
  set: async (id) => {
    await Keychain.setGenericPassword("push-device-id", id, {
      service: DEVICE_ID_SERVICE,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },
};

function firebaseConfigured(): boolean {
  const host = NativeModules["VibestudioMobileHost"] as
    | { firebaseConfigured?: boolean; getConstants?: () => { firebaseConfigured?: boolean } }
    | undefined;
  return (host?.firebaseConfigured ?? host?.getConstants?.()?.firebaseConfigured) !== false;
}

/** Everything but `decide` and `replyToConversation`, which the host runtime implements over its workspace connections. */
export function createNativeNotificationPorts(): Omit<
  HostNotificationsPorts,
  "decide" | "replyToConversation"
> {
  return {
    messaging: firebaseMessaging,
    notifee: notifeePort,
    store: AsyncStorage,
    deviceId: deviceIdPort,
    platform: Platform.OS === "ios" ? "ios" : "android",
    isConfigured: firebaseConfigured,
  };
}
