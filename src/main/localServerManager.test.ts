/**
 * LocalServerManager attach-or-spawn unit tests.
 *
 * These exercise the ATTACH decision tree without spawning a real server:
 * `/healthz` is stubbed via a global `fetch` mock, the device credential store
 * and `./paths.js` (both of which pull in Electron) are module-mocked, and the
 * attachment record lives in a fake CentralDataManager. The spawn fallthrough
 * is verified by asserting `child_process.spawn` is (or is not) called; the
 * spawned child immediately "exits" so the ready-file wait rejects.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// ── Electron-pulling deps mocked out ─────────────────────────────────────────
vi.mock("./paths.js", () => ({
  getServerProcessEntryPath: () => "/tmp/server-entry.js",
  getEsbuildBinaryPath: () => null,
}));

const credStore = {
  loadDeviceCredentialByWorkspaceId: vi.fn(),
  saveDeviceCredential: vi.fn(),
  clearDeviceCredentialByWorkspaceId: vi.fn(),
};
vi.mock("./services/deviceCredentialStore.js", () => ({
  loadDeviceCredentialByWorkspaceId: (...a: unknown[]) =>
    credStore.loadDeviceCredentialByWorkspaceId(...a),
  saveDeviceCredential: (...a: unknown[]) => credStore.saveDeviceCredential(...a),
  clearDeviceCredentialByWorkspaceId: (...a: unknown[]) =>
    credStore.clearDeviceCredentialByWorkspaceId(...a),
}));

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...a: unknown[]) => spawnMock(...a),
}));

import { LocalServerManager } from "./localServerManager.js";

const WORKSPACE_NAME = "test-ws";
const WORKSPACE_ID = "ws-id-1";
const APP_VERSION = "1.2.3";

interface ServerRecord {
  gatewayPort: number;
  pid: number;
  serverId: string;
  serverBootId: string;
  startedAt: number;
  version: string;
}

function makeCentralData(initial: ServerRecord | null) {
  let record = initial;
  return {
    getWorkspaceLocalServer: vi.fn(() => record),
    setWorkspaceLocalServer: vi.fn((_name: string, r: ServerRecord) => {
      record = r;
    }),
    clearWorkspaceLocalServer: vi.fn(() => {
      record = null;
    }),
  };
}

function makeManager(centralData: ReturnType<typeof makeCentralData>) {
  return new LocalServerManager({
    wsDir: "/tmp/ws",
    workspaceName: WORKSPACE_NAME,
    workspaceId: WORKSPACE_ID,
    appRoot: "/tmp/app",
    appVersion: APP_VERSION,
    centralData: centralData as never,
    onCrash: vi.fn(),
  });
}

function stubHealthz(payload: Record<string, unknown> | null, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (payload === null) throw new Error("connection refused");
      return {
        ok,
        json: async () => payload,
      } as unknown as Response;
    })
  );
}

/** A fake child whose "exit" fires (code 1) on next tick so ready-wait rejects. */
function makeExitingChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    unref: () => void;
  };
  child.pid = 4321;
  child.unref = () => {};
  spawnMock.mockReturnValue(child);
  setTimeout(() => child.emit("exit", 1), 0);
  return child;
}

const RECORD: ServerRecord = {
  gatewayPort: 5000,
  pid: 1111,
  serverId: "server-abc",
  serverBootId: "boot-1",
  startedAt: 1000,
  version: APP_VERSION,
};

beforeEach(() => {
  spawnMock.mockReset();
  credStore.loadDeviceCredentialByWorkspaceId.mockReset();
  credStore.saveDeviceCredential.mockReset();
  credStore.clearDeviceCredentialByWorkspaceId.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("LocalServerManager.attachOrSpawn — attach path", () => {
  it("attaches to a healthy matching server with a valid credential (no spawn)", async () => {
    stubHealthz({
      ok: true,
      serverId: "server-abc",
      serverBootId: "boot-live",
      workspaceId: WORKSPACE_ID,
      version: APP_VERSION,
      pid: 2222,
    });
    credStore.loadDeviceCredentialByWorkspaceId.mockReturnValue({
      deviceId: "dev-1",
      refreshToken: "tok-1",
      serverId: "server-abc",
      pairedAt: 1,
    });
    const centralData = makeCentralData(RECORD);
    const manager = makeManager(centralData);

    const target = await manager.attachOrSpawn();

    expect(target.attached).toBe(true);
    expect(target.authToken).toBe("refresh:dev-1:tok-1");
    expect(target.gatewayPort).toBe(5000);
    expect(target.serverId).toBe("server-abc");
    expect(target.serverBootId).toBe("boot-live");
    expect(spawnMock).not.toHaveBeenCalled();
    expect(centralData.clearWorkspaceLocalServer).not.toHaveBeenCalled();
  });
});

describe("LocalServerManager.attachOrSpawn — fallthrough to spawn", () => {
  async function expectSpawnFallthrough(centralData: ReturnType<typeof makeCentralData>) {
    const manager = makeManager(centralData);
    makeExitingChild();
    await expect(manager.attachOrSpawn()).rejects.toThrow("exited during startup");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  }

  it("clears the record and spawns when healthz is dead", async () => {
    stubHealthz(null);
    credStore.loadDeviceCredentialByWorkspaceId.mockReturnValue(null);
    const centralData = makeCentralData(RECORD);
    await expectSpawnFallthrough(centralData);
    expect(centralData.clearWorkspaceLocalServer).toHaveBeenCalled();
    expect(credStore.clearDeviceCredentialByWorkspaceId).toHaveBeenCalledWith(WORKSPACE_ID);
  });

  it("clears the record and spawns on serverId mismatch (imposter)", async () => {
    stubHealthz({
      ok: true,
      serverId: "someone-else",
      workspaceId: WORKSPACE_ID,
      version: APP_VERSION,
    });
    const centralData = makeCentralData(RECORD);
    await expectSpawnFallthrough(centralData);
    expect(credStore.clearDeviceCredentialByWorkspaceId).toHaveBeenCalledWith(WORKSPACE_ID);
  });

  it("clears the record and spawns on workspaceId mismatch", async () => {
    stubHealthz({
      ok: true,
      serverId: "server-abc",
      workspaceId: "other-ws",
      version: APP_VERSION,
    });
    const centralData = makeCentralData(RECORD);
    await expectSpawnFallthrough(centralData);
    expect(credStore.clearDeviceCredentialByWorkspaceId).toHaveBeenCalledWith(WORKSPACE_ID);
  });

  it("SIGTERMs the old server and spawns on version mismatch", async () => {
    stubHealthz({
      ok: true,
      serverId: "server-abc",
      workspaceId: WORKSPACE_ID,
      version: "0.0.9-old",
      pid: 1111,
    });
    // pidAlive → false: kill(pid, 0) throws so terminateByRecord skips the wait.
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    const centralData = makeCentralData(RECORD);
    await expectSpawnFallthrough(centralData);
    expect(killSpy).toHaveBeenCalledWith(RECORD.pid, 0);
    expect(centralData.clearWorkspaceLocalServer).toHaveBeenCalled();
  });

  it("stops and spawns when the server is healthy but has no usable credential", async () => {
    stubHealthz({
      ok: true,
      serverId: "server-abc",
      workspaceId: WORKSPACE_ID,
      version: APP_VERSION,
      pid: 1111,
    });
    credStore.loadDeviceCredentialByWorkspaceId.mockReturnValue(null);
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    const centralData = makeCentralData(RECORD);
    await expectSpawnFallthrough(centralData);
    expect(centralData.clearWorkspaceLocalServer).toHaveBeenCalled();
  });
});
