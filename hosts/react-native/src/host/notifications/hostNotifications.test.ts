import { describe, expect, it, vi } from "vitest";
import { workspaceNotificationKey } from "@vibestudio/shared/workspacePushScope";
import type { NotificationsHostEvent } from "@vibestudio/rn-client-api/notificationsProtocol";
import { ACTION_QUEUE_KEY, SYNCING_NOTIFICATION_BODY } from "./hostNotifications";
import {
  createHostNotifications,
  notifeeInboxDisplay,
  type ConversationLaunch,
  type DeviceNotification,
  type InboxNotification,
  type NotificationEvent,
  type ReplyOutcome,
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
    conversation?: ConversationLaunch | null;
  } = {}
) {
  const storage = new Map<string, string>();
  const displayed: DeviceNotification[] = [];
  const cancelled: string[] = [];
  const decided: Array<[string, string]> = [];
  let permission = options.permission ?? "granted";
  let decideFails = true;
  let approvalGone = false;
  const replies: Array<{ workspaceId: string; target: string; text: string }> = [];
  const replyFailure: { error: Error | null; unacknowledged: string | null } = {
    error: null,
    unacknowledged: null,
  };
  const inboxShown: InboxNotification[] = [];
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
    inbox: {
      display: async (notification) => {
        inboxShown.push(notification);
        await notifeeInboxDisplay(notifee).display(notification);
      },
      cancel: (id) => notifeeInboxDisplay(notifee).cancel(id),
    },
    conversationLaunch: async () => options.conversation ?? null,
    replyToInbox: async (entry, text): Promise<ReplyOutcome> => {
      if (replyFailure.error) throw replyFailure.error;
      replies.push({ workspaceId: entry.workspaceId, target: entry.channelTargetId!, text });
      return replyFailure.unacknowledged === null
        ? { acknowledged: true }
        : { acknowledged: false, reason: replyFailure.unacknowledged };
    },
    decide: async (t, decision) => {
      if (approvalGone)
        throw Object.assign(new Error("No pending approval found"), { code: "ENOENT" });
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
    replies,
    inboxShown,
    replyFailure,
    notifee,
    messaging,
    deviceIdSet,
    events,
    listen: (delivered?: boolean) => host.onEvent((e) => (events.push(e), delivered)),
    connect: () => {
      decideFails = false;
    },
    withdrawApproval: () => {
      approvalGone = true;
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
    expect(h.notifee.createChannel.mock.calls.map(([c]) => c.id)).toEqual([
      "approvals",
      "messages",
    ]);
    expect(h.notifee.setNotificationCategories).toHaveBeenCalled();
    const ios = harness({ platform: "ios" });
    await ios.host.start();
    expect(ios.notifee.createChannel).not.toHaveBeenCalled();
  });

  it("creates the channels without push, so local notifications are not dropped by the OS", async () => {
    const h = harness({ configured: false });
    await h.host.start();
    expect(h.notifee.createChannel.mock.calls.map(([c]) => c.id)).toEqual([
      "approvals",
      "messages",
    ]);
    expect(h.messaging.onMessage).not.toHaveBeenCalled();
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
      ios: {},
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

  it("keeps a queued decision of any age when draining fails", async () => {
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
    expect(kept.actions.map((a) => a.approvalId)).toEqual(["approval-1", "old"]);
    expect(h.cancelled).toEqual([]);
  });

  it("settles a queued decision when the server says the approval no longer exists", async () => {
    const h = harness();
    await h.host.start();
    h.storage.set(
      ACTION_QUEUE_KEY,
      JSON.stringify({ version: 2, actions: [{ ...target, decision: "once", queuedAt: 0 }] })
    );
    h.withdrawApproval();
    await h.host.drain();
    expect(h.storage.has(ACTION_QUEUE_KEY)).toBe(false);
    expect(h.cancelled).toEqual([keyOf("approval-1")]);
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
    await h.l.backgroundEvent?.({
      kind: "action",
      actionId: "open",
      notification: { data: { ...target } },
    });
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
    expect(await h.host.handlers["notifications.displayed"]()).toEqual([
      { id: "x", data: { a: 1 } },
    ]);
  });

  it("refuses a second start and allows restart after stop", async () => {
    const h = harness();
    await h.host.start();
    await expect(h.host.start()).rejects.toThrow("already started");
    h.host.stop();
    await h.host.start();
  });

  describe("agent messages with a reply action", () => {
    const channelTargetId = "do:workers/pubsub-channel:PubSubChannel:ch-1";
    const pushed = (over: Record<string, string | undefined> = {}): RemoteMessage => ({
      data: {
        kind: "user-inbox",
        ...scope,
        notificationId: "n-1",
        inboxKind: "agent.message",
        title: "Agent",
        body: "Ready?",
        priority: "normal",
        channelId: "ch-1",
        channelTargetId,
        actionsJson: JSON.stringify([{ id: "reply", title: "Reply", input: "text" }]),
        ...over,
      } as Record<string, string>,
    });
    const shown = (h: ReturnType<typeof harness>) => h.displayed.at(-1)!;
    const replyEvent = (h: ReturnType<typeof harness>, input?: string): NotificationEvent => ({
      kind: "action",
      actionId: "reply",
      ...(input !== undefined ? { input } : {}),
      notification: shown(h),
    });
    const show = async (h: ReturnType<typeof harness>, message = pushed()) => {
      await h.host.start();
      await h.l.message!(message);
      await vi.waitFor(() => expect(h.displayed).toHaveLength(1));
    };

    it("hands the inbox port the entry's reply actions and registers the reply category for iOS", async () => {
      const h = harness();
      await show(h);
      expect(h.inboxShown[0]).toMatchObject({
        id: keyOf("n-1"),
        title: "Agent",
        body: "Ready?",
        priority: "normal",
        actions: [{ id: "reply", title: "Reply", input: "text" }],
        conversation: null,
      });
      expect(shown(h).ios).toEqual({ categoryId: "vibestudio-user-inbox-reply" });
      const categories = h.notifee.setNotificationCategories.mock.calls[0]![0];
      expect(
        categories.find((c) => c.id === "vibestudio-user-inbox-reply")?.actions[0]
      ).toMatchObject({
        id: "reply",
        input: expect.anything(),
      });
    });

    it("carries the client intent that opens the entry's conversation", async () => {
      const conversation: ConversationLaunch = {
        link: "vibestudio://c/chat/open-conversation?conversation=ch-1",
        tag: "client:chat:react-native:dev",
        clientId: "chat",
        title: "Chat",
      };
      const h = harness({ conversation });
      await show(h);
      expect(h.inboxShown[0]!.conversation).toEqual(conversation);
    });

    it("takes a reply typed into a notification the platform drew itself, with no client running", async () => {
      const h = harness();
      await show(h);
      await h.host.handleInboxEvent({
        kind: "action",
        actionId: "reply",
        input: "on my way",
        data: h.inboxShown[0]!.data,
      });
      expect(h.replies).toEqual([
        { workspaceId: scope.workspaceId, target: channelTargetId, text: "on my way" },
      ]);
      expect(h.cancelled).toEqual([keyOf("n-1")]);
    });

    it("says on the notification when the reply was sent but the entry could not be acknowledged, and does not offer a second send", async () => {
      const h = harness();
      await show(h);
      h.replyFailure.unacknowledged = "gad unreachable";
      await h.l.backgroundEvent!(replyEvent(h, "hi"));
      expect(h.replies).toHaveLength(1);
      expect(h.cancelled).toEqual([]);
      expect(h.displayed).toHaveLength(2);
      expect(shown(h).body).toBe(
        "Sent, but this message could not be marked as read: gad unreachable"
      );
      expect(shown(h).ios).toEqual({});
      expect(h.inboxShown.at(-1)!.actions).toEqual([]);
    });

    it("posts a typed reply into the push's conversation and workspace with no client running, then retires the notification", async () => {
      const h = harness();
      await show(h);
      await h.l.backgroundEvent!(replyEvent(h, " on my way "));
      expect(h.replies).toEqual([
        { workspaceId: scope.workspaceId, target: channelTargetId, text: "on my way" },
      ]);
      expect(h.cancelled).toEqual([keyOf("n-1")]);
    });

    it("says a failed reply on the notification and keeps the reply action", async () => {
      const h = harness();
      await show(h);
      h.replyFailure.error = new Error("not connected");
      await h.l.backgroundEvent!(replyEvent(h, "hi"));
      expect(h.cancelled).toEqual([]);
      expect(h.displayed).toHaveLength(2);
      expect(shown(h).body).toBe("Not sent: not connected");
      expect(shown(h).ios).toEqual({ categoryId: "vibestudio-user-inbox-reply" });
      expect(h.inboxShown.at(-1)!.actions).toHaveLength(1);
    });

    it("sends nothing for an empty reply, an undeclared action or a press on the body", async () => {
      const h = harness();
      await show(h);
      await h.l.backgroundEvent!(replyEvent(h, "   "));
      await h.l.backgroundEvent!({ ...replyEvent(h, "hi"), actionId: "approve" });
      await h.l.backgroundEvent!({ kind: "press", notification: shown(h) });
      expect(h.replies).toEqual([]);
    });

    it("an entry without actions has no reply", async () => {
      const h = harness();
      await show(h, pushed({ actionsJson: undefined }));
      expect(h.inboxShown[0]!.actions).toEqual([]);
      expect(shown(h).ios).toEqual({});
      await h.l.backgroundEvent!(replyEvent(h, "hi"));
      expect(h.replies).toEqual([]);
    });

    it("shows nothing for malformed actions or actions without a conversation", async () => {
      const h = harness();
      await h.host.start();
      await h.l.message!(pushed({ actionsJson: "not json" }));
      await h.l.message!(
        pushed({ actionsJson: JSON.stringify([{ id: "open", title: "Open", input: "text" }]) })
      );
      await h.l.message!(pushed({ channelTargetId: undefined, inboxKind: "other" }));
      expect(h.displayed).toEqual([]);
    });
  });
});
