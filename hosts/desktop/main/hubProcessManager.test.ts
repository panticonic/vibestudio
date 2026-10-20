import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createConnectDeepLink, createConnectPairUrl } from "@vibestudio/shared/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceCredentialEntry } from "./services/deviceCredentialStore.js";
import { OwnedScope, type OwnedProcess } from "@vibestudio/shared/ownership";

vi.mock("./paths.js", () => ({
  getServerProcessEntryPath: () => "/tmp/server-entry.js",
  getEsbuildBinaryPath: () => null,
}));

// A fixed absolute path would be shared by every concurrent run and outlive
// all of them. The run-owned temporary root is swept when the run ends.
const CENTRAL_DATA_PATH = path.join(os.tmpdir(), "vibestudio-hub-manager-test");

vi.mock("@vibestudio/env-paths", () => ({
  getCentralDataPath: () => CENTRAL_DATA_PATH,
}));

const credentialStore = {
  loadDeviceCredentialByServerId: vi.fn(),
  saveDeviceCredential: vi.fn(),
};

// The ownership library is the seam: a hub is a registered, gracefully
// retired group. The real library is exercised in packages/shared; here its
// owner-facing contract is faked so spawn, registration and retirement can be
// ordered and observed.
const spawnMock = vi.fn();
const closeOwnershipMock = vi.fn(async () => undefined);
const ownership = {
  spawn: (...args: unknown[]) => spawnMock(...args),
  scope: new OwnedScope(),
  close: () => closeOwnershipMock(),
};

type FakeChild = EventEmitter & { pid: number; unref(): void };
const hubs = new Map<number, OwnedProcess>();

/** What `ownership.spawn` returns for a fake hub process. */
function ownedHub(child: FakeChild, registered: Promise<void> = Promise.resolve()): OwnedProcess {
  const owned = {
    child: child as never,
    identity: {
      version: 1 as const,
      platform: "linux" as const,
      pid: child.pid,
      processGroupId: child.pid,
      startCoordinate: "birth",
    },
    registered,
    retire: vi.fn(async () => undefined),
    join: vi.fn(async () => undefined),
  } satisfies OwnedProcess;
  hubs.set(child.pid, owned);
  return owned;
}

vi.mock("@vibestudio/shared/ownedProcessIdentity", () => ({
  captureOwnedProcessIdentity: (pid: number) => ({
    version: 1,
    platform: "linux",
    pid,
    processGroupId: pid,
    startCoordinate: "birth",
  }),
}));

const retireGroupMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("@vibestudio/shared/ownershipLedger", () => ({
  retireGroup: (...args: unknown[]) => retireGroupMock(...args),
}));

import { getLocalHubLogPath, HubProcessManager, parseHubReadyFile } from "./hubProcessManager.js";

const SERVER_ID = `srv_${"S".repeat(24)}`;
const SERVER_BOOT_ID = `boot_${"B".repeat(24)}`;
const CHILD_SERVER_ID = `srv_${"C".repeat(24)}`;
const CHILD_SERVER_BOOT_ID = `boot_${"C".repeat(24)}`;
const ISSUED_DEVICE_ID = `dev_${"D".repeat(24)}`;
const ISSUED_REFRESH_TOKEN = "R".repeat(43);
const PRIVATE_WORKSPACES = {
  personal: {
    workspaceId: "ws_personal",
    name: "personal",
    privateRole: "personal",
    lastOpened: 1,
    pendingApprovalCount: 0,
    running: false,
  },
  system: {
    workspaceId: "ws_system",
    name: "system",
    privateRole: "system",
    lastOpened: 1,
    pendingApprovalCount: 0,
    running: false,
  },
};
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
};

function readyInvite() {
  const pairing = {
    endpointId: "aa".repeat(32),
    relays: ["https://relay.example/"],
    code: "D".repeat(21) + "A",
    v: 5 as const,
  };
  return {
    code: pairing.code,
    reach: {
      status: "ready" as const,
      endpointId: pairing.endpointId,
      relays: pairing.relays,
      v: pairing.v,
      deepLink: createConnectDeepLink(pairing),
      pairUrl: createConnectPairUrl(pairing),
    },
    expiresInMs: 60_000,
    expiresAt: 2_000_000_000_000,
    serverId: SERVER_ID,
    serverBootId: SERVER_BOOT_ID,
  };
}

function makeCentralData(initial: typeof LEASE | null = LEASE) {
  let lease: typeof LEASE | null = initial;
  return {
    getHubProcessOwner: vi.fn(() => lease),
    isHubProcessOwned: vi.fn(() => lease !== null),
    releaseHubProcessOwnership: vi.fn((ownerBootId: string) => {
      if (lease?.ownerBootId !== ownerBootId) return false;
      lease = null;
      return true;
    }),
    setLease: (next: typeof LEASE | null) => {
      lease = next;
    },
  };
}

function manager(
  centralData: ReturnType<typeof makeCentralData>,
  options: {
    workspaceName?: string | null;
    onInitialWorkspaceResolved?: (workspaceId: string, prepare: () => Promise<void>) => void;
  } = {}
) {
  return new HubProcessManager({
    ownership: ownership as never,
    workspaceName: options.workspaceName === undefined ? "alpha" : options.workspaceName,
    appRoot: "/tmp/app",
    appVersion: "1.2.3",
    buildId: BUILD_ID,
    centralData: centralData as never,
    credentials: {
      load: async (serverId) => credentialStore.loadDeviceCredentialByServerId(serverId),
      save: async (credential) => credentialStore.saveDeviceCredential(credential),
    },
    onRecoveryFailure: vi.fn(),
    onInitialWorkspaceResolved: options.onInitialWorkspaceResolved,
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
      endpointId: "bb".repeat(32),
      relays: ["https://relay.example/"],
      v: 5 as const,
    },
    serverId: CHILD_SERVER_ID,
    serverBootId: CHILD_SERVER_BOOT_ID,
  };
}

beforeEach(() => {
  spawnMock.mockReset();
  closeOwnershipMock.mockClear();
  retireGroupMock.mockClear();
  hubs.clear();
  credentialStore.loadDeviceCredentialByServerId.mockReset();
  credentialStore.saveDeviceCredential.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("HubProcessManager", () => {
  it("exposes the detached hub's canonical captured-output path", () => {
    expect(getLocalHubLogPath()).toBe(path.join(CENTRAL_DATA_PATH, "logs", "hub.log"));
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
    const { reach: _reach, ...credential } = canonical.rootInvite;
    expect(
      parseHubReadyFile({
        ...canonical,
        rootInvite: { ...credential, reach: { status: "preparing" } },
      })
    ).toMatchObject({ rootInvite: { code: credential.code, reach: { status: "preparing" } } });
    expect(() =>
      parseHubReadyFile({ ...canonical, rootInvite: { ...credential, reach: { status: "ready" } } })
    ).toThrow(/canonical contract/);
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
        rootInvite: { ...canonical.rootInvite, relays: undefined },
      })
    ).toThrow(/canonical contract/);
    expect(() =>
      parseHubReadyFile({
        ...canonical,
        rootInvite: { ...canonical.rootInvite, url: "https://legacy.example" },
      })
    ).toThrow(/canonical contract/);
  });

  it.each(["alpha", null])(
    "loads designated System and focuses the requested project or Personal (%s)",
    async (workspaceName) => {
      const lifecycle: string[] = [];
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
        if (request.method === "hubControl.ensureUserWorkspaces")
          return rpcResult(request.body, PRIVATE_WORKSPACES);
        if (request.method === "hubControl.listWorkspaces") {
          expect(request.args).toEqual([]);
          return rpcResult(request.body, [
            {
              workspaceId: "ws_alpha",
              name: "alpha",
              lastOpened: 1,
              pendingApprovalCount: 0,
              running: true,
            },
          ]);
        }
        expect(request).toMatchObject({
          method: "hubControl.routeWorkspace",
          args: [{ workspaceId: "ws_system" }],
        });
        lifecycle.push("route-workspace");
        return rpcResult(request.body, workspaceRoute("system", "ws_system"));
      });
      vi.stubGlobal("fetch", fetchMock);
      const centralData = makeCentralData();

      const target = await manager(centralData, {
        workspaceName,
        onInitialWorkspaceResolved: (id) => lifecycle.push(`focus:${id}`),
      }).attachOrSpawn({
        onHubReady: () => lifecycle.push("hub-ready"),
      });

      expect(target).toMatchObject({
        attached: true,
        workspaceId: "ws_system",
        workspaceName: "system",
        initialFocusedWorkspaceId: workspaceName ? "ws_alpha" : "ws_personal",
        authToken: "refresh:dev-1:refresh-1",
        wsUrl: "ws://127.0.0.1:5000/_r/ws/system/rpc",
      });
      expect(spawnMock).not.toHaveBeenCalled();
      expect(lifecycle).toEqual([
        "hub-ready",
        `focus:${workspaceName ? "ws_alpha" : "ws_personal"}`,
        "route-workspace",
      ]);
    }
  );

  it("preserves a live hub built from a different server artifact", async () => {
    const killMock = vi.spyOn(process, "kill");
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
    await expect(manager(makeCentralData()).attachOrSpawn()).rejects.toThrow("different build");
    expect(killMock).not.toHaveBeenCalled();
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
      /does not match owner/
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
      rootInviteCode: "D".repeat(21) + "A",
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
        code: "D".repeat(21) + "A",
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
      return ownedHub(child);
    });
    const centralData = makeCentralData();
    centralData.isHubProcessOwned.mockReturnValue(false);

    await expect(manager(centralData).attachOrSpawn()).rejects.toThrow(
      "Local hub exited during startup"
    );
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      "--max-old-space-size=4096",
      "/tmp/server-entry.js",
      "--ready-file",
      path.join(CENTRAL_DATA_PATH, "server-auth", "hub-ready.json"),
      "--bootstrap-workspace",
      "alpha",
    ]);
    // Graceful (the hub holds SQLite state) and no IPC lease: the reaper that
    // registered the group is what revokes it.
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({
      kill: "graceful",
      stdio: ["ignore", expect.any(Number), expect.any(Number)],
    });
    expect(spawnMock.mock.calls[0]?.[2]).not.toHaveProperty("detached");
  });

  it("keeps the hub referenced until the reaper has durably recorded its group", async () => {
    credentialStore.loadDeviceCredentialByServerId.mockReturnValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("refused")))
    );
    let recorded!: () => void;
    const registered = new Promise<void>((resolve) => {
      recorded = resolve;
    });
    let unrefCount = 0;
    const child = new EventEmitter() as FakeChild;
    child.pid = 42;
    child.unref = () => {
      unrefCount += 1;
    };
    spawnMock.mockReturnValue(ownedHub(child, registered));

    const connecting = manager(makeCentralData(null)).attachOrSpawn();
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    await new Promise((resolve) => setImmediate(resolve));
    expect(unrefCount).toBe(0);

    recorded();
    await vi.waitFor(() => expect(unrefCount).toBe(1));
    child.emit("exit", 1);
    await expect(connecting).rejects.toThrow("Local hub exited during startup");
    // A hub that exits on its own still has its group joined.
    expect(hubs.get(42)?.join).toHaveBeenCalledOnce();
  });

  it("cleans up the spawned hub when the reaper refuses to record its group", async () => {
    credentialStore.loadDeviceCredentialByServerId.mockReturnValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("refused")))
    );
    let unrefCount = 0;
    const child = new EventEmitter() as FakeChild;
    child.pid = 99_999_996;
    child.unref = () => {
      unrefCount += 1;
    };
    const refusal = Object.assign(new Error("reaper refused"), { code: "EOWNERSHIP" });
    const registered = Promise.reject(refusal);
    registered.catch(() => undefined);
    spawnMock.mockReturnValue(ownedHub(child, registered));

    await expect(manager(makeCentralData(null)).attachOrSpawn()).rejects.toThrow("reaper refused");
    expect(unrefCount).toBe(0);
    expect(hubs.get(child.pid)?.retire).toHaveBeenCalledOnce();
  });

  it("stops a newly spawned hub when workspace routing fails", async () => {
    const readyFile = path.join(CENTRAL_DATA_PATH, "server-auth", "hub-ready.json");
    fs.rmSync(readyFile, { force: true });
    credentialStore.loadDeviceCredentialByServerId.mockReturnValue({
      serverId: SERVER_ID,
      transport: "loopback",
      deviceId: "dev-1",
      refreshToken: "refresh-1",
      pairedAt: 1,
    });
    const child = new EventEmitter() as FakeChild;
    child.pid = 99_999_998;
    child.unref = () => undefined;
    const centralData = makeCentralData(null);
    spawnMock.mockImplementation(() => {
      fs.writeFileSync(
        readyFile,
        JSON.stringify({
          mode: "hub",
          gatewayUrl: "http://127.0.0.1:5000",
          rootInvite: readyInvite(),
          serverId: SERVER_ID,
          serverBootId: SERVER_BOOT_ID,
          gatewayPort: 5000,
          pid: child.pid,
          version: "1.2.3",
          buildId: BUILD_ID,
          workspaces: [],
        })
      );
      const future = new Date(Date.now() + 1_000);
      fs.utimesSync(readyFile, future, future);
      centralData.setLease({ ...LEASE, pid: child.pid });
      return ownedHub(child);
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "workspace runtime unavailable" }, { status: 503 }))
    );

    await expect(manager(centralData).attachOrSpawn()).rejects.toThrow(
      "workspace runtime unavailable"
    );

    // The library retires it: SIGTERM, the hub's exit, then its group. No
    // deadline: the leader's exit is the event.
    expect(hubs.get(child.pid)?.retire).toHaveBeenCalledOnce();
    expect(centralData.releaseHubProcessOwnership).not.toHaveBeenCalled();
    expect(centralData.getHubProcessOwner()).toEqual({ ...LEASE, pid: child.pid });
  });

  it("leaves a pre-existing hub running when workspace routing fails", async () => {
    credentialStore.loadDeviceCredentialByServerId.mockReturnValue({
      serverId: SERVER_ID,
      transport: "loopback",
      deviceId: "dev-1",
      refreshToken: "refresh-1",
      pairedAt: 1,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        if (String(input).endsWith("/healthz")) {
          return Response.json({
            ok: true,
            mode: "hub",
            serverId: RECORD.serverId,
            serverBootId: RECORD.serverBootId,
            gatewayPort: RECORD.gatewayPort,
            pid: RECORD.pid,
            version: RECORD.version,
            buildId: RECORD.buildId,
          });
        }
        return Response.json({ error: "workspace runtime unavailable" }, { status: 503 });
      })
    );

    const centralData = makeCentralData();
    await expect(manager(centralData).attachOrSpawn()).rejects.toThrow(
      "workspace runtime unavailable"
    );

    expect(spawnMock).not.toHaveBeenCalled();
    expect(centralData.releaseHubProcessOwnership).not.toHaveBeenCalled();
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

    await expect(manager(makeCentralData()).attachOrSpawn()).rejects.toThrow(/hung/);

    expect(killMock).not.toHaveBeenCalled();
    expect(killMock).not.toHaveBeenCalledWith(RECORD.pid, "SIGTERM");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("terminates a spawned hub and deletes its ready file when the ready contract is invalid", async () => {
    const readyFile = path.join(CENTRAL_DATA_PATH, "server-auth", "hub-ready.json");
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
    const child = new EventEmitter() as FakeChild;
    child.pid = 42;
    child.unref = () => undefined;
    spawnMock.mockImplementation(() => {
      fs.writeFileSync(readyFile, JSON.stringify({ mode: "legacy" }));
      const future = new Date(Date.now() + 1_000);
      fs.utimesSync(readyFile, future, future);
      return ownedHub(child);
    });
    const centralData = makeCentralData(null);

    const processManager = manager(centralData);
    const spawnDetached = (
      processManager as unknown as {
        spawnDetached(preferredGatewayPort?: number): Promise<unknown>;
      }
    ).spawnDetached.bind(processManager);
    await expect(spawnDetached(RECORD.gatewayPort)).rejects.toThrow(/canonical contract/);

    expect(killMock).not.toHaveBeenCalled();
    expect(hubs.get(42)?.retire).toHaveBeenCalledOnce();
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({
      env: { VIBESTUDIO_GATEWAY_PORT: String(RECORD.gatewayPort) },
    });
    expect(fs.existsSync(readyFile)).toBe(false);
  });
});

describe("HubProcessManager.stopTree", () => {
  type Internals = {
    verifiedHubs: Map<number, { identity: OwnedProcess["identity"]; owned: OwnedProcess | null }>;
    currentHubPid: number | null;
  };
  const identityOf = (pid: number) => ({
    version: 1 as const,
    platform: "linux" as const,
    pid,
    processGroupId: pid,
    startCoordinate: "birth",
  });
  const withSpawnedHub = (pid: number) => {
    const child = new EventEmitter() as FakeChild;
    child.pid = pid;
    child.unref = () => undefined;
    const owned = ownedHub(child);
    const processManager = manager(makeCentralData());
    (processManager as unknown as Internals).verifiedHubs.set(pid, {
      identity: owned.identity,
      owned,
    });
    return { processManager, owned };
  };

  it("retires the spawned hub through the library, then joins the reaper", async () => {
    const order: string[] = [];
    const { processManager, owned } = withSpawnedHub(4_001);
    (owned.retire as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("retire");
    });
    closeOwnershipMock.mockImplementation(async () => {
      order.push("close");
    });

    await processManager.stopTree();

    expect(order).toEqual(["retire", "close"]);
    expect(retireGroupMock).not.toHaveBeenCalled();
  });

  it("propagates the original retirement failure and still joins the reaper", async () => {
    const failure = Object.assign(new Error("hub group survived"), { code: "EOWNERSHIP" });
    const { processManager, owned } = withSpawnedHub(4_002);
    (owned.retire as ReturnType<typeof vi.fn>).mockRejectedValue(failure);

    await expect(processManager.stopTree()).rejects.toBe(failure);
    expect(closeOwnershipMock).toHaveBeenCalledOnce();
  });

  it("retires a hub it only attached to by its exact identity", async () => {
    const processManager = manager(makeCentralData());
    const identity = identityOf(4_003);
    (processManager as unknown as Internals).verifiedHubs.set(4_003, { identity, owned: null });

    await processManager.stopTree();

    expect(retireGroupMock).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 4_003, identity, kill: "graceful" })
    );
  });
});
