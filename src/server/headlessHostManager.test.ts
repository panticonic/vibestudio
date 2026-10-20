import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OwnedScope, type OwnedProcess } from "@vibestudio/shared/ownership";
import type { TokenManager } from "@vibestudio/shared/tokenManager";
import { PanelRuntimeCoordinator } from "./panelRuntimeCoordinator.js";
import {
  formatBridgeDiagnostic,
  HeadlessHostManager,
  parseBridgeDiagnostic,
  resolveHeadlessHostEntryPath,
} from "./headlessHostManager.js";

describe("resolveHeadlessHostEntryPath", () => {
  it("uses the exact host artifact generation", () => {
    expect(resolveHeadlessHostEntryPath({ VIBESTUDIO_HOST_ARTIFACT_ROOT: "/opt/generation" })).toBe(
      "/opt/generation/headless-host/main.js"
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
    expect(() => resolveHeadlessHostEntryPath({})).toThrow("VIBESTUDIO_HOST_ARTIFACT_ROOT");
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
    pid: number | undefined = undefined;
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
    /** What the ownership library hands back for this child. */
    readonly owned: OwnedProcess = {
      child: this as unknown as ChildProcess,
      identity: null,
      registered: Promise.resolve(),
      // Graceful retirement: SIGTERM the leader, which exits.
      retire: vi.fn(async () => {
        this.kill("SIGTERM");
      }),
      join: vi.fn(async () => undefined),
    };
  }

  const ENTRY = fileURLToPath(import.meta.url);
  const ownershipOf = (spawnFn: (entry: string) => MockChild) => ({
    scope: new OwnedScope(),
    spawn: vi.fn((_command: string, args: readonly string[]) => spawnFn(String(args.at(-1))).owned),
  });

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
    const spawnFn = vi.fn((_entry: string): MockChild => {
      const child = new MockChild();
      children.push(child);
      if (opts.connect) registerHeadless(`headless-${children.length}`);
      return child;
    });
    const manager = new HeadlessHostManager({
      tokenManager,
      coordinator,
      isHostAvailable: () => true,
      getServerUrl: () => "http://127.0.0.1:0",
      config: {
        enabled: true,
        keepAlive: true,
        entryPath: ENTRY,
        spawnTimeoutMs: 1_000,
      },
      ownership: async () => ownershipOf(spawnFn),
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

  it("does not let an exited child's idle deadline terminate its leased replacement", async () => {
    const { manager, spawnFn } = makeManager({ connect: true });

    await expect(manager.ensureHeadlessHost()).resolves.toMatchObject({
      clientSessionId: "headless-1",
    });
    const first = children[0];
    if (!first) throw new Error("expected the first spawned child");

    coordinator.unregisterClient("headless-1");
    first.exitCode = 1;
    first.emit("exit", 1);

    await expect(manager.ensureHeadlessHost()).resolves.toMatchObject({
      clientSessionId: "headless-2",
    });
    expect(spawnFn).toHaveBeenCalledTimes(2);
    const replacement = children[1];
    if (!replacement) throw new Error("expected the replacement child");
    coordinator.acquire("panel:nav-replacement", {
      slotId: "panel:tree/replacement",
      clientSessionId: "headless-2",
      connectionId: "route-replacement",
    });

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(replacement.owned.retire).not.toHaveBeenCalled();
    expect(coordinator.getLease("panel:nav-replacement")).toMatchObject({
      clientSessionId: "headless-2",
      connectionId: "route-replacement",
    });
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

  it("retires the host and its Chromium group together on stop, with no kill timer", async () => {
    const child = new MockChild();
    child.pid = 4_321;
    const manager = new HeadlessHostManager({
      tokenManager,
      coordinator,
      isHostAvailable: () => true,
      getServerUrl: () => "http://127.0.0.1:0",
      config: { enabled: true, entryPath: ENTRY },
      ownership: async () =>
        ownershipOf(() => {
          registerHeadless("headless-tree");
          return child;
        }),
    });

    await manager.ensureDefaultHost();
    await manager.stop();
    // Nothing is left to escalate after the group is retired.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(child.owned.retire).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("joins the group when the host exits first, so Chromium is not orphaned", async () => {
    const child = new MockChild();
    child.pid = 4_322;
    const manager = new HeadlessHostManager({
      tokenManager,
      coordinator,
      isHostAvailable: () => true,
      getServerUrl: () => "http://127.0.0.1:0",
      config: { enabled: true, entryPath: ENTRY },
      ownership: async () =>
        ownershipOf(() => {
          registerHeadless("headless-crash");
          return child;
        }),
    });

    await manager.ensureDefaultHost();
    child.exitCode = 1;
    child.emit("exit", 1);

    expect(child.owned.join).toHaveBeenCalledOnce();
    expect(child.owned.retire).not.toHaveBeenCalled();
  });

  it("reports a retirement failure through the server's ownership scope", async () => {
    const child = new MockChild();
    const failure = Object.assign(new Error("group survived"), { code: "EOWNERSHIP" });
    child.owned.retire = vi.fn(async () => {
      throw failure;
    });
    const ownership = ownershipOf(() => {
      registerHeadless("headless-fail");
      return child;
    });
    const manager = new HeadlessHostManager({
      tokenManager,
      coordinator,
      isHostAvailable: () => true,
      getServerUrl: () => "http://127.0.0.1:0",
      config: { enabled: true, entryPath: ENTRY },
      ownership: async () => ownership,
    });

    await manager.ensureDefaultHost();
    await expect(manager.stop()).resolves.toBeUndefined();
    await expect(ownership.scope.close()).rejects.toMatchObject({ errors: [failure] });
  });

  it("bounds CDP readiness after the child registers", async () => {
    const spawnFn = vi.fn((_entry: string): MockChild => {
      const child = new MockChild();
      children.push(child);
      return child;
    });
    const manager = new HeadlessHostManager({
      tokenManager,
      coordinator,
      isHostAvailable: () => true,
      getServerUrl: () => "http://127.0.0.1:0",
      config: {
        enabled: true,
        entryPath: ENTRY,
        spawnTimeoutMs: 100,
      },
      ownership: async () => ownershipOf(spawnFn),
    });

    const pending = manager.ensureDefaultHost();
    await vi.advanceTimersByTimeAsync(0);
    expect(spawnFn).toHaveBeenCalledTimes(1);

    const child = children[0];
    if (!child) throw new Error("expected a spawned child");
    child.emit("message", { type: "registered", clientSessionId: "headless-1" });

    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toBeNull();
    expect(child.owned.retire).toHaveBeenCalledOnce();
    await manager.stop();
  });

  it("returns promptly when the child reports its startup failure", async () => {
    const spawnFn = vi.fn((_entry: string): MockChild => {
      const child = new MockChild();
      children.push(child);
      return child;
    });
    const manager = new HeadlessHostManager({
      tokenManager,
      coordinator,
      isHostAvailable: () => true,
      getServerUrl: () => "http://127.0.0.1:0",
      config: {
        enabled: true,
        entryPath: ENTRY,
        spawnTimeoutMs: 60_000,
      },
      ownership: async () => ownershipOf(spawnFn),
    });

    const pending = manager.ensureDefaultHost();
    await vi.advanceTimersByTimeAsync(0);
    const child = children[0];
    if (!child) throw new Error("expected a spawned child");
    child.emit("message", { type: "startup-error", error: "Chromium failed" });
    await vi.advanceTimersByTimeAsync(250);

    await expect(pending).resolves.toBeNull();
    expect(child.owned.retire).toHaveBeenCalledOnce();
    await manager.stop();
  });

  it("degrades gracefully and disables auto-spawn after repeated failures", async () => {
    // Host never connects → each spawn times out and records a failure. After
    // maxRestarts the manager disables itself instead of looping forever.
    const spawnFn = vi.fn((_entry: string): MockChild => {
      const child = new MockChild();
      children.push(child);
      return child;
    });
    const manager = new HeadlessHostManager({
      tokenManager,
      coordinator,
      isHostAvailable: () => true,
      getServerUrl: () => "http://127.0.0.1:0",
      config: {
        enabled: true,
        keepAlive: true,
        entryPath: ENTRY,
        spawnTimeoutMs: 100,
        maxRestarts: 2,
      },
      ownership: async () => ownershipOf(spawnFn),
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
