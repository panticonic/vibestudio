import { describe, expect, it, vi } from "vitest";
import {
  APPROVAL_CATEGORY_DECIDE,
  APPROVAL_CATEGORY_INPUT_REQUIRED,
} from "@vibestudio/shared/approvalContract";
import { createApprovalQueue } from "./approvalQueue.js";
import { createApprovalPushBridge } from "./approvalPushBridge.js";
import type {
  PushDeliveryTarget,
  PushRegistration,
  PushSendResult,
  PushServiceInternal,
} from "./pushService.js";

const SENT_PUSH_RESULT: PushSendResult = {
  userId: "user-1",
  clientId: "mobile-1",
  platform: "android",
  sent: true,
  logOnly: false,
};
const DELIVERED_TARGETS = [
  { userId: "user-1", clientId: "mobile-1" },
  { userId: "user-2", clientId: "mobile-2" },
];
const USER_1_TARGETS = [DELIVERED_TARGETS[0]!];

// The emitting child's workspace members (WP4 §4.4). The bridge routes each
// approval to exactly these userIds — every member's devices,
// and no non-member device. Multiple members make the per-user routing explicit.
const MEMBER_USER_IDS = ["user-1", "user-2"];

function createQueue() {
  return createApprovalQueue({ eventService: { emit: vi.fn() } as never });
}

function createPushMock(): PushServiceInternal & { triggerRegistrationsChanged(): void } {
  const registrationListeners = new Set<() => void>();
  const registrations: PushRegistration[] = [
    {
      userId: "user-1",
      clientId: "mobile-1",
      platform: "android",
      token: "token-1",
      registeredAt: 1,
    },
    {
      userId: "user-2",
      clientId: "mobile-2",
      platform: "ios",
      token: "token-2",
      registeredAt: 1,
    },
  ];
  return {
    send: vi.fn(),
    sendToTargets: vi.fn(async (targets: readonly PushDeliveryTarget[]) =>
      targets.map((target) => ({
        userId: target.userId,
        clientId: target.clientId,
        platform: target.clientId === "mobile-1" ? ("android" as const) : ("ios" as const),
        sent: true,
        logOnly: false,
      }))
    ),
    cancel: vi.fn(async () => []),
    listRegistrations: vi.fn(() => registrations),
    unregisterUser: vi.fn(() => 0),
    onRegistrationsChanged: vi.fn((listener) => {
      registrationListeners.add(listener);
      return () => registrationListeners.delete(listener);
    }),
    unregister: vi.fn(() => false),
    triggerRegistrationsChanged() {
      for (const listener of registrationListeners) listener();
    },
  };
}

function requestCapability(queue: ReturnType<typeof createQueue>) {
  return queue.request({
    kind: "capability",
    callerId: "panel-1",
    callerKind: "panel",
    repoPath: "panels/example",
    executionDigest: "hash-1",
    capability: "external-browser-open",
    title: "Open external browser",
    resource: {
      type: "url-origin",
      label: "Origin",
      value: "https://example.com",
    },
  });
}

function requestAppSourceChange(queue: ReturnType<typeof createQueue>) {
  return queue.request({
    kind: "unit-batch",
    callerId: "panel-1",
    callerKind: "panel",
    repoPath: "panels/example",
    executionDigest: "hash-1",
    trigger: "source-change",
    title: "@workspace-apps/shell app source change",
    description: "Accepting this push updates trusted workspace app code.",
    units: [
      {
        unitKind: "app",
        unitName: "@workspace-apps/shell",
        displayName: "Shell",
        version: "1.0.0",
        target: "electron",
        source: { kind: "workspace-repo", repo: "apps/shell", ref: "main" },
        sourceDigest: "sourceDigest-shell",
        capabilities: ["notifications"],
      },
    ],
    configWrite: null,
  });
}

function requestUnitManagement(queue: ReturnType<typeof createQueue>) {
  return queue.request({
    kind: "unit-batch",
    callerId: "panel-1",
    callerKind: "panel",
    repoPath: "panels/example",
    executionDigest: "hash-1",
    trigger: "management",
    title: "Reload extension",
    description: "Allow panel panel-1 to reload @workspace-extensions/image-service.",
    units: [
      {
        unitKind: "extension",
        unitName: "@workspace-extensions/image-service",
        displayName: "Image Service",
        version: "1.0.0",
        target: null,
        source: { kind: "workspace-repo", repo: "extensions/image-service", ref: "main" },
        sourceDigest: "sourceDigest-image",
        capabilities: ["node:fs"],
      },
    ],
    configWrite: null,
  });
}

function requestStartupUnit(queue: ReturnType<typeof createQueue>) {
  return queue.request({
    kind: "unit-batch",
    callerId: "system:units",
    callerKind: "system",
    repoPath: "meta",
    executionDigest: "",
    trigger: "startup",
    title: "Approve workspace extensions",
    description: "Approve startup extensions.",
    units: [
      {
        unitKind: "extension",
        unitName: "@workspace-extensions/image-service",
        displayName: "Image Service",
        version: "1.0.0",
        target: null,
        source: { kind: "workspace-repo", repo: "extensions/image-service", ref: "main" },
        sourceDigest: "sourceDigest-image",
        capabilities: ["node:fs"],
      },
    ],
    configWrite: null,
  });
}

function requestDoCapability(queue: ReturnType<typeof createQueue>) {
  return queue.request({
    kind: "capability",
    callerId: "do:workers/example:ExampleDO:agent-1",
    callerKind: "do",
    repoPath: "workers/example",
    executionDigest: "hash-1",
    capability: "external-browser-open",
    title: "Open external browser",
    resource: {
      type: "url-origin",
      label: "Origin",
      value: "https://example.com",
    },
  });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createTimerHarness() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { due: number; callback: () => void }>();
  const setTimeoutFn = ((callback: () => void, delay?: number) => {
    const id = nextId;
    nextId += 1;
    timers.set(id, { due: now + (delay ?? 0), callback });
    return id;
  }) as unknown as typeof setTimeout;
  const clearTimeoutFn = ((id: ReturnType<typeof setTimeout>) => {
    timers.delete(id as unknown as number);
  }) as typeof clearTimeout;

  return {
    setTimeoutFn,
    clearTimeoutFn,
    advanceByTime(ms: number) {
      now += ms;
      while (true) {
        const nextTimer = [...timers.entries()]
          .filter(([, timer]) => timer.due <= now)
          .sort(([, a], [, b]) => a.due - b.due)[0];
        if (!nextTimer) return;
        const [id, timer] = nextTimer;
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

describe("approvalPushBridge", () => {
  it("fans out approval pushes and deduplicates by approvalId", async () => {
    const queue = createQueue();
    const push = createPushMock();
    createApprovalPushBridge({
      approvalQueue: queue,
      push,
      workspaceMemberUserIds: () => MEMBER_USER_IDS,
      shellPresence: {
        isAnyShellActive: () => false,
        markActive: vi.fn(),
        getActiveShellCount: () => 0,
      },
    });

    const first = requestCapability(queue);
    const second = requestCapability(queue);
    await flush();

    expect(push.sendToTargets).toHaveBeenCalledTimes(1);
    expect(push.sendToTargets).toHaveBeenCalledWith(
      DELIVERED_TARGETS,
      expect.objectContaining({
        category: APPROVAL_CATEGORY_DECIDE,
        data: expect.objectContaining({
          kind: "approval-prompt",
          approvalKind: "capability",
          category: APPROVAL_CATEGORY_DECIDE,
        }),
      })
    );

    queue.resolve(queue.listPending()[0]!.approvalId, "deny");
    await expect(first).resolves.toBe("deny");
    await expect(second).resolves.toBe("deny");
  });

  it("cancels local notifications when an approval resolves", async () => {
    const queue = createQueue();
    const push = createPushMock();
    createApprovalPushBridge({
      approvalQueue: queue,
      push,
      workspaceMemberUserIds: () => MEMBER_USER_IDS,
      shellPresence: {
        isAnyShellActive: () => false,
        markActive: vi.fn(),
        getActiveShellCount: () => 0,
      },
    });
    const promise = requestCapability(queue);
    await flush();
    const approvalId = queue.listPending()[0]!.approvalId;

    queue.resolve(approvalId, "once");
    await flush();

    expect(push.cancel).toHaveBeenCalledWith(DELIVERED_TARGETS, approvalId);
    await expect(promise).resolves.toBe("once");
  });

  it("cancels the successful delivery snapshot when workspace membership changes", async () => {
    const queue = createQueue();
    const push = createPushMock();
    let members: readonly string[] = ["user-1"];
    createApprovalPushBridge({
      approvalQueue: queue,
      push,
      workspaceMemberUserIds: () => members,
      shellPresence: {
        isAnyShellActive: () => false,
        markActive: vi.fn(),
        getActiveShellCount: () => 0,
      },
    });
    const promise = requestCapability(queue);
    await flush();
    const approvalId = queue.listPending()[0]!.approvalId;

    members = ["user-2"];
    queue.resolve(approvalId, "once");
    await flush();

    expect(push.cancel).toHaveBeenCalledWith(USER_1_TARGETS, approvalId);
    await expect(promise).resolves.toBe("once");
  });

  it("delays pushes until the deadline while a desktop shell remains active", async () => {
    const queue = createQueue();
    const push = createPushMock();
    const timers = createTimerHarness();
    createApprovalPushBridge({
      approvalQueue: queue,
      push,
      workspaceMemberUserIds: () => MEMBER_USER_IDS,
      shellPresence: {
        isAnyShellActive: () => true,
        markActive: vi.fn(),
        getActiveShellCount: () => 1,
      },
      delayMs: 10_000,
      presenceMaxAgeMs: 6_000,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    const promise = requestCapability(queue);
    expect(push.sendToTargets).not.toHaveBeenCalled();

    timers.advanceByTime(10_000);
    await flush();
    expect(push.sendToTargets).toHaveBeenCalledTimes(1);

    queue.resolve(queue.listPending()[0]!.approvalId, "deny");
    await expect(promise).resolves.toBe("deny");
  });

  it("fires a delayed push when shell presence goes stale", async () => {
    const queue = createQueue();
    const push = createPushMock();
    const timers = createTimerHarness();
    let active = true;
    createApprovalPushBridge({
      approvalQueue: queue,
      push,
      workspaceMemberUserIds: () => MEMBER_USER_IDS,
      shellPresence: {
        isAnyShellActive: () => active,
        markActive: vi.fn(),
        getActiveShellCount: () => (active ? 1 : 0),
      },
      delayMs: 10_000,
      presenceMaxAgeMs: 6_000,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    const promise = requestCapability(queue);
    active = false;
    timers.advanceByTime(6_000);
    await flush();

    expect(push.sendToTargets).toHaveBeenCalledTimes(1);

    queue.resolve(queue.listPending()[0]!.approvalId, "deny");
    await expect(promise).resolves.toBe("deny");
  });

  it("clears delayed sends when the approval resolves before any push is sent", async () => {
    const queue = createQueue();
    const push = createPushMock();
    const timers = createTimerHarness();
    createApprovalPushBridge({
      approvalQueue: queue,
      push,
      workspaceMemberUserIds: () => MEMBER_USER_IDS,
      shellPresence: {
        isAnyShellActive: () => true,
        markActive: vi.fn(),
        getActiveShellCount: () => 1,
      },
      delayMs: 10_000,
      presenceMaxAgeMs: 6_000,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    const promise = requestCapability(queue);
    const approvalId = queue.listPending()[0]!.approvalId;
    queue.resolve(approvalId, "deny");
    timers.advanceByTime(10_000);
    await flush();

    expect(push.sendToTargets).not.toHaveBeenCalled();
    expect(push.cancel).not.toHaveBeenCalled();
    await expect(promise).resolves.toBe("deny");
  });

  it("routes field-input approval kinds to the open-only category", async () => {
    const queue = createQueue();
    const push = createPushMock();
    createApprovalPushBridge({
      approvalQueue: queue,
      push,
      workspaceMemberUserIds: () => MEMBER_USER_IDS,
      shellPresence: {
        isAnyShellActive: () => false,
        markActive: vi.fn(),
        getActiveShellCount: () => 0,
      },
    });

    const promise = queue.requestClientConfig({
      kind: "client-config",
      callerId: "panel-1",
      callerKind: "panel",
      repoPath: "panels/example",
      executionDigest: "hash-1",
      configId: "github",
      authorizeUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      title: "Configure GitHub",
      fields: [{ name: "clientId", label: "Client ID", type: "text", required: true }],
    });
    await flush();

    expect(push.sendToTargets).toHaveBeenCalledWith(
      DELIVERED_TARGETS,
      expect.objectContaining({
        category: APPROVAL_CATEGORY_INPUT_REQUIRED,
        data: expect.objectContaining({
          actionsJson: JSON.stringify([{ id: "open", title: "Open" }]),
        }),
      })
    );

    queue.resolve(queue.listPending()[0]!.approvalId, "deny");
    await expect(promise).resolves.toEqual({ decision: "deny" });
  });

  it("offers session grants for unit source-change approvals", async () => {
    const queue = createQueue();
    const push = createPushMock();
    createApprovalPushBridge({
      approvalQueue: queue,
      push,
      workspaceMemberUserIds: () => MEMBER_USER_IDS,
      shellPresence: {
        isAnyShellActive: () => false,
        markActive: vi.fn(),
        getActiveShellCount: () => 0,
      },
    });

    const promise = requestAppSourceChange(queue);
    await flush();

    expect(push.sendToTargets).toHaveBeenCalledWith(
      DELIVERED_TARGETS,
      expect.objectContaining({
        data: expect.objectContaining({
          approvalKind: "unit-batch",
          actionsJson: JSON.stringify([
            { id: "once", title: "Approve change" },
            { id: "session", title: "Session" },
            { id: "deny", title: "Deny" },
            { id: "open", title: "Open" },
          ]),
        }),
      })
    );

    queue.resolve(queue.listPending()[0]!.approvalId, "session");
    await expect(promise).resolves.toBe("session");
  });

  it("does not offer session grants for unit management approvals", async () => {
    const queue = createQueue();
    const push = createPushMock();
    createApprovalPushBridge({
      approvalQueue: queue,
      push,
      workspaceMemberUserIds: () => MEMBER_USER_IDS,
      shellPresence: {
        isAnyShellActive: () => false,
        markActive: vi.fn(),
        getActiveShellCount: () => 0,
      },
    });

    const promise = requestUnitManagement(queue);
    await flush();

    expect(push.sendToTargets).toHaveBeenCalledWith(
      DELIVERED_TARGETS,
      expect.objectContaining({
        data: expect.objectContaining({
          approvalKind: "unit-batch",
          actionsJson: JSON.stringify([
            { id: "once", title: "Approve" },
            { id: "deny", title: "Deny" },
            { id: "open", title: "Open" },
          ]),
        }),
      })
    );

    queue.resolve(queue.listPending()[0]!.approvalId, "once");
    await expect(promise).resolves.toBe("once");
  });

  it("does not mirror startup unit approvals into push notifications", async () => {
    const queue = createQueue();
    const push = createPushMock();
    createApprovalPushBridge({
      approvalQueue: queue,
      push,
      workspaceMemberUserIds: () => MEMBER_USER_IDS,
      shellPresence: {
        isAnyShellActive: () => false,
        markActive: vi.fn(),
        getActiveShellCount: () => 0,
      },
    });

    const promise = requestStartupUnit(queue);
    await flush();

    expect(push.sendToTargets).not.toHaveBeenCalled();
    queue.resolve(queue.listPending()[0]!.approvalId, "once");
    await expect(promise).resolves.toBe("once");
  });

  it("labels DO-origin approvals accurately in push copy", async () => {
    const queue = createQueue();
    const push = createPushMock();
    createApprovalPushBridge({
      approvalQueue: queue,
      push,
      workspaceMemberUserIds: () => MEMBER_USER_IDS,
      shellPresence: {
        isAnyShellActive: () => false,
        markActive: vi.fn(),
        getActiveShellCount: () => 0,
      },
    });

    const promise = requestDoCapability(queue);
    await flush();

    expect(push.sendToTargets).toHaveBeenCalledWith(
      DELIVERED_TARGETS,
      expect.objectContaining({
        body: expect.stringContaining("DO"),
      })
    );

    queue.resolve(queue.listPending()[0]!.approvalId, "deny");
    await expect(promise).resolves.toBe("deny");
  });

  it("resends pending approvals when a push registration appears later", async () => {
    const queue = createQueue();
    const push = createPushMock();
    vi.mocked(push.sendToTargets).mockResolvedValueOnce([]);
    createApprovalPushBridge({
      approvalQueue: queue,
      push,
      workspaceMemberUserIds: () => MEMBER_USER_IDS,
      shellPresence: {
        isAnyShellActive: () => false,
        markActive: vi.fn(),
        getActiveShellCount: () => 0,
      },
    });

    const promise = requestCapability(queue);
    await flush();
    expect(push.sendToTargets).toHaveBeenCalledTimes(1);

    push.triggerRegistrationsChanged();
    await flush();
    expect(push.sendToTargets).toHaveBeenCalledTimes(2);

    const approvalId = queue.listPending()[0]!.approvalId;
    queue.resolve(approvalId, "deny");
    await flush();

    expect(push.cancel).toHaveBeenCalledWith(DELIVERED_TARGETS, approvalId);
    await expect(promise).resolves.toBe("deny");
  });

  it("retries only outstanding devices after a partial delivery", async () => {
    const queue = createQueue();
    const push = createPushMock();
    const timers = createTimerHarness();
    vi.mocked(push.sendToTargets)
      .mockResolvedValueOnce([
        SENT_PUSH_RESULT,
        {
          userId: "user-2",
          clientId: "mobile-2",
          platform: "ios",
          sent: false,
          logOnly: false,
          error: "transient",
        },
      ])
      .mockResolvedValueOnce([
        {
          userId: "user-2",
          clientId: "mobile-2",
          platform: "ios",
          sent: true,
          logOnly: false,
        },
      ]);
    createApprovalPushBridge({
      approvalQueue: queue,
      push,
      workspaceMemberUserIds: () => MEMBER_USER_IDS,
      shellPresence: {
        isAnyShellActive: () => false,
        markActive: vi.fn(),
        getActiveShellCount: () => 0,
      },
      retryMs: 100,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    const promise = requestCapability(queue);
    await flush();
    expect(push.sendToTargets).toHaveBeenNthCalledWith(1, DELIVERED_TARGETS, expect.any(Object));

    timers.advanceByTime(100);
    await flush();
    expect(push.sendToTargets).toHaveBeenNthCalledWith(
      2,
      [{ userId: "user-2", clientId: "mobile-2" }],
      expect.any(Object)
    );

    const approvalId = queue.listPending()[0]!.approvalId;
    queue.resolve(approvalId, "deny");
    await flush();
    expect(push.cancel).toHaveBeenCalledWith(DELIVERED_TARGETS, approvalId);
    await expect(promise).resolves.toBe("deny");
  });

  it("polls shared registration state while an approval remains pending", async () => {
    const queue = createQueue();
    const push = createPushMock();
    const timers = createTimerHarness();
    vi.mocked(push.listRegistrations).mockReturnValueOnce([]);
    createApprovalPushBridge({
      approvalQueue: queue,
      push,
      workspaceMemberUserIds: () => MEMBER_USER_IDS,
      shellPresence: {
        isAnyShellActive: () => false,
        markActive: vi.fn(),
        getActiveShellCount: () => 0,
      },
      retryMs: 100,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    const promise = requestCapability(queue);
    await flush();
    expect(push.sendToTargets).not.toHaveBeenCalled();

    timers.advanceByTime(100);
    await flush();
    expect(push.sendToTargets).toHaveBeenCalledWith(DELIVERED_TARGETS, expect.any(Object));

    const approvalId = queue.listPending()[0]!.approvalId;
    queue.resolve(approvalId, "deny");
    await expect(promise).resolves.toBe("deny");
  });

  it("does not send a cancel for a delayed approval that never pushed", async () => {
    const queue = createQueue();
    const push = createPushMock();
    const timers = createTimerHarness();
    createApprovalPushBridge({
      approvalQueue: queue,
      push,
      workspaceMemberUserIds: () => MEMBER_USER_IDS,
      shellPresence: {
        isAnyShellActive: () => true,
        markActive: vi.fn(),
        getActiveShellCount: () => 1,
      },
      delayMs: 10_000,
      presenceMaxAgeMs: 6_000,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    const promise = requestCapability(queue);
    const approvalId = queue.listPending()[0]!.approvalId;
    queue.resolve(approvalId, "deny");
    timers.advanceByTime(10_000);
    await flush();

    expect(push.sendToTargets).not.toHaveBeenCalled();
    expect(push.cancel).not.toHaveBeenCalled();
    await expect(promise).resolves.toBe("deny");
  });

  it("does not send a cancel when every push attempt fails", async () => {
    const queue = createQueue();
    const push = createPushMock();
    vi.mocked(push.sendToTargets).mockResolvedValue([
      {
        userId: "user-1",
        clientId: "mobile-1",
        platform: "android",
        sent: false,
        logOnly: false,
        error: "dead token",
      },
    ]);
    createApprovalPushBridge({
      approvalQueue: queue,
      push,
      workspaceMemberUserIds: () => MEMBER_USER_IDS,
      shellPresence: {
        isAnyShellActive: () => false,
        markActive: vi.fn(),
        getActiveShellCount: () => 0,
      },
    });

    const promise = requestCapability(queue);
    await flush();
    const approvalId = queue.listPending()[0]!.approvalId;

    queue.resolve(approvalId, "deny");
    await flush();

    expect(push.cancel).not.toHaveBeenCalled();
    await expect(promise).resolves.toBe("deny");
  });
});
