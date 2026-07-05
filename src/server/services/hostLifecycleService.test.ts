/**
 * hostLifecycle service + idle-exit monitor unit tests.
 *
 * - `shutdown` is shell/server-gated (a panel caller throws) and defers the
 *   actual shutdown past the RPC ack (setTimeout(…, 25)).
 * - `startIdleExitMonitor` exits only after a continuous idle window with no
 *   connected clients and no active runs; it resets mid-window when activity
 *   reappears, is disabled for `idleExitMs <= 0`, and stops on `stop()`.
 */

import { describe, it, expect, vi } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { createActivityRegistry } from "./activityRegistry.js";
import { createHostLifecycleService, startIdleExitMonitor } from "./hostLifecycleService.js";

const shellCtx: ServiceContext = { caller: createVerifiedCaller("shell", "shell") };
const panelCtx: ServiceContext = { caller: createVerifiedCaller("panel-1", "panel") };

describe("createHostLifecycleService", () => {
  it("rejects shutdown from a non-shell/server caller", async () => {
    const shutdown = vi.fn();
    const service = createHostLifecycleService({ shutdown });

    await expect(service.handler(panelCtx, "shutdown", [])).rejects.toThrow("shell-only");
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("defers shutdown past the RPC ack for a shell caller", async () => {
    vi.useFakeTimers();
    try {
      const shutdown = vi.fn();
      const service = createHostLifecycleService({ shutdown });

      await service.handler(shellCtx, "shutdown", []);
      // Returns before the deferred shutdown fires.
      expect(shutdown).not.toHaveBeenCalled();

      vi.advanceTimersByTime(25);
      expect(shutdown).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("startIdleExitMonitor", () => {
  it("shuts down after a continuous idle window", () => {
    vi.useFakeTimers();
    try {
      let t = 0;
      const shutdown = vi.fn();
      const monitor = startIdleExitMonitor({
        activity: createActivityRegistry(),
        hasConnectedClients: () => false,
        shutdown,
        idleExitMs: 1000,
        checkIntervalMs: 100,
        now: () => t,
      });

      // First tick sets idleSince at t=100, so the window closes at t=1100.
      for (let i = 0; i < 10; i++) {
        t += 100;
        vi.advanceTimersByTime(100);
      }
      expect(shutdown).not.toHaveBeenCalled();

      t += 100; // now - idleSince == 1000
      vi.advanceTimersByTime(100);
      expect(shutdown).toHaveBeenCalledTimes(1);

      monitor.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not shut down while clients are connected", () => {
    vi.useFakeTimers();
    try {
      let t = 0;
      const shutdown = vi.fn();
      const monitor = startIdleExitMonitor({
        activity: createActivityRegistry(),
        hasConnectedClients: () => true,
        shutdown,
        idleExitMs: 500,
        checkIntervalMs: 100,
        now: () => t,
      });
      for (let i = 0; i < 20; i++) {
        t += 100;
        vi.advanceTimersByTime(100);
      }
      expect(shutdown).not.toHaveBeenCalled();
      monitor.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not shut down while background runs are active", () => {
    vi.useFakeTimers();
    try {
      let t = 0;
      const activity = createActivityRegistry(() => t);
      activity.begin("eval:a");
      const shutdown = vi.fn();
      const monitor = startIdleExitMonitor({
        activity,
        hasConnectedClients: () => false,
        shutdown,
        idleExitMs: 500,
        checkIntervalMs: 100,
        now: () => t,
      });
      for (let i = 0; i < 20; i++) {
        t += 100;
        vi.advanceTimersByTime(100);
      }
      expect(shutdown).not.toHaveBeenCalled();
      monitor.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets the idle window when activity reappears mid-window", () => {
    vi.useFakeTimers();
    try {
      let t = 0;
      let clients = false;
      const shutdown = vi.fn();
      const monitor = startIdleExitMonitor({
        activity: createActivityRegistry(),
        hasConnectedClients: () => clients,
        shutdown,
        idleExitMs: 1000,
        checkIntervalMs: 100,
        now: () => t,
      });

      // Idle for 500ms.
      for (let i = 0; i < 5; i++) {
        t += 100;
        vi.advanceTimersByTime(100);
      }
      // A client reappears — resets the idle window.
      clients = true;
      t += 100;
      vi.advanceTimersByTime(100);
      clients = false;

      // Idle again. The next tick (t=700) sets a fresh idleSince, so the window
      // closes at t=1700 — proving the earlier idle time did not carry over.
      for (let i = 0; i < 10; i++) {
        t += 100;
        vi.advanceTimersByTime(100);
      }
      expect(shutdown).not.toHaveBeenCalled();

      // One more tick completes the fresh window.
      t += 100;
      vi.advanceTimersByTime(100);
      expect(shutdown).toHaveBeenCalledTimes(1);
      monitor.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is disabled for idleExitMs <= 0", () => {
    vi.useFakeTimers();
    try {
      const shutdown = vi.fn();
      const monitor = startIdleExitMonitor({
        activity: createActivityRegistry(),
        hasConnectedClients: () => false,
        shutdown,
        idleExitMs: 0,
        checkIntervalMs: 100,
      });
      vi.advanceTimersByTime(10_000);
      expect(shutdown).not.toHaveBeenCalled();
      monitor.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops firing after stop()", () => {
    vi.useFakeTimers();
    try {
      let t = 0;
      const shutdown = vi.fn();
      const monitor = startIdleExitMonitor({
        activity: createActivityRegistry(),
        hasConnectedClients: () => false,
        shutdown,
        idleExitMs: 1000,
        checkIntervalMs: 100,
        now: () => t,
      });
      t += 200;
      vi.advanceTimersByTime(200);
      monitor.stop();
      t += 5000;
      vi.advanceTimersByTime(5000);
      expect(shutdown).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
