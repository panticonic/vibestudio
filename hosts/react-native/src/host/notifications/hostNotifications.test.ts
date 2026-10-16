import { describe, expect, it, vi } from "vitest";
import { workspaceNotificationKey } from "@vibestudio/shared/workspacePushScope";
import type { NotificationsHostEvent } from "@vibestudio/rn-client-api/notificationsProtocol";
import { ACTION_QUEUE_KEY, SYNCING_NOTIFICATION_BODY } from "./hostNotifications";
import {
  createHostNotifications,
  type DeviceNotification,
  type NotificationEvent,
  type NotificationPermission,
  type RemoteMessage,
} from "./hostNotifications";

const scope = { serverId: "srv_aaaaaaaaaaaaaaaaaaaaaaaa", userId: "alice", workspaceId: "project" };
const target = { ...scope, approvalId: "approval-1" };
const keyOf = (id: string) => workspaceNotificationKey(scope, id);

function harness(
  options: {
    configured?: boolean;
    permission?: NotificationPermission;
    requestResult?: NotificationPermission;
    initial?: RemoteMessage | null;
    storedDeviceId?: string | null;
    platform?: "android" | "ios";
  } = {}
) {
  const storage = new Map<string, string>();
  const displayed: DeviceNotification[] = [];
  const cancelled: string[] = [];
  const decided: Array<[string, string]> = [];
  let permission = options.permission ?? "granted";
  let decideFails = true;
  const reported: Array<{ id: string; actionId: string; text?: string | undefined }> = [];
  const reportFailure: { error: Error | null } = { error: null };
  const l = {
    tokenRefresh: undefined as undefined | ((token: string) => void),
    message: undefined as undefined | ((message: RemoteMessage) => void),
    opened: undefined as undefined | ((message: RemoteMessage) => void),
    foreground: undefined as undefined | ((event: NotificationEvent) => Promise<void>),
    backgroundEvent: undefined as undefined | ((event: NotificationEvent) => Promise<void>),
    backgroundMessage: undefined as undefined | ((message: RemoteMessage) => Promise<void>),
  };
  const deviceIdSet = vi.fn(async () => undefined);
  const notifee = {
    requestPermission: vi.fn(async () => undefined),
    createChannel: vi.fn(async () => undefined),
    setNotificationCategories: vi.fn(async () => undefined),
    display: vi.fn(async (n: DeviceNotification) => void displayed.push(n)),
    cancel: vi.fn(async (id: string) => void cancelled.push(id)),
    displayed: vi.fn(async () => [{ id: "x", data: { a: 1 } }]),
    onForegroundEvent: vi.fn((cb: (e: NotificationEvent) => Promise<void>) => {
      l.foreground = cb;
      return vi.fn();
    }),
    onBackgroundEvent: vi.fn((cb: (e: NotificationEvent) => Promise<void>) => {
      l.backgroundEvent = cb;
    }),
  };
  const messaging = {
    permission: vi.fn(async () => permission),
    requestPermission: vi.fn(async () => {
      permission = options.requestResult ?? "granted";
      return permission;
    }),
    getToken: vi.fn(async () => "token-1"),
    onTokenRefresh: vi.fn((cb: (token: string) => void) => {
      l.tokenRefresh = cb;
      return vi.fn();
    }),
    onMessage: vi.fn((cb: (m: RemoteMessage) => void) => {
      l.message = cb;
      return vi.fn();
    }),
    onNotificationOpenedApp: vi.fn((cb: (m: RemoteMessage) => void) => {
      l.opened = cb;
      return vi.fn();
    }),
    getInitialNotification: vi.fn(async () => options.initial ?? null),
    setBackgroundMessageHandler: vi.fn((cb: (m: RemoteMessage) => Promise<void>) => {
      l.backgroundMessage = cb;
    }),
  };
  const host = createHostNotifications({
    messaging,
    notifee,
    store: {
      getItem: async (k) => storage.get(k) ?? null,
      setItem: async (k, v) => void storage.set(k, v),
      removeItem: async (k) => void storage.delete(k),
    },
    deviceId: {
      get: async () => options.storedDeviceId ?? null,
      set: deviceIdSet,
    },
    platform: options.platform ?? "android",
    isConfigured: () => options.configured ?? true,
    reportAction: async (_scope, id, actionId, text) => {
      if (reportFailure.error) throw reportFailure.error;
      reported.push({ id, actionId, text });
    },
    decide: async (t, decision) => {
      if (decideFails) throw new Error("not connected");
      decided.push([t.approvalId, decision]);
    },
  });
  const events: NotificationsHostEvent[] = [];
  return {
    host,
    l,
    storage,
    displayed,
    cancelled,
    decided,
    reported,
    reportFailure,
    notifee,
    messaging,
    deviceIdSet,
    events,
    listen: (delivered?: boolean) => host.onEvent((e) => (events.push(e), delivered)),
    connect: () => {
      decideFails = false;
    },
  };
}

const decisionEvent = (actionId: string): NotificationEvent => ({
  kind: "action",
  actionId,
  notification: { id: keyOf("approval-1"), title: "Approval", data: { ...target } },
});

describe("host notifications", () => {
  it("registers every listener, including the background handlers, before its first await", () => {
    const h = harness();
    void h.host.start();
    expect(h.messaging.setBackgroundMessageHandler).toHaveBeenCalled();
    expect(h.notifee.onBackgroundEvent).toHaveBeenCalled();
    expect(h.messaging.onMessage).toHaveBeenCalled();
    expect(h.notifee.onForegroundEvent).toHaveBeenCalled();
    expect(h.messaging.onTokenRefresh).toHaveBeenCalled();
  });

  it("registers nothing when Firebase is not configured and reports it", async () => {
    const h = harness({ configured: false });
    await h.host.start();
    expect(h.messaging.onMessage).not.toHaveBeenCalled();
    expect(h.notifee.onBackgroundEvent).not.toHaveBeenCalled();
    expect(await h.host.handlers["notifications.status"]()).toMatchObject({
      configured: false,
      token: null,
    });
    expect(await h.host.handlers["notifications.requestPermission"]()).toBe(false);
  });

  it("creates Android channels and iOS categories at start", async () => {
    const h = harness();
    await h.host.start();
    expect(h.notifee.createChannel.mock.calls.map(([c]) => c.id)).toEqual(["approvals", "messages"]);
    expect(h.notifee.setNotificationCategories).toHaveBeenCalled();
    const ios = harness({ platform: "ios" });
    await ios.host.start();
    expect(ios.notifee.createChannel).not.toHaveBeenCalled();
  });

  it("displays an approval prompt from a foreground message and from the background handler, with host-authored labels", async () => {
    const h = harness();
    await h.host.start();
    const message: RemoteMessage = {
      data: {
        ...scope,
        kind: "approval-prompt",
        approvalId: "approval-1",
        actionsJson: JSON.stringify([
          { id: "once", title: "Push once" },
          { id: "deny", title: "Don't upload" },
        ]),
      },
    };
    h.l.message?.(message);
    await h.l.backgroundMessage?.(message);
    await vi.waitFor(() => expect(h.displayed).toHaveLength(2));
    expect(h.displayed[0]).toMatchObject({
      id: keyOf("approval-1"),
      title: "Approval requested",
      android: {
        channelId: "approvals",
        actions: [
          { title: "Push once", pressAction: { id: "once" } },
          { title: "Don't upload", pressAction: { id: "deny" } },
        ],
      },
      ios: { categoryId: "vibestudio-approval-decide" },
    });
  });

  it("displays a pushed inbox entry under its durable id on the messages channel", async () => {
    const h = harness();
    await h.host.start();
    await h.l.backgroundMessage?.({
      notification: { title: "ignored", body: "ignored" },
      data: {
        ...scope,
        kind: "user-inbox",
        notificationId: "agent.message:say:call-1:usr_bob",
        inboxKind: "agent.message",
        title: "Briefing ready",
        body: "3 stories",
        priority: "high",
        channelId: "ch-news",
        channelTargetId: "do:workers/pubsub-channel:PubSubChannel:ch-news",
        messageId: "say:call-1",
        senderParticipantId: "do:news",
        senderHandle: "news",
      },
    });
    expect(h.displayed[0]).toMatchObject({
      id: keyOf("agent.message:say:call-1:usr_bob"),
      title: "Briefing ready",
      body: "3 stories",
      android: { channelId: "messages", importance: 4 },
    });
  });

  it("cancels the displayed notification on an approval-cancel push", async () => {
    const h = harness();
    await h.host.start();
    await h.l.backgroundMessage?.({
      data: { ...scope, kind: "approval-cancel", cancelKey: "approval-1" },
    });
    expect(h.cancelled).toEqual([keyOf("approval-1")]);
    expect(h.displayed).toEqual([]);
  });

  it("queues a lock-screen decision, shows the syncing state, and keeps it when the workspace is unreachable", async () => {
    const h = harness();
    await h.host.start();
    await h.l.backgroundEvent?.(decisionEvent("deny"));
    expect(h.displayed.at(-1)).toMatchObject({
      id: keyOf("approval-1"),
      body: SYNCING_NOTIFICATION_BODY,
    });
    expect(h.cancelled).toEqual([]);
    expect(h.storage.get(ACTION_QUEUE_KEY)).toContain("approval-1");
  });

  it("drains a queued decision once a connection exists: decide, dequeue, cancel", async () => {
    const h = harness();
    await h.host.start();
    await h.l.backgroundEvent?.(decisionEvent("session"));
    h.connect();
    await h.host.drain();
    expect(h.decided).toEqual([["approval-1", "session"]]);
    expect(h.cancelled).toEqual([keyOf("approval-1")]);
    expect(h.storage.has(ACTION_QUEUE_KEY)).toBe(false);
  });

  it("decides immediately and cancels when a foreground action finds a connection", async () => {
    const h = harness();
    await h.host.start();
    h.connect();
    await h.l.foreground?.(decisionEvent("deny"));
    expect(h.decided).toEqual([["approval-1", "deny"]]);
    expect(h.cancelled).toEqual([keyOf("approval-1")]);
    expect(h.displayed).toEqual([]);
  });

  it("does not drop a queued decision when draining fails, and prunes only stale ones", async () => {
    const h = harness();
    await h.host.start();
    h.storage.set(
      ACTION_QUEUE_KEY,
      JSON.stringify({
        version: 2,
        actions: [
          { ...target, decision: "once", queuedAt: Date.now() },
          { ...target, approvalId: "old", decision: "once", queuedAt: 0 },
        ],
      })
    );
    await h.host.drain();
    const kept = JSON.parse(h.storage.get(ACTION_QUEUE_KEY) ?? "{}") as {
      actions: Array<{ approvalId: string }>;
    };
    expect(kept.actions.map((a) => a.approvalId)).toEqual(["approval-1"]);
    expect(h.cancelled).toEqual([]);
  });

  it("submits a queued decision once when drains overlap", async () => {
    const h = harness();
    await h.host.start();
    await h.l.backgroundEvent?.(decisionEvent("deny"));
    h.connect();
    await Promise.all([h.host.drain(), h.host.drain()]);
    expect(h.decided).toEqual([["approval-1", "deny"]]);
  });

  it("emits a press as notification-open to a running client and keeps nothing", async () => {
    const h = harness();
    h.listen(true);
    await h.host.start();
    await h.l.foreground?.({
      kind: "press",
      notification: { data: { ...target } },
    });
    expect(h.events).toEqual([{ type: "notification-open", open: { kind: "approval", target } }]);
    expect(await h.host.handlers["notifications.takeInitialOpen"]()).toBeNull();
  });

  it("keeps an open nobody received and hands it out exactly once", async () => {
    const h = harness();
    h.listen(false);
    await h.host.start();
    await h.l.backgroundEvent?.({ kind: "action", actionId: "open", notification: { data: { ...target } } });
    expect(await h.host.handlers["notifications.takeInitialOpen"]()).toEqual({
      kind: "approval",
      target,
    });
    expect(await h.host.handlers["notifications.takeInitialOpen"]()).toBeNull();
  });

  it("turns the FCM launch notification into a pending open", async () => {
    const h = harness({ initial: { data: { ...scope, approvalId: "approval-1" } } });
    await h.host.start();
    expect(await h.host.handlers["notifications.takeInitialOpen"]()).toEqual({
      kind: "approval",
      target,
    });
  });

  it("routes a pressed inbox entry as an inbox open", async () => {
    const h = harness();
    h.listen(true);
    await h.host.start();
    const data = {
      ...scope,
      kind: "user-inbox",
      notificationId: "n1",
      inboxKind: "agent.message",
      title: "t",
      channelId: "c",
      channelTargetId: "do:workers/pubsub-channel:PubSubChannel:c",
      messageId: "m",
      senderParticipantId: "do:news",
      senderHandle: "news",
    };
    await h.l.foreground?.({ kind: "press", notification: { data } });
    expect(h.events[0]).toMatchObject({
      type: "notification-open",
      open: { kind: "inbox", payload: { notificationId: "n1" } },
    });
  });

  it("emits notification-token on refresh and reports the token in status", async () => {
    const h = harness();
    h.listen();
    await h.host.start();
    expect(await h.host.handlers["notifications.status"]()).toMatchObject({
      configured: true,
      permission: "granted",
      token: "token-1",
      platform: "android",
    });
    h.l.tokenRefresh?.("token-2");
    expect(h.events).toEqual([{ type: "notification-token", token: "token-2" }]);
    expect((await h.host.handlers["notifications.status"]()).token).toBe("token-2");
  });

  it("reports no token and does not prompt when permission is denied", async () => {
    const h = harness({ permission: "denied", requestResult: "denied" });
    await h.host.start();
    expect(await h.host.handlers["notifications.status"]()).toMatchObject({
      permission: "denied",
      token: null,
    });
    expect(h.messaging.getToken).not.toHaveBeenCalled();
    expect(await h.host.handlers["notifications.requestPermission"]()).toBe(false);
    expect(h.notifee.requestPermission).toHaveBeenCalled();
  });

  it("grants permission through the handler and then has a token", async () => {
    const h = harness({ permission: "undetermined", requestResult: "granted" });
    await h.host.start();
    expect((await h.host.handlers["notifications.status"]()).token).toBeNull();
    expect(await h.host.handlers["notifications.requestPermission"]()).toBe(true);
    expect((await h.host.handlers["notifications.status"]()).token).toBe("token-1");
  });

  it("keeps one stable device client id, generated once and stored", async () => {
    const h = harness();
    const first = (await h.host.handlers["notifications.status"]()).deviceClientId;
    expect(first).toMatch(/^device-android-/);
    expect((await h.host.handlers["notifications.status"]()).deviceClientId).toBe(first);
    expect(h.deviceIdSet).toHaveBeenCalledTimes(1);
    const stored = harness({ storedDeviceId: "device-existing" });
    expect((await stored.host.handlers["notifications.status"]()).deviceClientId).toBe(
      "device-existing"
    );
    expect(stored.deviceIdSet).not.toHaveBeenCalled();
  });

  it("serves display, cancel and displayed for clients", async () => {
    const h = harness();
    await h.host.handlers["notifications.display"]({ id: "local-1", title: "T", body: "B" });
    expect(h.displayed[0]).toMatchObject({ id: "local-1", title: "T", body: "B" });
    await h.host.handlers["notifications.cancel"]("local-1");
    expect(h.cancelled).toEqual(["local-1"]);
    expect(await h.host.handlers["notifications.displayed"]()).toEqual([{ id: "x", data: { a: 1 } }]);
  });

  it("refuses a second start and allows restart after stop", async () => {
    const h = harness();
    await h.host.start();
    await expect(h.host.start()).rejects.toThrow("already started");
    h.host.stop();
    await h.host.start();
  });

  describe("server-defined notifications with reply", () => {
    const pushed = (over: Record<string, string> = {}): RemoteMessage => ({
      data: {
        kind: "server-notification",
        ...scope,
        notificationId: "n-1",
        title: "Agent",
        body: "Ready?",
        actionsJson: JSON.stringify([
          { id: "reply", title: "Reply", input: "text" },
          { id: "dismiss", title: "Dismiss" },
        ]),
        ...over,
      },
    });
    const displayedNotification = (h: ReturnType<typeof harness>) => h.displayed.at(-1)!;
    const actionEvent = (h: ReturnType<typeof harness>, actionId: string, input?: string): NotificationEvent => ({
      kind: "action",
      actionId,
      ...(input !== undefined ? { input } : {}),
      notification: displayedNotification(h),
    });

    it("draws the producer's actions on Android, with a reply field where asked", async () => {
      const h = harness();
      await h.host.start();
      await h.l.message!(pushed());
      await vi.waitFor(() => expect(h.displayed).toHaveLength(1));
      const shown = displayedNotification(h);
      expect(shown.id).toBe(keyOf("n-1"));
      expect(shown.body).toBe("Ready?");
      const actions = (shown.android as { actions: Array<Record<string, unknown>> }).actions;
      expect(actions[0]).toMatchObject({ title: "Reply", pressAction: { id: "reply" }, input: expect.anything() });
      expect(actions[1]).toMatchObject({ title: "Dismiss", pressAction: { id: "dismiss" } });
      expect(actions[1]).not.toHaveProperty("input");
    });

    it("relays a typed reply to the producer with no client running, then retires the notification", async () => {
      const h = harness();
      await h.host.start();
      await h.l.message!(pushed());
      await vi.waitFor(() => expect(h.displayed).toHaveLength(1));
      await h.l.backgroundEvent!(actionEvent(h, "reply", "on my way"));
      expect(h.reported).toEqual([{ id: "n-1", actionId: "reply", text: "on my way" }]);
      expect(h.cancelled).toEqual([keyOf("n-1")]);
    });

    it("relays an action without input with no text", async () => {
      const h = harness();
      await h.host.start();
      await h.l.message!(pushed());
      await vi.waitFor(() => expect(h.displayed).toHaveLength(1));
      await h.l.foreground!(actionEvent(h, "dismiss"));
      expect(h.reported).toEqual([{ id: "n-1", actionId: "dismiss", text: undefined }]);
    });

    it("says a failed relay on the notification and keeps its actions, so the reply is not lost silently", async () => {
      const h = harness();
      await h.host.start();
      await h.l.message!(pushed());
      await vi.waitFor(() => expect(h.displayed).toHaveLength(1));
      h.reportFailure.error = new Error("not connected");
      await h.l.backgroundEvent!(actionEvent(h, "reply", "hi"));
      expect(h.cancelled).toEqual([]);
      const shown = displayedNotification(h);
      expect(h.displayed).toHaveLength(2);
      expect(shown.body).toBe("Not sent: not connected");
      expect((shown.android as { actions: unknown[] }).actions).toHaveLength(2);
    });

    it("ignores an action the producer never declared and a press on the body", async () => {
      const h = harness();
      await h.host.start();
      await h.l.message!(pushed());
      await vi.waitFor(() => expect(h.displayed).toHaveLength(1));
      await h.l.backgroundEvent!(actionEvent(h, "approve"));
      await h.l.backgroundEvent!({ kind: "press", notification: displayedNotification(h) });
      expect(h.reported).toEqual([]);
    });

    it("shows nothing for a malformed notification", async () => {
      const h = harness();
      await h.host.start();
      await h.l.message!(pushed({ actionsJson: "not json" }));
      await h.l.message!(pushed({ actionsJson: JSON.stringify([{ id: "open", title: "Open" }]) }));
      await h.l.message!(pushed({ serverId: "bad" }));
      expect(h.displayed).toEqual([]);
    });
  });
});
