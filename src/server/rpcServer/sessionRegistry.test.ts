import { describe, expect, it, vi } from "vitest";
import { SessionRegistry } from "./sessionRegistry.js";

describe("SessionRegistry", () => {
  it("tracks connection lifecycle and expires disconnected sessions after their ttl", () => {
    vi.useFakeTimers();
    try {
      const onSessionExpire = vi.fn();
      const sessions = new SessionRegistry({
        ttlMs: { panel: 100 },
        onSessionExpire,
      });

      sessions.markConnected("panel-a", "panel");
      sessions.markDisconnected("panel-a", "panel");

      vi.advanceTimersByTime(99);
      expect(onSessionExpire).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(onSessionExpire).toHaveBeenCalledWith("panel-a", "panel");
      expect(sessions.hasSession("panel-a")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a session alive when another connection remains connected", () => {
    vi.useFakeTimers();
    try {
      const onSessionExpire = vi.fn();
      const sessions = new SessionRegistry({
        ttlMs: { shell: 100 },
        onSessionExpire,
      });

      sessions.markConnected("shell", "shell");
      sessions.markConnected("shell", "shell");
      sessions.markDisconnected("shell", "shell");

      vi.advanceTimersByTime(100);
      expect(onSessionExpire).not.toHaveBeenCalled();
      expect(sessions.hasSession("shell")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records and consumes pending response origins", () => {
    const sessions = new SessionRegistry();
    sessions.recordPendingResponse("panel-a", "panel", "req-1", {
      callerId: "panel-a",
      connectionId: "conn-1",
    });

    expect(sessions.takePendingResponse("panel-a", "req-1")).toEqual({
      callerId: "panel-a",
      connectionId: "conn-1",
    });
    expect(sessions.takePendingResponse("panel-a", "req-1")).toBeUndefined();
  });
});
