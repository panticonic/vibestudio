import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { createConnectDeepLink, createConnectPairUrl } from "@vibestudio/shared/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceCredentialEntry } from "./services/deviceCredentialStore.js";

vi.mock("./paths.js", () => ({
  getServerProcessEntryPath: () => "/tmp/server-entry.js",
  getEsbuildBinaryPath: () => null,
}));

vi.mock("@vibestudio/env-paths", () => ({
  getCentralDataPath: () => "/tmp/vibestudio-hub-manager-test",
}));

const credentialStore = {
  loadDeviceCredentialByServerId: vi.fn(),
  loadPendingLoopbackPairing: vi.fn(),
  saveDeviceCredential: vi.fn(),
  savePendingLoopbackPairing: vi.fn(),
};
vi.mock("./services/deviceCredentialStore.js", () => ({
  loadDeviceCredentialByServerId: (...args: unknown[]) =>
    credentialStore.loadDeviceCredentialByServerId(...args),
  loadPendingLoopbackPairing: (...args: unknown[]) =>
    credentialStore.loadPendingLoopbackPairing(...args),
  saveDeviceCredential: (...args: unknown[]) => credentialStore.saveDeviceCredential(...args),
  savePendingLoopbackPairing: (...args: unknown[]) =>
    credentialStore.savePendingLoopbackPairing(...args),
}));

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { HubProcessManager, parseHubReadyFile } from "./hubProcessManager.js";

const SERVER_ID = `srv_${"S".repeat(24)}`;
const SERVER_BOOT_ID = `boot_${"B".repeat(24)}`;
const RECORD = {
  gatewayPort: 5000,
  pid: 99_999_999,
  serverId: SERVER_ID,
  serverBootId: SERVER_BOOT_ID,
  startedAt: 1000,
  version: "1.2.3",
};

function readyInvite(kind: "desktop" | "mobile") {
  const pairing = {
    room: `room-${kind}`,
    fp: "AA".repeat(32),
    sig: "wss://signal.example/",
    code: (kind === "desktop" ? "D" : "M").repeat(32),
    v: 2 as const,
    ice: "all" as const,
  };
  return {
    ...pairing,
    deepLink: createConnectDeepLink(pairing),
    pairUrl: createConnectPairUrl(pairing),
    expiresInMs: 60_000,
    expiresAt: 2_000_000_000_000,
    serverId: SERVER_ID,
    serverBootId: SERVER_BOOT_ID,
  };
}

function makeCentralData(initial: typeof RECORD | null = RECORD) {
  let record: typeof RECORD | null = initial;
  return {
    getHubRuntime: vi.fn(() => record),
    setHubRuntime: vi.fn((next: typeof RECORD) => {
      record = next;
    }),
    clearHubRuntime: vi.fn(() => {
      record = null;
    }),
  };
}

function manager(centralData: ReturnType<typeof makeCentralData>) {
  return new HubProcessManager({
    workspaceName: "alpha",
    appRoot: "/tmp/app",
    appVersion: "1.2.3",
    centralData: centralData as never,
    onCrash: vi.fn(),
  });
}

beforeEach(() => {
  spawnMock.mockReset();
  credentialStore.loadDeviceCredentialByServerId.mockReset();
  credentialStore.loadPendingLoopbackPairing.mockReset();
  credentialStore.saveDeviceCredential.mockReset();
  credentialStore.savePendingLoopbackPairing.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("HubProcessManager", () => {
  it("accepts only the canonical secret-free ready contract", () => {
    const canonical = {
      mode: "hub",
      gatewayUrl: "http://127.0.0.1:5000",
      connectUrl: "http://127.0.0.1:5000",
      rootInvites: { desktop: readyInvite("desktop"), mobile: readyInvite("mobile") },
      serverId: SERVER_ID,
      serverBootId: SERVER_BOOT_ID,
      gatewayPort: 5000,
      pid: 42,
      version: "1.2.3",
      workspaces: [],
    };
    expect(parseHubReadyFile(canonical)).toEqual(canonical);
    expect(() => parseHubReadyFile({ ...canonical, adminToken: "secret" })).toThrow(
      /canonical contract/
    );
    expect(() => parseHubReadyFile({ ...canonical, rootInvites: {} })).toThrow(
      /canonical contract/
    );
    expect(() =>
      parseHubReadyFile({
        ...canonical,
        rootInvites: {
          ...canonical.rootInvites,
          desktop: { ...canonical.rootInvites.desktop, ice: undefined },
        },
      })
    ).toThrow(/canonical contract/);
    expect(() =>
      parseHubReadyFile({
        ...canonical,
        rootInvites: {
          ...canonical.rootInvites,
          desktop: { ...canonical.rootInvites.desktop, url: "https://legacy.example" },
        },
      })
    ).toThrow(/canonical contract/);
  });

  it("attaches to the hub and routes the global device into the selected child", async () => {
    credentialStore.loadDeviceCredentialByServerId.mockReturnValue({
      serverId: RECORD.serverId,
      transport: "loopback",
      deviceId: "dev-1",
      refreshToken: "refresh-1",
      pairedAt: 1,
    });
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/healthz")) {
        return Response.json({
          ok: true,
          mode: "hub",
          serverId: RECORD.serverId,
          serverBootId: SERVER_BOOT_ID,
          gatewayPort: RECORD.gatewayPort,
          pid: RECORD.pid,
          version: RECORD.version,
        });
      }
      if (url.endsWith("/_r/s/auth/refresh-shell")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          deviceId: "dev-1",
          refreshToken: "refresh-1",
        });
        return Response.json({ shellToken: "shell-session" });
      }
      expect(url).toBe("http://127.0.0.1:5000/rpc");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer shell-session" });
      expect(JSON.parse(String(init?.body))).toEqual({
        method: "hubControl.routeWorkspace",
        args: [{ workspace: "alpha" }],
      });
      return Response.json({
        result: {
          workspace: "alpha",
          workspaceId: "ws_alpha",
          serverUrl: "http://127.0.0.1:5000/_r/ws/alpha",
          serverBootId: "child-boot",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const centralData = makeCentralData();

    const target = await manager(centralData).attachOrSpawn();

    expect(target).toMatchObject({
      attached: true,
      workspaceId: "ws_alpha",
      authToken: "refresh:dev-1:refresh-1",
      wsUrl: "ws://127.0.0.1:5000/_r/ws/alpha/rpc",
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("fails closed when an initialized hub has no credential for this desktop", async () => {
    credentialStore.loadDeviceCredentialByServerId.mockReturnValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ok: true,
          mode: "hub",
          serverId: RECORD.serverId,
          serverBootId: RECORD.serverBootId,
          gatewayPort: RECORD.gatewayPort,
          pid: RECORD.pid,
          version: RECORD.version,
        })
      )
    );

    await expect(manager(makeCentralData()).attachOrSpawn()).rejects.toThrow(
      "desktop is not paired"
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects health metadata that points at a different PID without signaling it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ok: true,
          mode: "hub",
          serverId: RECORD.serverId,
          serverBootId: RECORD.serverBootId,
          gatewayPort: RECORD.gatewayPort,
          pid: RECORD.pid + 1,
          version: RECORD.version,
        })
      )
    );
    const killMock = vi.spyOn(process, "kill");

    await expect(manager(makeCentralData()).attachOrSpawn()).rejects.toThrow(
      /does not match recorded process/
    );
    expect(killMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("replays the prepared root credential after final persistence fails", async () => {
    let pending: Record<string, unknown> | null = null;
    credentialStore.loadDeviceCredentialByServerId.mockReturnValue(null);
    credentialStore.loadPendingLoopbackPairing.mockImplementation(() => pending);
    credentialStore.savePendingLoopbackPairing.mockImplementation((value) => {
      pending = value as Record<string, unknown>;
    });
    credentialStore.saveDeviceCredential
      .mockImplementationOnce(() => {
        throw new Error("keychain unavailable");
      })
      .mockImplementation(() => undefined);
    const posted: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        posted.push(body);
        return Response.json({
          deviceId: body["deviceId"],
          refreshToken: body["refreshToken"],
        });
      })
    );
    const processManager = manager(makeCentralData());
    const ensure = (
      processManager as unknown as {
        ensureDeviceCredential(target: {
          record: typeof RECORD;
          rootInviteCode: string | null;
          rootInviteExpiresAt: number | null;
          attached: boolean;
        }): Promise<DeviceCredentialEntry>;
      }
    ).ensureDeviceCredential.bind(processManager);
    const freshTarget = {
      record: RECORD,
      rootInviteCode: "D".repeat(32),
      rootInviteExpiresAt: Date.now() + 60_000,
      attached: false,
    };

    await expect(ensure(freshTarget)).rejects.toThrow(/keychain unavailable/);
    expect(pending).toMatchObject({
      serverId: SERVER_ID,
      transport: "pending-loopback",
      inviteCode: "D".repeat(32),
    });

    await expect(
      ensure({ ...freshTarget, rootInviteCode: null, rootInviteExpiresAt: null, attached: true })
    ).resolves.toMatchObject({
      serverId: SERVER_ID,
      transport: "loopback",
      deviceId: pending?.["deviceId"],
      refreshToken: pending?.["refreshToken"],
    });
    expect(posted).toHaveLength(2);
    expect(posted[1]).toEqual(posted[0]);
    expect(credentialStore.savePendingLoopbackPairing).toHaveBeenCalledTimes(1);
    expect(credentialStore.saveDeviceCredential).toHaveBeenCalledTimes(2);
  });

  it("clears a dead hub record before attempting a clean hub spawn", async () => {
    credentialStore.loadDeviceCredentialByServerId.mockReturnValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("refused")))
    );
    const child = new EventEmitter() as EventEmitter & { pid: number; unref(): void };
    child.pid = 42;
    child.unref = () => undefined;
    spawnMock.mockImplementation(() => {
      setTimeout(() => child.emit("exit", 1), 0);
      return child;
    });
    const centralData = makeCentralData();

    await expect(manager(centralData).attachOrSpawn()).rejects.toThrow(
      "Local hub exited during startup"
    );
    expect(centralData.clearHubRuntime).toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      "--max-old-space-size=4096",
      "/tmp/server-entry.js",
      "--ready-file",
      "/tmp/vibestudio-hub-manager-test/server-auth/hub-ready.json",
      "--bootstrap-workspace",
      "alpha",
    ]);
  });

  it("never terminates a live PID whose hub identity cannot be verified", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("hung")))
    );
    const killMock = vi.spyOn(process, "kill").mockImplementation(((pid, signal) => {
      expect(pid).toBe(RECORD.pid);
      if (signal === 0) return true;
      throw new Error(`Unexpected signal ${String(signal)}`);
    }) as typeof process.kill);

    await expect(manager(makeCentralData()).attachOrSpawn()).rejects.toThrow(
      /could not be verified/
    );

    expect(killMock).toHaveBeenCalledWith(RECORD.pid, 0);
    expect(killMock).not.toHaveBeenCalledWith(RECORD.pid, "SIGTERM");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("terminates a spawned hub and deletes its ready file when the ready contract is invalid", async () => {
    const readyFile = "/tmp/vibestudio-hub-manager-test/server-auth/hub-ready.json";
    let childAlive = true;
    const killMock = vi.spyOn(process, "kill").mockImplementation(((pid, signal) => {
      expect(pid).toBe(42);
      if (signal === 0) {
        if (childAlive) return true;
        throw Object.assign(new Error("not found"), { code: "ESRCH" });
      }
      if (signal === "SIGTERM") {
        childAlive = false;
        return true;
      }
      throw new Error(`Unexpected signal ${String(signal)}`);
    }) as typeof process.kill);
    const child = new EventEmitter() as EventEmitter & { pid: number; unref(): void };
    child.pid = 42;
    child.unref = () => undefined;
    spawnMock.mockImplementation(() => {
      fs.writeFileSync(readyFile, JSON.stringify({ mode: "legacy" }));
      const future = new Date(Date.now() + 1_000);
      fs.utimesSync(readyFile, future, future);
      return child;
    });
    const centralData = makeCentralData(null);

    const processManager = manager(centralData);
    const spawnDetached = (
      processManager as unknown as {
        spawnDetached(preferredGatewayPort?: number): Promise<unknown>;
      }
    ).spawnDetached.bind(processManager);
    await expect(spawnDetached(RECORD.gatewayPort)).rejects.toThrow(/canonical contract/);

    expect(killMock).toHaveBeenCalledWith(42, "SIGTERM");
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({
      env: { VIBESTUDIO_GATEWAY_PORT: String(RECORD.gatewayPort) },
    });
    expect(fs.existsSync(readyFile)).toBe(false);
    expect(centralData.setHubRuntime).not.toHaveBeenCalled();
  });
});
