import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PendingApproval } from "@vibez1/shared/approvals";

const electronMocks = vi.hoisted(() => {
  const notificationInstances: Array<{
    options: { title: string; body: string };
    show: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    handlers: Map<string, () => void>;
  }> = [];

  class FakeNotification {
    static isSupported = vi.fn(() => true);
    options: { title: string; body: string };
    show = vi.fn();
    close = vi.fn();
    handlers = new Map<string, () => void>();
    constructor(options: { title: string; body: string }) {
      this.options = options;
      notificationInstances.push(this);
    }
    on(event: string, handler: () => void) {
      this.handlers.set(event, handler);
      return this;
    }
  }

  return {
    notificationInstances,
    FakeNotification,
    app: {
      setBadgeCount: vi.fn(),
      dock: { bounce: vi.fn() },
    },
  };
});

vi.mock("electron", () => ({
  app: electronMocks.app,
  Notification: electronMocks.FakeNotification,
}));

import { getApprovalCopy } from "@vibez1/shared/approvalCopy";
import { createApprovalAttention } from "./approvalAttention.js";

function makeApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    kind: "capability",
    approvalId: "approval-1",
    callerId: "panel:abc",
    callerKind: "panel",
    callerTitle: "Chat",
    repoPath: "workspace/panels/chat",
    effectiveVersion: "ev-1",
    requestedAt: 1,
    capability: "network",
    title: "Access api.example.com",
    ...overrides,
  } as PendingApproval;
}

function makeStartupUnitApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    kind: "unit-batch",
    approvalId: "startup-unit-approval",
    callerId: "system:units",
    callerKind: "system",
    repoPath: "meta",
    effectiveVersion: "ev-app",
    requestedAt: 1,
    trigger: "startup",
    title: "Approve workspace units",
    description: "Approve units.",
    units: [
      {
        unitKind: "app",
        unitName: "@workspace-apps/mobile",
        displayName: "Mobile",
        target: "react-native",
        source: { kind: "workspace-repo", repo: "apps/mobile", ref: "main" },
        ev: "ev-mobile",
        capabilities: [],
      },
      {
        unitKind: "extension",
        unitName: "@workspace-extensions/native",
        displayName: "Native Extension",
        target: null,
        source: { kind: "workspace-repo", repo: "extensions/native", ref: "main" },
        ev: "ev-extension",
        capabilities: ["native-code"],
      },
    ],
    ...overrides,
  } as PendingApproval;
}

function makeWindow(opts: { focused?: boolean; visible?: boolean } = {}) {
  return {
    isDestroyed: vi.fn(() => false),
    isFocused: vi.fn(() => opts.focused ?? false),
    isVisible: vi.fn(() => opts.visible ?? true),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    flashFrame: vi.fn(),
  };
}

function makeAttention(window: ReturnType<typeof makeWindow> | null, pending?: PendingApproval[]) {
  return createApprovalAttention({
    getWindow: () => window as never,
    listPending: vi.fn(async () => pending ?? null),
    log: { warn: vi.fn() },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  electronMocks.notificationInstances.length = 0;
});

describe("createApprovalAttention", () => {
  it("tracks the badge count and clears attention when the queue drains", () => {
    const window = makeWindow({ focused: false });
    const attention = makeAttention(window);

    attention.handlePendingChanged([makeApproval(), makeApproval({ approvalId: "approval-2" })]);
    expect(electronMocks.app.setBadgeCount).toHaveBeenCalledWith(2);

    attention.handlePendingChanged([]);
    expect(electronMocks.app.setBadgeCount).toHaveBeenLastCalledWith(0);
    expect(window.flashFrame).toHaveBeenLastCalledWith(false);
  });

  it("ignores startup privileged-unit approvals owned by target launch", () => {
    const window = makeWindow({ focused: false });
    const attention = makeAttention(window);

    attention.handlePendingChanged([makeStartupUnitApproval()]);

    expect(electronMocks.app.setBadgeCount).toHaveBeenCalledWith(0);
    expect(window.flashFrame).not.toHaveBeenCalledWith(true);
    expect(electronMocks.notificationInstances).toHaveLength(0);
  });

  it("flashes and notifies for a new approval while the window is unfocused", () => {
    const window = makeWindow({ focused: false });
    const attention = makeAttention(window);

    attention.handlePendingChanged([makeApproval()]);

    expect(window.flashFrame).toHaveBeenCalledWith(true);
    const [notification] = electronMocks.notificationInstances;
    expect(notification).toBeDefined();
    expect(notification!.options.title).toBe(getApprovalCopy(makeApproval()).title);
    expect(notification!.options.body).toContain("Chat");
    expect(notification!.show).toHaveBeenCalled();
  });

  it("stays silent when the window is focused and visible", () => {
    const window = makeWindow({ focused: true, visible: true });
    const attention = makeAttention(window);

    attention.handlePendingChanged([makeApproval()]);

    expect(window.flashFrame).not.toHaveBeenCalled();
    expect(electronMocks.notificationInstances).toHaveLength(0);
    expect(electronMocks.app.setBadgeCount).toHaveBeenCalledWith(1);
  });

  it("does not re-alert for approvals it has already seen", () => {
    const window = makeWindow({ focused: false });
    const attention = makeAttention(window);

    attention.handlePendingChanged([makeApproval()]);
    electronMocks.notificationInstances.length = 0;

    attention.handlePendingChanged([makeApproval()]);
    expect(electronMocks.notificationInstances).toHaveLength(0);

    attention.handlePendingChanged([makeApproval(), makeApproval({ approvalId: "approval-2" })]);
    expect(electronMocks.notificationInstances).toHaveLength(1);
  });

  it("quiet refresh seeds the seen-set and badge without alerting", async () => {
    const window = makeWindow({ focused: false });
    const attention = makeAttention(window, [makeApproval()]);

    await attention.refresh({ quiet: true });

    expect(electronMocks.app.setBadgeCount).toHaveBeenCalledWith(1);
    expect(window.flashFrame).not.toHaveBeenCalled();
    expect(electronMocks.notificationInstances).toHaveLength(0);

    // The same approval arriving via the event stream is not "new" anymore.
    attention.handlePendingChanged([makeApproval()]);
    expect(electronMocks.notificationInstances).toHaveLength(0);
  });

  it("stops flashing on window focus and focuses the shell on notification click", () => {
    const window = makeWindow({ focused: false });
    const attention = makeAttention(window);

    attention.handlePendingChanged([makeApproval()]);
    attention.handleWindowFocus();
    expect(window.flashFrame).toHaveBeenLastCalledWith(false);

    const [notification] = electronMocks.notificationInstances;
    notification!.handlers.get("click")?.();
    expect(window.show).toHaveBeenCalled();
    expect(window.focus).toHaveBeenCalled();
  });
});
