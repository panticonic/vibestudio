import { describe, expect, it, vi } from "vitest";
import {
  replyNotificationOf,
  showNativeReplyNotification,
  type NativeReplyDeps,
} from "./nativeNotificationReply.js";

const payload = {
  id: "agent-ask:1",
  title: "Agent asks",
  message: "Which branch?",
  actions: [
    { id: "open", label: "Open" },
    { id: "answer", label: "Reply", input: "text" },
  ],
};

function deps(platform: NodeJS.Platform, report = vi.fn(async () => undefined)) {
  const handlers = new Map<string, (...args: never[]) => void>();
  const native = {
    on: vi.fn((event: string, listener: (...args: never[]) => void) =>
      handlers.set(event, listener)
    ),
    show: vi.fn(),
  };
  const create = vi.fn(() => native);
  const value: NativeReplyDeps = {
    platform,
    isSupported: () => true,
    create,
    report,
    replied: vi.fn(),
    failed: vi.fn(),
    focus: vi.fn(),
  };
  return { value, native, create, handlers, report };
}

describe("native notification reply", () => {
  it("finds the reply-taking action and ignores notifications without one", () => {
    expect(replyNotificationOf(payload)).toMatchObject({
      id: "agent-ask:1",
      action: { id: "answer", label: "Reply" },
    });
    expect(replyNotificationOf({ id: "x", actions: [{ id: "a", label: "A" }] })).toBeNull();
    expect(replyNotificationOf(null)).toBeNull();
  });

  it("shows a macOS notification with a reply field and reports the reply as the action", async () => {
    const d = deps("darwin");
    const reply = replyNotificationOf(payload)!;
    expect(showNativeReplyNotification(reply, d.value)).toBe(true);
    expect(d.create).toHaveBeenCalledWith({
      title: "Agent asks",
      body: "Which branch?",
      hasReply: true,
      replyPlaceholder: "Reply",
    });
    d.handlers.get("reply")?.({} as never, "main" as never);
    await vi.waitFor(() => expect(d.value.replied).toHaveBeenCalledWith("agent-ask:1"));
    expect(d.report).toHaveBeenCalledWith("agent-ask:1", "answer", "main");
  });

  it("surfaces a failed report instead of dropping the reply", async () => {
    const failure = new Error("not trusted");
    const d = deps(
      "darwin",
      vi.fn(async () => Promise.reject(failure))
    );
    showNativeReplyNotification(replyNotificationOf(payload)!, d.value);
    d.handlers.get("reply")?.({} as never, "x" as never);
    await vi.waitFor(() => expect(d.value.failed).toHaveBeenCalledWith("agent-ask:1", failure));
    expect(d.value.replied).not.toHaveBeenCalled();
  });

  it("leaves the reply to the in-app notification bar on other platforms", () => {
    for (const platform of ["linux", "win32"] as const) {
      const d = deps(platform);
      expect(showNativeReplyNotification(replyNotificationOf(payload)!, d.value)).toBe(false);
      expect(d.create).not.toHaveBeenCalled();
    }
  });
});
