import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenManager } from "@vibestudio/shared/tokenManager";
import { PanelRuntimeCoordinator } from "./panelRuntimeCoordinator.js";
import {
  formatBridgeDiagnostic,
  HeadlessHostManager,
  parseBridgeDiagnostic,
  resolveHeadlessHostEntryPath,
} from "./headlessHostManager.js";

describe("resolveHeadlessHostEntryPath", () => {
  it("uses the single app-root build contract", () => {
    expect(resolveHeadlessHostEntryPath({ VIBESTUDIO_APP_ROOT: "/opt/vibestudio" })).toBe(
      "/opt/vibestudio/dist/headless-host/main.js"
    );
  });

  it("allows an exact absolute entry override for tests and operators", () => {
    expect(
      resolveHeadlessHostEntryPath({ VIBESTUDIO_HEADLESS_HOST_ENTRY: "/repo/fixtures/headless.js" })
    ).toBe("/repo/fixtures/headless.js");
  });

  it("rejects a relative entry override instead of resolving it from cwd", () => {
    expect(() =>
      resolveHeadlessHostEntryPath({
        VIBESTUDIO_APP_ROOT: "/opt/vibestudio",
        VIBESTUDIO_HEADLESS_HOST_ENTRY: "./fixtures/headless.js",
      })
    ).toThrow("must be an absolute executable path");
  });

  it("does not infer the host artifact from cwd", () => {
    expect(() => resolveHeadlessHostEntryPath({})).toThrow(
      "process working directory is not an execution input"
    );
  });
});

describe("headless host bridge diagnostics", () => {
  it("formats the admitted phase without obsolete message-authentication flags", () => {
    const diagnostic = parseBridgeDiagnostic({
      state: "admitted",
      attempt: 2,
      url: "wss://server.example/api/cdp-host",
      authSent: true,
      authenticated: true,
      lastMessageType: "cdp:command",
    });

    expect(diagnostic).toEqual({
      state: "admitted",
      attempt: 2,
      url: "wss://server.example/api/cdp-host",
      lastMessageType: "cdp:command",
    });
    expect(formatBridgeDiagnostic(diagnostic!)).toBe(
      "phase=admitted attempt=2 url=wss://server.example/api/cdp-host lastMessage=cdp:command"
    );
  });

  it("does not revive obsolete authentication phases from child IPC", () => {
    expect(
      parseBridgeDiagnostic({
        state: "authenticating",
        opened: true,
        authSent: true,
        authenticated: false,
      })
    ).toBeNull();
  });

  it("preserves retry context in operator-facing output", () => {
    expect(
      formatBridgeDiagnostic({
        state: "retrying",
        attempt: 3,
        lastError: "failed to get token: unavailable",
        nextRetryMs: 1_000,
      })
    ).toBe("phase=retrying attempt=3 error=failed to get token: unavailable nextRetryMs=1000");
  });
});

/**
 * Always-on headless host: startKeepAlive spawns one at boot and re-spawns it
 * when the child exits, so a programmatic panel always has a default CDP host
 * to lease to. Spawn failures degrade gracefully (no throw, no hang).
 */
describe("HeadlessHostManager keep-alive", () => {
  let coordinator: PanelRuntimeCoordinator;
  let children: MockChild[];

  class MockChild extends EventEmitter {
    exitCode: number | null = null;
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    send = vi.fn();
    kill = vi.fn((_signal?: string) => {
      this.exitCode = 0;
      // Defer the exit event so listeners attached after construction still fire.
      queueMicrotask(() => this.emit("exit", 0));
      return true;
    });
  }

  const tokenManager = {
    ensureToken: vi.fn(() => "token"),
  } as unknown as TokenManager;

  // Registering a headless client makes coordinator.getDefaultCdpHostClient
  // resolve — i.e. the spawned host "connected".
  const registerHeadless = (sessionId: string) => {
    coordinator.registerClient({
      clientSessionId: sessionId,
      hostConnectionId: sessionId,
      label: "Headless",
      platform: "headless",
      loadOnLeaseAssignment: true,
    });
  };

  const registerDesktop = (sessionId: string) => {
    coordinator.registerClient({
      clientSessionId: sessionId,
      hostConnectionId: sessionId,
      label: "Desktop",
      platform: "desktop",
      loadOnLeaseAssignment: true,
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    coordinator = new PanelRuntimeCoordinator();
    children = [];
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function makeManager(opts: { connect: boolean }) {
    const spawnFn = vi.fn((_entry: string): ChildProcess => {
      const child = new MockChild();
      children.push(child);
      if (opts.connect) registerHeadless(`headless-${children.length}`);
      return child as unknown as ChildProcess;
    });
    const manager = new HeadlessHostManager({
      tokenManager,
      coordinator,
      isHostAvailable: () => true,
      getServerUrl: () => "http://127.0.0.1:0",
      config: {
        enabled: true,
        keepAlive: true,
        entryPath: "/fake/entry.js",
        spawnTimeoutMs: 1_000,
      },
      spawnFn,
    });
    return { manager, spawnFn };
  }

  it("spawns a host on startKeepAlive", async () => {
    const { manager, spawnFn } = makeManager({ connect: true });
    manager.startKeepAlive();
    await vi.advanceTimersByTimeAsync(0);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    await manager.stop();
  });

  it("spawns a headless host when a desktop CDP host is already connected", async () => {
    registerDesktop("desktop-1");
    const { manager, spawnFn } = makeManager({ connect: true });

    await expect(manager.ensureHeadlessHost()).resolves.toMatchObject({
      clientSessionId: "headless-1",
      platform: "headless",
    });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    await manager.stop();
  });

  it("re-spawns the host after the child exits", async () => {
    const { manager, spawnFn } = makeManager({ connect: true });
    manager.startKeepAlive();
    await vi.advanceTimersByTimeAsync(0);
    expect(spawnFn).toHaveBeenCalledTimes(1);

    // Simulate the host process dying — and its client deregistering, so the
    // coordinator no longer reports an available default host.
    const first = children[0];
    if (!first) throw new Error("expected a spawned child");
    coordinator.unregisterClient("headless-1");
    first.exitCode = 1;
    first.emit("exit", 1);

    // Respawn is scheduled with a small backoff.
    await vi.advanceTimersByTimeAsync(300);
    expect(spawnFn).toHaveBeenCalledTimes(2);
    await manager.stop();
  });

  it("does not re-spawn after stop()", async () => {
    const { manager, spawnFn } = makeManager({ connect: true });
    manager.startKeepAlive();
    await vi.advanceTimersByTimeAsync(0);
    expect(spawnFn).toHaveBeenCalledTimes(1);

    await manager.stop();
    spawnFn.mockClear();

    // Any pending exit/respawn must be a no-op once stopped.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("terminates the detached host and Chromium process group together", async () => {
    const child = new MockChild() as MockChild & { pid: number };
    child.pid = 4_321;
    const signalProcessGroup = vi.fn();
    const manager = new HeadlessHostManager({
      tokenManager,
      coordinator,
      isHostAvailable: () => true,
      getServerUrl: () => "http://127.0.0.1:0",
      config: {
        enabled: true,
        entryPath: "/fake/entry.js",
      },
      spawnFn: () => {
        registerHeadless("headless-tree");
        return child as unknown as ChildProcess;
      },
      signalProcessGroup,
    });

    await manager.ensureDefaultHost();
    await manager.stop();

    expect(signalProcessGroup).toHaveBeenCalledWith(4_321, "SIGTERM");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("terminates Chromium when the detached host exits first", async () => {
    const child = new MockChild() as MockChild & { pid: number };
    child.pid = 4_322;
    const signalProcessGroup = vi.fn();
    const manager = new HeadlessHostManager({
      tokenManager,
      coordinator,
      isHostAvailable: () => true,
      getServerUrl: () => "http://127.0.0.1:0",
      config: {
        enabled: true,
        entryPath: "/fake/entry.js",
      },
      spawnFn: () => {
        registerHeadless("headless-crash");
        return child as unknown as ChildProcess;
      },
      signalProcessGroup,
    });

    await manager.ensureDefaultHost();
    child.exitCode = 1;
    child.emit("exit", 1);

    expect(signalProcessGroup).toHaveBeenCalledWith(4_322, "SIGTERM");
  });

  it("keeps a registered child alive past the registration timeout while waiting for CDP readiness", async () => {
    const spawnFn = vi.fn((_entry: string): ChildProcess => {
      const child = new MockChild();
      children.push(child);
      return child as unknown as ChildProcess;
    });
    const manager = new HeadlessHostManager({
      tokenManager,
      coordinator,
      isHostAvailable: () => true,
      getServerUrl: () => "http://127.0.0.1:0",
      config: {
        enabled: true,
        entryPath: "/fake/entry.js",
        spawnTimeoutMs: 100,
      },
      spawnFn,
    });

    const pending = manager.ensureDefaultHost();
    await vi.advanceTimersByTimeAsync(0);
    expect(spawnFn).toHaveBeenCalledTimes(1);

    const child = children[0];
    if (!child) throw new Error("expected a spawned child");
    child.emit("message", { type: "registered", clientSessionId: "headless-1" });

    await vi.advanceTimersByTimeAsync(250);
    expect(child.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).not.toHaveBeenCalled();

    registerHeadless("headless-1");
    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toMatchObject({ clientSessionId: "headless-1" });
    await manager.stop();
  });

  it("degrades gracefully and disables auto-spawn after repeated failures", async () => {
    // Host never connects → each spawn times out and records a failure. After
    // maxRestarts the manager disables itself instead of looping forever.
    const spawnFn = vi.fn((_entry: string): ChildProcess => {
      const child = new MockChild();
      children.push(child);
      return child as unknown as ChildProcess;
    });
    const manager = new HeadlessHostManager({
      tokenManager,
      coordinator,
      isHostAvailable: () => true,
      getServerUrl: () => "http://127.0.0.1:0",
      config: {
        enabled: true,
        keepAlive: true,
        entryPath: "/fake/entry.js",
        spawnTimeoutMs: 100,
        maxRestarts: 2,
      },
      spawnFn,
    });

    manager.startKeepAlive();
    // Drive several spawn/timeout/backoff cycles; must settle (disabled), not hang.
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
    }
    // Disabled after maxRestarts: spawn count is bounded, not unbounded.
    expect(spawnFn.mock.calls.length).toBeLessThanOrEqual(2);
    await manager.stop();
  });
});
