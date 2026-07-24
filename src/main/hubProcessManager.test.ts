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
  saveDeviceCredential: vi.fn(),
};
vi.mock("./services/deviceCredentialStore.js", () => ({
  loadDeviceCredentialByServerId: (...args: unknown[]) =>
    credentialStore.loadDeviceCredentialByServerId(...args),
  saveDeviceCredential: (...args: unknown[]) => credentialStore.saveDeviceCredential(...args),
}));

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { getLocalHubLogPath, HubProcessManager, parseHubReadyFile } from "./hubProcessManager.js";

const SERVER_ID = `srv_${"S".repeat(24)}`;
const SERVER_BOOT_ID = `boot_${"B".repeat(24)}`;
const CHILD_SERVER_ID = `srv_${"C".repeat(24)}`;
const CHILD_SERVER_BOOT_ID = `boot_${"C".repeat(24)}`;
const ISSUED_DEVICE_ID = `dev_${"D".repeat(24)}`;
const ISSUED_REFRESH_TOKEN = "R".repeat(43);
const BUILD_ID = "a".repeat(64);
const RECORD = {
  gatewayPort: 5000,
  pid: 99_999_999,
  serverId: SERVER_ID,
  serverBootId: SERVER_BOOT_ID,
  startedAt: 1000,
  version: "1.2.3",
  buildId: BUILD_ID,
};
const LEASE = {
  ownerBootId: RECORD.serverBootId,
  gatewayPort: RECORD.gatewayPort,
  pid: RECORD.pid,
  acquiredAt: RECORD.startedAt,
  heartbeatAt: 1_500,
  expiresAt: 2_000_000_000_000,
};

function readyInvite() {
  const pairing = {
    room: "root-room",
    fp: "AA".repeat(32),
    sig: "wss://signal.example/",
    code: "D".repeat(32),
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

function makeCentralData(initial: typeof LEASE | null = LEASE) {
  let lease: typeof LEASE | null = initial;
  return {
    getHubProcessLease: vi.fn(() => lease),
    setLease: (next: typeof LEASE | null) => {
      lease = next;
    },
  };
}

function manager(
  centralData: ReturnType<typeof makeCentralData>,
  options: {
    ephemeral?: boolean;
    ephemeralLifecycle?: "replace" | "resume";
    workspaceName?: string;
  } = {}
) {
  const ephemeral = options.ephemeral ?? false;
  return new HubProcessManager({
    workspaceName: options.workspaceName ?? "alpha",
    ephemeral,
    ephemeralLifecycle: ephemeral ? (options.ephemeralLifecycle ?? "replace") : null,
    appRoot: "/tmp/app",
    appVersion: "1.2.3",
    buildId: BUILD_ID,
    centralData: centralData as never,
    onCrash: vi.fn(),
  });
}

interface TestRpcRequest {
  from: string;
  message: {
    requestId: string;
    method: string;
    args: unknown[];
  };
}

function rpcCall(init: RequestInit | undefined): {
  method: string;
  args: unknown[];
  body: TestRpcRequest;
} {
  const body = JSON.parse(String(init?.body)) as TestRpcRequest;
  return {
    method: body.message.method,
    args: body.message.args,
    body,
  };
}

function rpcResult(request: TestRpcRequest, result: unknown): Response {
  const responder = { callerId: "main", callerKind: "server" };
  return Response.json({
    from: "main",
    target: request.from,
    delivery: { caller: responder },
    provenance: [responder],
    message: {
      type: "response",
      requestId: request.message.requestId,
      result,
    },
  });
}

function workspaceRoute(workspace: string, workspaceId: string) {
  return {
    workspace,
    workspaceId,
    running: true as const,
    serverUrl: `http://127.0.0.1:5000/_r/ws/${workspace}`,
    workspaceReach: {
      room: `workspace-${workspace}`,
      fp: "AA".repeat(32),
      sig: "wss://signal.example/",
      v: 2 as const,
      ice: "all" as const,
    },
    serverId: CHILD_SERVER_ID,
    serverBootId: CHILD_SERVER_BOOT_ID,
  };
}

beforeEach(() => {
  spawnMock.mockReset();
  credentialStore.loadDeviceCredentialByServerId.mockReset();
  credentialStore.saveDeviceCredential.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("HubProcessManager", () => {
  it("exposes the detached hub's canonical captured-output path", () => {
    expect(getLocalHubLogPath()).toBe("/tmp/vibestudio-hub-manager-test/logs/hub.log");
  });

  it("accepts only the canonical secret-free ready contract", () => {
    const canonical = {
      mode: "hub",
      gatewayUrl: "http://127.0.0.1:5000",
      rootInvite: readyInvite(),
      serverId: SERVER_ID,
      serverBootId: SERVER_BOOT_ID,
      gatewayPort: 5000,
      pid: 42,
      version: "1.2.3",
      buildId: BUILD_ID,
      workspaces: [],
    };
    expect(parseHubReadyFile(canonical)).toEqual(canonical);
    expect(() => parseHubReadyFile({ ...canonical, adminToken: "secret" })).toThrow(
      /canonical contract/
    );
    expect(() => parseHubReadyFile({ ...canonical, connectUrl: canonical.gatewayUrl })).toThrow(
      /canonical contract/
    );
    expect(() => parseHubReadyFile({ ...canonical, rootInvite: {} })).toThrow(/canonical contract/);
    expect(() =>
      parseHubReadyFile({
        ...canonical,
        rootInvite: { ...canonical.rootInvite, ice: undefined },
      })
    ).toThrow(/canonical contract/);
    expect(() =>
      parseHubReadyFile({
        ...canonical,
        rootInvite: { ...canonical.rootInvite, url: "https://legacy.example" },
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
          buildId: RECORD.buildId,
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
      const request = rpcCall(init);
      if (request.method === "hubControl.listWorkspaces") {
        expect(request.args).toEqual([]);
        return rpcResult(request.body, [
          {
            workspaceId: "ws_alpha",
            name: "alpha",
            lastOpened: 1,
            running: true,
          },
        ]);
      }
      expect(request).toMatchObject({
        method: "hubControl.routeWorkspace",
        args: [{ workspaceId: "ws_alpha" }],
      });
      return rpcResult(request.body, workspaceRoute("alpha", "ws_alpha"));
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

  it("replaces a live hub built from a different server artifact", async () => {
    let incumbentAlive = true;
    vi.spyOn(process, "kill").mockImplementation(((pid, signal) => {
      if (pid === RECORD.pid) {
        if (signal === 0) {
          if (incumbentAlive) return true;
          throw Object.assign(new Error("not found"), { code: "ESRCH" });
        }
        if (signal === "SIGTERM") {
          incumbentAlive = false;
          return true;
        }
      }
      throw new Error(`Unexpected signal ${String(signal)} for PID ${pid}`);
    }) as typeof process.kill);
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
          buildId: "b".repeat(64),
        })
      )
    );
    const replacement = new EventEmitter() as EventEmitter & { pid: number; unref(): void };
    replacement.pid = 42;
    replacement.unref = () => undefined;
    spawnMock.mockImplementation(() => {
      setTimeout(() => replacement.emit("exit", 1), 0);
      return replacement;
    });

    await expect(manager(makeCentralData()).attachOrSpawn()).rejects.toThrow(
      "Local hub exited during startup"
    );

    expect(incumbentAlive).toBe(false);
    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it("resumes the same ephemeral lifecycle during an internal Electron relaunch", async () => {
    credentialStore.loadDeviceCredentialByServerId.mockReturnValue({
      serverId: RECORD.serverId,
      transport: "loopback",
      deviceId: "dev-1",
      refreshToken: "refresh-1",
      pairedAt: 1,
    });
    const rpcCalls: Array<{ method: string; args: unknown[] }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
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
            buildId: RECORD.buildId,
          });
        }
        if (url.endsWith("/_r/s/auth/refresh-shell")) {
          return Response.json({ shellToken: "shell-session" });
        }
        const request = rpcCall(init);
        rpcCalls.push({ method: request.method, args: request.args });
        if (request.method === "hubControl.ensureEphemeralWorkspace") {
          return rpcResult(request.body, {
            workspaceId: "ws_dev",
            name: "dev",
            lastOpened: 1,
            running: true,
            ephemeral: true,
          });
        }
        return rpcResult(request.body, workspaceRoute("dev", "ws_dev"));
      })
    );

    const target = await manager(makeCentralData(), {
      ephemeral: true,
      ephemeralLifecycle: "resume",
      workspaceName: "dev",
    }).attachOrSpawn();

    expect(rpcCalls).toEqual([
      { method: "hubControl.ensureEphemeralWorkspace", args: [] },
      { method: "hubControl.routeWorkspace", args: [{ workspaceId: "ws_dev" }] },
    ]);
    expect(target).toMatchObject({ attached: true, workspaceId: "ws_dev" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("replaces an existing ephemeral lifecycle for a new development session", async () => {
    credentialStore.loadDeviceCredentialByServerId.mockReturnValue({
      serverId: RECORD.serverId,
      transport: "loopback",
      deviceId: "dev-1",
      refreshToken: "refresh-1",
      pairedAt: 1,
    });
    const rpcCalls: Array<{ method: string; args: unknown[] }> = [];
    let healthChecks = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/healthz")) {
          healthChecks += 1;
          return Response.json({
            ok: true,
            mode: "hub",
            serverId: RECORD.serverId,
            serverBootId: SERVER_BOOT_ID,
            gatewayPort: RECORD.gatewayPort,
            pid: RECORD.pid,
            version: RECORD.version,
            buildId: RECORD.buildId,
          });
        }
        if (url.endsWith("/_r/s/auth/refresh-shell")) {
          return Response.json({ shellToken: "shell-session" });
        }
        const request = rpcCall(init);
        rpcCalls.push({ method: request.method, args: request.args });
        if (request.method === "hubControl.listWorkspaces") {
          return rpcResult(request.body, [
            {
              workspaceId: "ws_dev_previous",
              name: "dev",
              lastOpened: 1,
              running: true,
              ephemeral: true,
            },
          ]);
        }
        if (request.method === "hubControl.deleteWorkspace") {
          return rpcResult(request.body, {
            deleted: true,
            workspaceId: "ws_dev_previous",
          });
        }
        if (request.method === "hubControl.ensureEphemeralWorkspace") {
          return rpcResult(request.body, {
            workspaceId: "ws_dev_fresh",
            name: "dev",
            lastOpened: 2,
            running: false,
            ephemeral: true,
          });
        }
        return rpcResult(request.body, workspaceRoute("dev", "ws_dev_fresh"));
      })
    );

    const processManager = manager(makeCentralData(), {
      ephemeral: true,
      ephemeralLifecycle: "replace",
      workspaceName: "dev",
    });
    const target = await processManager.attachOrSpawn();

    expect(rpcCalls).toEqual([
      { method: "hubControl.listWorkspaces", args: [] },
      { method: "hubControl.deleteWorkspace", args: [{ workspace: "dev" }] },
      { method: "hubControl.ensureEphemeralWorkspace", args: [] },
      { method: "hubControl.routeWorkspace", args: [{ workspaceId: "ws_dev_fresh" }] },
    ]);
    expect(target).toMatchObject({
      attached: true,
      workspaceId: "ws_dev_fresh",
      hubServerBootId: SERVER_BOOT_ID,
    });
    expect(spawnMock).not.toHaveBeenCalled();

    // The workspace client's initial "connecting" status probes supervision.
    // A healthy hub must not be mistaken for its routed child, and the consumed
    // replacement intent must never reset the new lifecycle a second time.
    processManager.handleDisconnect();
    await vi.waitFor(() => expect(healthChecks).toBe(2));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(rpcCalls).toEqual([
      { method: "hubControl.listWorkspaces", args: [] },
      { method: "hubControl.deleteWorkspace", args: [{ workspace: "dev" }] },
      { method: "hubControl.ensureEphemeralWorkspace", args: [] },
      { method: "hubControl.routeWorkspace", args: [{ workspaceId: "ws_dev_fresh" }] },
    ]);
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
          buildId: RECORD.buildId,
        })
      )
    );

    await expect(manager(makeCentralData()).attachOrSpawn()).rejects.toThrow(
      "desktop is not paired"
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects health metadata that does not match the fenced lease without signaling it", async () => {
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
          buildId: RECORD.buildId,
        })
      )
    );
    const killMock = vi.spyOn(process, "kill");

    await expect(manager(makeCentralData()).attachOrSpawn()).rejects.toThrow(
      /does not match fenced lease/
    );
    expect(killMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("persists the credential atomically issued by the hub without proposing client secrets", async () => {
    credentialStore.loadDeviceCredentialByServerId.mockReturnValue(null);
    const posted: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        posted.push(body);
        return Response.json({
          serverId: SERVER_ID,
          deviceId: ISSUED_DEVICE_ID,
          refreshToken: ISSUED_REFRESH_TOKEN,
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

    await expect(ensure(freshTarget)).resolves.toMatchObject({
      serverId: SERVER_ID,
      transport: "loopback",
      deviceId: ISSUED_DEVICE_ID,
      refreshToken: ISSUED_REFRESH_TOKEN,
    });
    expect(posted).toEqual([
      {
        code: "D".repeat(32),
        label: expect.stringMatching(/ desktop$/),
        platform: "desktop",
      },
    ]);
    expect(credentialStore.saveDeviceCredential).toHaveBeenCalledWith({
      serverId: SERVER_ID,
      transport: "loopback",
      deviceId: ISSUED_DEVICE_ID,
      refreshToken: ISSUED_REFRESH_TOKEN,
      label: expect.stringMatching(/ desktop$/),
      pairedAt: expect.any(Number),
    });
  });

  it("replaces a dead leased hub with a clean hub spawn", async () => {
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

  it("hands the canonical ephemeral lifecycle to the spawned hub", async () => {
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

    await expect(
      manager(makeCentralData(), { ephemeral: true, workspaceName: "dev" }).attachOrSpawn()
    ).rejects.toThrow("Local hub exited during startup");
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      "--max-old-space-size=4096",
      "/tmp/server-entry.js",
      "--ready-file",
      "/tmp/vibestudio-hub-manager-test/server-auth/hub-ready.json",
      "--bootstrap-workspace",
      "dev",
      "--ephemeral",
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
  });
});
