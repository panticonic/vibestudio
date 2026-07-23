import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getWorkspaceDir } from "@vibestudio/env-paths";
import { TokenManager } from "@vibestudio/shared/tokenManager";
import { CentralDataManager } from "@vibestudio/shared/centralData";
import { IdentityDb } from "@vibestudio/identity/identityDb";
import { UserStore } from "@vibestudio/identity/userStore";
import { MembershipStore } from "@vibestudio/identity/membership";
import { createConnectDeepLink, createConnectPairUrl } from "@vibestudio/shared/connect";
import { DeviceAuthStore } from "./hostCore/deviceAuthStore.js";
import {
  buildHubReadyPayload,
  buildWorkspaceChildArgs,
  buildWorkspaceChildEnv,
  handleWorkspaceChildExit,
  HubCompletePairingBodySchema,
  HubDeviceCredentialBodySchema,
  openHubDataStores,
  prepareEphemeralWorkspaceDisk,
  reapWorkspaceChildProcessGroup,
  removeOwnedEphemeralWorkspace,
  revokeHubDevice,
  revokeHubUser,
  restoreRoutedWorkspaceRuntimes,
  selectBootstrapWorkspace,
  signalWorkspaceChildTree,
  terminateWorkspaceChild,
  type HubRuntimeState,
  type WorkspaceRuntime,
} from "./hubServer.js";

describe("hub bootstrap workspace selection", () => {
  it("uses the most recently opened registered workspace instead of assuming default", () => {
    expect(selectBootstrapWorkspace({}, [{ name: "active" }, { name: "older" }])).toEqual({
      name: "active",
      lifecycle: "existing",
    });
  });

  it("creates default only for an empty persistent catalog", () => {
    expect(selectBootstrapWorkspace({}, [])).toEqual({
      name: "default",
      lifecycle: "register",
    });
  });

  it("honors explicit persistent and canonical ephemeral bootstraps", () => {
    expect(selectBootstrapWorkspace({ bootstrapWorkspace: "dogfood" }, [])).toEqual({
      name: "dogfood",
      lifecycle: "register",
    });
    expect(selectBootstrapWorkspace({ ephemeral: true }, [])).toEqual({
      name: "dev",
      lifecycle: "ephemeral",
    });
    expect(() =>
      selectBootstrapWorkspace({ ephemeral: true, bootstrapWorkspace: "not-dev" }, [])
    ).toThrow("canonical dev workspace");
  });
});

describe("routed workspace restoration", () => {
  it("keeps the hub available when one independently restored workspace fails", async () => {
    const starts: string[] = [];
    const failures: Array<{ name: string; error: unknown }> = [];

    await expect(
      restoreRoutedWorkspaceRuntimes(
        [{ name: "stale" }, { name: "healthy" }],
        async (name) => {
          starts.push(name);
          if (name === "stale") throw new Error("system epoch mismatch");
        },
        (name, error) => failures.push({ name, error })
      )
    ).resolves.toBeUndefined();

    expect(starts).toEqual(["stale", "healthy"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.name).toBe("stale");
    expect(failures[0]?.error).toEqual(new Error("system epoch mismatch"));
  });
});

describe("workspace child process-tree ownership", () => {
  function fakeChild(overrides: Partial<ChildProcess> = {}): ChildProcess {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      pid: 4321,
      exitCode: null,
      signalCode: null,
      killed: false,
      kill: vi.fn(() => true),
      ...overrides,
    }) as unknown as ChildProcess;
  }

  it("signals only the owning server for graceful shutdown and waits for its exit", async () => {
    const child = fakeChild();
    child.kill = vi.fn(() => {
      queueMicrotask(() => child.emit("exit", 0, null));
      return true;
    });

    await terminateWorkspaceChild(child, { reap: async () => undefined });

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("signals the complete POSIX runtime group for explicit forced shutdown", () => {
    const child = fakeChild();
    const killProcess = vi.fn((): true => {
      queueMicrotask(() => child.emit("exit", 0, null));
      return true;
    });

    expect(signalWorkspaceChildTree(child, "SIGKILL", { platform: "linux", killProcess })).toBe(
      true
    );
    expect(killProcess).toHaveBeenCalledWith(-4321, "SIGKILL");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("falls back to the child handle when no POSIX process group exists", () => {
    const child = fakeChild();
    const missing = Object.assign(new Error("gone"), { code: "ESRCH" });
    const killProcess = vi.fn((): true => {
      throw missing;
    });

    expect(signalWorkspaceChildTree(child, "SIGKILL", { platform: "linux", killProcess })).toBe(
      true
    );
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("reaps the exact detached child process group and proves it disappeared", async () => {
    const child = fakeChild();
    const missing = Object.assign(new Error("gone"), { code: "ESRCH" });
    const killProcess = vi.fn((_pid: number, signal?: NodeJS.Signals | number): true => {
      if (signal === 0) throw missing;
      return true;
    });

    await reapWorkspaceChildProcessGroup(child, { platform: "linux", killProcess });

    expect(killProcess).toHaveBeenNthCalledWith(1, -4321, "SIGKILL");
    expect(killProcess).toHaveBeenNthCalledWith(2, -4321, 0);
  });

  it("does not signal a child whose OS exit is already recorded", async () => {
    const child = fakeChild({ exitCode: 0 });

    await terminateWorkspaceChild(child, { reap: async () => undefined });

    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe("workspace child exit reconciliation", () => {
  function runtimeState(child: ChildProcess): HubRuntimeState {
    const runtime: WorkspaceRuntime = {
      name: "dev-deadbeef",
      advertisedName: "dev",
      workspaceId: "ws_dev",
      port: 43545,
      publicUrl: "http://127.0.0.1:3030/w/dev",
      child,
      ready: {},
      runtimeToken: "child-token",
    };
    return {
      args: { ephemeral: true },
      centralData: {
        hasWorkspace: () => true,
        getEphemeralWorkspace: () => ({
          name: "dev",
          workspaceId: "ws_dev",
          ownerBootId: "boot-owner",
          lastOpened: 1,
          diskName: "dev-deadbeef",
        }),
      },
      serverBootId: "boot-owner",
      workspaceChildTokens: new Map([["child-token", "ws_dev"]]),
      workspacePresence: new Map([
        ["ws_dev", { serverBootId: "boot-child", revision: 1, users: new Map() }],
      ]),
      runtimes: new Map([["dev", runtime]]),
      shuttingDown: false,
    } as unknown as HubRuntimeState;
  }

  it("removes a dead ready runtime, reaps its group, and recovers the same checkout", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4321,
      exitCode: 1,
      signalCode: null,
      kill: vi.fn(),
    }) as unknown as ChildProcess;
    const state = runtimeState(child);
    const reaped = vi.fn(async () => undefined);
    const replacement = {
      ...(state.runtimes.get("dev") as WorkspaceRuntime),
      child: Object.assign(new EventEmitter(), { pid: 8765 }) as unknown as ChildProcess,
    };
    const restart = vi.fn(async (_state, input, reapedPromise) => {
      expect(state.runtimes.has("dev")).toBe(false);
      expect(input.childWorkspaceName).toBe("dev-deadbeef");
      await reapedPromise;
      state.runtimes.set("dev", replacement);
      return replacement;
    });

    await handleWorkspaceChildExit(
      state,
      {
        advertisedName: "dev",
        childWorkspaceName: "dev-deadbeef",
        workspaceId: "ws_dev",
        runtimeToken: "child-token",
        child,
        code: 1,
        signal: null,
      },
      { shouldRestart: () => true, reap: reaped, restart }
    );

    expect(reaped).toHaveBeenCalledWith(child);
    expect(restart).toHaveBeenCalledOnce();
    expect(state.runtimes.get("dev")).toBe(replacement);
    expect(state.workspaceChildTokens.has("child-token")).toBe(false);
    expect(state.workspacePresence.has("ws_dev")).toBe(false);
  });

  it("does not reap or restart a child already detached by an intentional stop", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4321,
      exitCode: 0,
      signalCode: null,
      kill: vi.fn(),
    }) as unknown as ChildProcess;
    const state = runtimeState(child);
    state.runtimes.delete("dev");
    const reap = vi.fn(async () => undefined);
    const restart = vi.fn(async () => {
      throw new Error("must not restart");
    });

    await handleWorkspaceChildExit(
      state,
      {
        advertisedName: "dev",
        childWorkspaceName: "dev-deadbeef",
        workspaceId: "ws_dev",
        runtimeToken: "child-token",
        child,
        code: 0,
        signal: null,
      },
      { shouldRestart: () => true, reap, restart }
    );

    expect(reap).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it("reaps a child that exits during startup without starting a competing replacement", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4321,
      exitCode: 1,
      signalCode: null,
      kill: vi.fn(),
    }) as unknown as ChildProcess;
    const state = runtimeState(child);
    state.runtimes.set("dev", {
      child,
      promise: new Promise<WorkspaceRuntime>(() => undefined),
    });
    const reap = vi.fn(async () => undefined);
    const restart = vi.fn(async () => {
      throw new Error("must not restart");
    });

    await handleWorkspaceChildExit(
      state,
      {
        advertisedName: "dev",
        childWorkspaceName: "dev-deadbeef",
        workspaceId: "ws_dev",
        runtimeToken: "child-token",
        child,
        code: 1,
        signal: null,
      },
      { shouldRestart: () => true, reap, restart }
    );

    expect(reap).toHaveBeenCalledWith(child);
    expect(restart).not.toHaveBeenCalled();
    expect(state.runtimes.has("dev")).toBe(false);
  });

  it("leaves no stale runtime when exact-checkout recovery fails", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4321,
      exitCode: 1,
      signalCode: null,
      kill: vi.fn(),
    }) as unknown as ChildProcess;
    const state = runtimeState(child);
    const restart = vi.fn(async () => {
      throw new Error("owned checkout is missing");
    });

    await handleWorkspaceChildExit(
      state,
      {
        advertisedName: "dev",
        childWorkspaceName: "dev-deadbeef",
        workspaceId: "ws_dev",
        runtimeToken: "child-token",
        child,
        code: 1,
        signal: null,
      },
      { shouldRestart: () => true, reap: async () => undefined, restart }
    );

    expect(restart).toHaveBeenCalledOnce();
    expect(state.runtimes.has("dev")).toBe(false);
  });
});

describe("ephemeral workspace evidence retention", () => {
  it("deletes the previous checkout only when its replacement starts", () => {
    const calls: string[] = [];
    let record: { workspaceId: string; diskName: string | null } | null = {
      workspaceId: "ws_dev",
      diskName: "dev-crashed",
    };
    const centralData = {
      rotateEphemeralWorkspaceDiskName: (
        _ownerBootId: string,
        workspaceId: string,
        diskName: string
      ) => {
        const previous = record?.diskName ?? null;
        record = { workspaceId, diskName };
        return previous
          ? {
              cleanupId: "cleanup_previous",
              diskName: previous,
              sourceOwnerBootId: "boot-owner",
              createdAt: 1,
            }
          : null;
      },
    } as unknown as CentralDataManager;

    prepareEphemeralWorkspaceDisk(
      centralData,
      "boot-owner",
      "ws_dev",
      "dev-replacement",
      (cleanup) => {
        calls.push(cleanup.diskName);
        return true;
      }
    );

    expect(calls).toEqual(["dev-crashed"]);
    expect(record).toEqual({ workspaceId: "ws_dev", diskName: "dev-replacement" });
  });

  it("does not remove a checkout when re-registering the same disk name", () => {
    const remove = vi.fn(() => true);
    const centralData = {
      rotateEphemeralWorkspaceDiskName: vi.fn(() => null),
    } as unknown as CentralDataManager;

    prepareEphemeralWorkspaceDisk(centralData, "boot-owner", "ws_dev", "dev-current", remove);

    expect(remove).not.toHaveBeenCalled();
  });

  it("gives a displaced shutdown no filesystem coordinate to delete", () => {
    const remove = vi.fn(() => true);
    const compareRemove = vi.fn(() => null);
    const centralData = {
      removeEphemeralWorkspace: compareRemove,
    } as unknown as CentralDataManager;

    removeOwnedEphemeralWorkspace(centralData, "boot-displaced", remove);

    expect(compareRemove).toHaveBeenCalledWith("boot-displaced", "boot-displaced");
    expect(remove).not.toHaveBeenCalled();
  });

  it("deletes only the durable cleanup ticket returned for the shutdown owner", () => {
    const cleanup = {
      cleanupId: "cleanup_owned",
      diskName: "dev-deadbeef",
      sourceOwnerBootId: "boot-owner",
      createdAt: 1,
    };
    const remove = vi.fn(() => true);
    const centralData = {
      removeEphemeralWorkspace: vi.fn(() => ({
        workspace: {
          workspaceId: "ws_dev",
          name: "dev",
          ownerBootId: "boot-owner",
          lastOpened: 1,
          diskName: "dev-deadbeef",
        },
        cleanup,
      })),
    } as unknown as CentralDataManager;

    removeOwnedEphemeralWorkspace(centralData, "boot-owner", remove);

    expect(remove).toHaveBeenCalledWith(cleanup, centralData, "boot-owner");
  });
});

describe("buildWorkspaceChildArgs", () => {
  it("uses only current server flags and binds the child gateway to loopback", () => {
    const args = buildWorkspaceChildArgs({
      entry: "/app/dist/server.mjs",
      workspaceName: "default",
      appRoot: "/app",
      readyFile: "/tmp/ready.json",
    });

    expect(args).not.toContain("--protocol");
    expect(args[args.indexOf("--host") + 1]).toBe("127.0.0.1");
    expect(args[args.indexOf("--bind-host") + 1]).toBe("127.0.0.1");
  });
});

describe("buildWorkspaceChildEnv (§5 per-child isolation)", () => {
  const base = {
    baseEnv: {
      PATH: "/usr/bin",
      VIBESTUDIO_WEBRTC_IDENTITY: "/hub/identity.pem",
      VIBESTUDIO_GATEWAY_PORT: "3030",
      VIBESTUDIO_WORKSPACE_DIR: "/somewhere",
      VIBESTUDIO_ADMIN_TOKEN: "hub-operator-token",
    } as NodeJS.ProcessEnv,
    appRoot: "/app",
    advertisedWorkspaceName: "base",
    hubUrl: "http://127.0.0.1:3030",
    identityDbPath: "/hub/state/identity.db",
    workspaceChildToken: "workspace-child-identity",
    workspaceId: "ws_base",
    ephemeral: false,
    autoApproveStartupUnits: false,
  };

  it("shares the hub identity DB read-only and gives every child its OWN DTLS identity", () => {
    const envA = buildWorkspaceChildEnv({
      ...base,
      childWorkspaceName: "alpha",
      workspaceId: "ws_alpha",
    });
    const envB = buildWorkspaceChildEnv({
      ...base,
      childWorkspaceName: "beta",
      workspaceId: "ws_beta",
    });

    // Every child reads the hub's ONE identity DB (WP0 §2) — same path for all.
    expect(envA["VIBESTUDIO_IDENTITY_DB_PATH"]).toBe("/hub/state/identity.db");
    expect(envB["VIBESTUDIO_IDENTITY_DB_PATH"]).toBe("/hub/state/identity.db");
    // Each child carries its OWN opaque workspaceId for the membership entry
    // gate (VIBESTUDIO_WORKSPACE_ID, WP2) — keyed on the id, never the name.
    expect(envA["VIBESTUDIO_WORKSPACE_ID"]).toBe("ws_alpha");
    expect(envB["VIBESTUDIO_WORKSPACE_ID"]).toBe("ws_beta");
    // DTLS identity belongs to the advertised logical workspace, so replacing
    // an ephemeral child checkout preserves the pinned workspace fingerprint.
    expect(envA["VIBESTUDIO_WEBRTC_IDENTITY"]).toBe(
      path.join(getWorkspaceDir("base"), "reach", "webrtc", "identity.pem")
    );
    expect(envA["VIBESTUDIO_WEBRTC_IDENTITY"]).toBe(envB["VIBESTUDIO_WEBRTC_IDENTITY"]);

    // It is still distinct from the hub's own identity.
    expect(envA["VIBESTUDIO_WEBRTC_IDENTITY"]).not.toBe(base.baseEnv["VIBESTUDIO_WEBRTC_IDENTITY"]);
    expect(envB["VIBESTUDIO_WEBRTC_IDENTITY"]).not.toBe(base.baseEnv["VIBESTUDIO_WEBRTC_IDENTITY"]);
    expect(envA["VIBESTUDIO_ADMIN_TOKEN"]).toMatch(/^[a-f0-9]{64}$/);
    expect(envA["VIBESTUDIO_ADMIN_TOKEN"]).not.toBe(base.baseEnv["VIBESTUDIO_ADMIN_TOKEN"]);
    expect(envA["VIBESTUDIO_ADMIN_TOKEN"]).not.toBe(envB["VIBESTUDIO_ADMIN_TOKEN"]);
  });

  it("keeps the strict hub-child control contract and clears inherited ports", () => {
    const env = buildWorkspaceChildEnv({ ...base, childWorkspaceName: "alpha", ephemeral: true });
    expect(env["VIBESTUDIO_PROCESS_ROLE"]).toBe("workspace-child");
    expect(env["VIBESTUDIO_HUB_URL"]).toBe("http://127.0.0.1:3030");
    expect(env["VIBESTUDIO_WORKSPACE_CHILD_TOKEN"]).toBe("workspace-child-identity");
    expect(env["VIBESTUDIO_WORKSPACE"]).toBe("alpha");
    expect(env["VIBESTUDIO_ADVERTISED_WORKSPACE"]).toBe("base");
    expect(env["VIBESTUDIO_WORKSPACE_ID"]).toBe("ws_base");
    expect(env["VIBESTUDIO_ROUTED_ROOM_STATE_PATH"]).toBe(
      path.join(getWorkspaceDir("base"), "reach", "webrtc", "routes.json")
    );
    expect(env["VIBESTUDIO_WORKSPACE_EPHEMERAL"]).toBe("1");
    expect(env["VIBESTUDIO_GATEWAY_PORT"]).toBeUndefined();
    expect(env["VIBESTUDIO_WORKSPACE_DIR"]).toBeUndefined();
    expect(env["PATH"]).toBe("/usr/bin");
  });

  it("propagates an explicitly enabled unattended startup policy to the child", () => {
    const env = buildWorkspaceChildEnv({
      ...base,
      baseEnv: {
        ...base.baseEnv,
        VIBESTUDIO_AUTO_APPROVE_STARTUP_UNITS: "1",
      },
      childWorkspaceName: "alpha",
      autoApproveStartupUnits: false,
    });

    expect(env["VIBESTUDIO_AUTO_APPROVE_STARTUP_UNITS"]).toBe("1");
  });

  it("does not inherit an unrecognized startup approval value", () => {
    const env = buildWorkspaceChildEnv({
      ...base,
      baseEnv: {
        ...base.baseEnv,
        VIBESTUDIO_AUTO_APPROVE_STARTUP_UNITS: "true",
      },
      childWorkspaceName: "alpha",
      autoApproveStartupUnits: false,
    });

    expect(env["VIBESTUDIO_AUTO_APPROVE_STARTUP_UNITS"]).toBeUndefined();
  });
});

function fakeRuntime(
  port: number,
  ready: Record<string, unknown>,
  opts: { advertisedName?: string; workspaceId?: string } = {}
): WorkspaceRuntime {
  const advertisedName = opts.advertisedName ?? "dev";
  return {
    name: advertisedName,
    advertisedName,
    // Opaque stable registry id (WP2) — membership rows key on this, not the name.
    workspaceId: opts.workspaceId ?? "ws_dev",
    port,
    publicUrl: `http://127.0.0.1:9/_workspace/${advertisedName}`,
    child: { exitCode: null } as ChildProcess,
    ready: {
      serverId: `srv_${"S".repeat(24)}`,
      serverBootId: `boot_${"B".repeat(24)}`,
      ...ready,
    },
    runtimeToken: "child-runtime",
  };
}

/**
 * A minimal in-memory stand-in for the hub's `CentralDataManager` registry —
 * just the surface the hub RPC paths touch. The real manager persists to disk
 * and prunes entries whose workspace dir is absent, which would empty the
 * seeded catalog in a hermetic test; this fake keeps the entries stable.
 */
function makeHubCentralData(
  seed: Array<{ name: string; workspaceId: string; lastOpened: number }> = []
): CentralDataManager {
  const entries = [...seed];
  let ephemeral: {
    name: string;
    workspaceId: string;
    lastOpened: number;
    ownerBootId: string;
  } | null = null;
  return {
    listWorkspaces: () => entries,
    getWorkspaceIdByName: (name: string) =>
      entries.find((e) => e.name === name)?.workspaceId ?? null,
    hasWorkspace: (name: string) => entries.some((e) => e.name === name),
    addWorkspace: (name: string) => {
      if (!entries.some((e) => e.name === name)) {
        entries.push({ name, workspaceId: `ws_${name}`, lastOpened: Date.now() });
      }
    },
    addEphemeralWorkspace: (name: string, ownerBootId: string) => {
      if (ephemeral) throw new Error("An ephemeral workspace lifecycle is already registered");
      if (entries.some((entry) => entry.name === name)) {
        throw new Error(`Cannot shadow persistent workspace "${name}" with ephemeral dev`);
      }
      ephemeral = {
        name,
        workspaceId: `ws_${name}`,
        lastOpened: Date.now(),
        ownerBootId,
      };
      entries.push({
        name: ephemeral.name,
        workspaceId: ephemeral.workspaceId,
        lastOpened: ephemeral.lastOpened,
      });
      return ephemeral;
    },
    getEphemeralWorkspace: () => ephemeral,
    removeEphemeralWorkspace: (_leaseOwnerBootId: string, expectedOwnerBootId: string) => {
      if (!ephemeral || ephemeral.ownerBootId !== expectedOwnerBootId) return null;
      const workspace = ephemeral;
      const index = entries.findIndex((entry) => entry.workspaceId === workspace.workspaceId);
      if (index >= 0) entries.splice(index, 1);
      ephemeral = null;
      return { workspace, cleanup: null };
    },
    touchWorkspace: () => {},
    setLastWorkspaceForUser: () => {},
  } as unknown as CentralDataManager;
}

const CHILD_REACH = {
  room: "child-room",
  fp: "AA".repeat(32),
  sig: "wss://signal.example/",
  v: 2 as const,
  ice: "all",
};

describe("hub public request schemas", () => {
  const credential = {
    deviceId: `dev_${"a".repeat(24)}`,
    refreshToken: "b".repeat(43),
  };

  it("accepts only the current pairing request contract", () => {
    expect(
      HubCompletePairingBodySchema.safeParse({
        code: "c".repeat(32),
        label: "Desktop",
        platform: "linux",
      }).success
    ).toBe(true);
    expect(
      HubCompletePairingBodySchema.safeParse({
        code: "c".repeat(32),
        ...credential,
      }).success
    ).toBe(false);
    expect(
      HubCompletePairingBodySchema.safeParse({
        code: "c".repeat(32),
        deviceId: credential.deviceId,
      }).success
    ).toBe(false);
    expect(
      HubCompletePairingBodySchema.safeParse({ code: "c".repeat(32), room: "legacy-room" }).success
    ).toBe(false);
    expect(
      HubCompletePairingBodySchema.safeParse({ code: "c".repeat(32), handle: "root_user" }).success
    ).toBe(false);
    expect(HubCompletePairingBodySchema.safeParse({ code: "short" }).success).toBe(false);
  });

  it("rejects unknown and malformed device-routing fields", () => {
    expect(HubDeviceCredentialBodySchema.safeParse(credential).success).toBe(true);
    expect(
      HubDeviceCredentialBodySchema.safeParse({ ...credential, token: "legacy" }).success
    ).toBe(false);
  });
});

describe("hub RPC pairing surfacing (§5)", () => {
  function makeState(runtime: WorkspaceRuntime): {
    state: HubRuntimeState;
    shellToken: string;
    rootUserId: string;
    rootDeviceId: string;
  } {
    const tokenManager = new TokenManager();
    tokenManager.setAdminToken("hub-admin");
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-hub-test-"));
    const identityDbPath = path.join(stateDir, "identity.db");
    // The hub owns ONE read-write identity DB (WP0 §2); the device store, user
    // store, and membership store all share it.
    const identityDb = new IdentityDb({ path: identityDbPath, readOnly: false });
    const catalog = new DatabaseSync(identityDbPath);
    catalog
      .prepare("INSERT INTO workspaces (workspace_id, name, last_opened) VALUES (?, ?, ?)")
      .run(runtime.workspaceId, runtime.advertisedName, 1000);
    catalog.close();
    const userStore = new UserStore(identityDb);
    const membershipStore = new MembershipStore(identityDb, userStore);
    const deviceAuthStore = new DeviceAuthStore({
      db: identityDb,
      serverIdPath: path.join(stateDir, "server-id.json"),
    });
    // Every hub RPC now acts AS a user (WP2 §4): seed root and a device it owns,
    // then mint the shell token whose callerId (`shell:<deviceId>`) resolves
    // back to root through the device→user FK.
    const root = userStore.createRoot({ handle: "root", displayName: "Root" });
    const rootDevice = deviceAuthStore.issueDevice({ userId: root.id, label: "root-cli" });
    const shellToken = tokenManager.ensureToken(`shell:${rootDevice.deviceId}`, "shell");
    const state: HubRuntimeState = {
      appRoot: "/app",
      args: {},
      // Seeded so invite-workspace inference can resolve the running workspace
      // by name without spawning (the runtime is already in `runtimes`).
      centralData: makeHubCentralData([
        { name: runtime.advertisedName, workspaceId: runtime.workspaceId, lastOpened: 1000 },
      ]),
      deviceAuthStore,
      identityDb,
      userStore,
      membershipStore,
      tokenManager,
      serverBootId: `boot_${"B".repeat(24)}`,
      adminToken: "hub-admin",
      tokenSource: "generated",
      version: "test",
      gatewayPort: 9,
      protocol: "http",
      externalHost: "127.0.0.1",
      bindHost: "127.0.0.1",
      connectUrl: "http://127.0.0.1:9",
      identityDbPath,
      workspaceChildTokens: new Map(),
      workspacePresence: new Map(),
      runtimes: new Map([[runtime.advertisedName, runtime]]),
      shuttingDown: false,
    };
    state.controlTransport = {
      ingress: {
        armRoom: vi.fn(async () => undefined),
        disarmRoom: vi.fn(async () => undefined),
      } as never,
      pairing: {
        fp: CHILD_REACH.fp,
        sig: CHILD_REACH.sig,
        v: CHILD_REACH.v,
        ice: "all" as const,
      },
      rpcServer: {} as never,
      grantStore: { close: vi.fn() } as never,
      inviteExpiryTimers: new Map(),
    };
    return { state, shellToken, rootUserId: root.id, rootDeviceId: rootDevice.deviceId };
  }

  it("writes one canonical secret-free hub ready contract", () => {
    const { state } = makeState(fakeRuntime(9, {}));
    const invite = (() => {
      const pairing = {
        room: "root-room",
        fp: "AA".repeat(32),
        sig: "wss://signal.example/",
        code: "R".repeat(32),
        v: 2 as const,
        ice: "all" as const,
      };
      return {
        ...pairing,
        deepLink: createConnectDeepLink(pairing),
        pairUrl: createConnectPairUrl(pairing),
        expiresInMs: 60_000,
        expiresAt: 2_000_000_000_000,
        serverId: state.deviceAuthStore.getServerId(),
        serverBootId: state.serverBootId,
      };
    })();

    const payload = buildHubReadyPayload(state, invite, 4242);

    expect(Object.keys(payload).sort()).toEqual(
      [
        "mode",
        "gatewayUrl",
        "rootInvite",
        "serverId",
        "serverBootId",
        "gatewayPort",
        "pid",
        "version",
        "workspaces",
      ].sort()
    );
    expect(payload).toMatchObject({
      mode: "hub",
      gatewayUrl: "http://127.0.0.1:9",
      rootInvite: invite,
      pid: 4242,
      version: "test",
    });
    expect(payload).not.toHaveProperty("adminToken");
    expect(payload).not.toHaveProperty("publicUrl");
    expect(payload.rootInvite).not.toHaveProperty("qr");
    expect(payload.rootInvite).not.toHaveProperty("serverUrl");
  });

  it("revokes a device immediately and disarms its exact control room after retirement", async () => {
    const runtime = fakeRuntime(9, {});
    const { state, rootUserId } = makeState(runtime);
    const invite = state.deviceAuthStore.createPairingInvite(30_000, {
      workspaceId: runtime.workspaceId,
      userId: rootUserId,
      intent: "pair-device",
    });
    const paired = state.deviceAuthStore.completePairing({ code: invite.code, label: "phone" });
    const pairedToken = state.tokenManager.ensureToken(`shell:${paired.deviceId}`, "shell");
    let release!: () => void;
    const retired = new Promise<void>((resolve) => {
      release = resolve;
    });
    const retireCaller = vi.fn(() => retired);
    state.controlTransport!.rpcServer = { retireCaller } as never;
    const result = await revokeHubDevice(
      state,
      { userId: rootUserId, handle: "root", role: "root" },
      paired.deviceId
    );

    expect(result).toMatchObject({ revoked: true });
    expect(state.deviceAuthStore.userFor(paired.deviceId)).toBeNull();
    expect(state.tokenManager.validateToken(pairedToken)).toBeNull();
    expect(retireCaller).toHaveBeenCalledWith(`shell:${paired.deviceId}`);
    expect(state.controlTransport!.ingress.disarmRoom).not.toHaveBeenCalled();

    release();
    await retired;
    await Promise.resolve();
    expect(state.controlTransport!.ingress.disarmRoom).toHaveBeenCalledWith(paired.controlRoom);
  });

  it("retires and disarms every exact device reach when a user is revoked", async () => {
    const runtime = fakeRuntime(9, {});
    const { state, rootUserId } = makeState(runtime);
    const member = state.userStore.inviteUser({
      handle: "alice",
      displayName: "Alice",
      role: "member",
      createdBy: rootUserId,
    });
    const paired = ["phone", "laptop"].map((label) => {
      const invite = state.deviceAuthStore.createPairingInvite(30_000, {
        workspaceId: runtime.workspaceId,
        userId: member.id,
        intent: "pair-device",
      });
      const credential = state.deviceAuthStore.completePairing({ code: invite.code, label });
      state.tokenManager.ensureToken(`shell:${credential.deviceId}`, "shell");
      return credential;
    });
    // No workspace cleanup task is needed for this transport-lifecycle test.
    state.centralData = makeHubCentralData([]);
    const releases = new Map<string, () => void>();
    const retireCaller = vi.fn(
      (callerId: string) =>
        new Promise<void>((resolve) => {
          releases.set(callerId, resolve);
        })
    );
    state.controlTransport!.rpcServer = { retireCaller } as never;
    const result = await revokeHubUser(
      state,
      { userId: rootUserId, handle: "root", role: "root" },
      { userId: member.id }
    );

    expect(result).toMatchObject({ revoked: true, userId: member.id });
    expect(state.userStore.getUser(member.id)?.revokedAt).toEqual(expect.any(Number));
    expect(retireCaller).toHaveBeenCalledTimes(2);
    expect(state.controlTransport!.ingress.disarmRoom).not.toHaveBeenCalled();

    for (const credential of paired) {
      releases.get(`shell:${credential.deviceId}`)!();
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(state.controlTransport!.ingress.disarmRoom).toHaveBeenCalledTimes(2);
    expect(state.controlTransport!.ingress.disarmRoom).toHaveBeenCalledWith(paired[0]!.controlRoom);
    expect(state.controlTransport!.ingress.disarmRoom).toHaveBeenCalledWith(paired[1]!.controlRoom);
  });
});

describe("CentralDataManager opaque workspaceId (WP2 §4)", () => {
  // The manager reads/writes the real central config dir; point it at a throwaway
  // XDG root so the tests never touch (or clobber) the operator's registry.
  let prevXdg: string | undefined;
  let cfgRoot: string;

  beforeEach(() => {
    prevXdg = process.env["XDG_CONFIG_HOME"];
    cfgRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-central-"));
    process.env["XDG_CONFIG_HOME"] = cfgRoot;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = prevXdg;
    fs.rmSync(cfgRoot, { recursive: true, force: true });
  });

  it("mints an opaque workspaceId once and keeps it stable across re-adds", () => {
    const central = new CentralDataManager();
    central.addWorkspace("alpha");
    const id = central.getWorkspaceIdByName("alpha");
    expect(id).toMatch(/^ws_/);
    // Re-adding a still-registered workspace preserves its minted id.
    central.addWorkspace("alpha");
    expect(central.getWorkspaceIdByName("alpha")).toBe(id);
    // Distinct workspaces get distinct ids.
    central.addWorkspace("beta");
    expect(central.getWorkspaceIdByName("beta")).not.toBe(id);
  });

  it("mints a FRESH id after delete + recreate (ids are never reused)", () => {
    const central = new CentralDataManager();
    central.addWorkspace("alpha");
    const first = central.getWorkspaceIdByName("alpha");
    // removeWorkspace returns the removed entry's opaque id (for the cascade).
    expect(central.removeWorkspace("alpha")).toBe(first);
    central.addWorkspace("alpha");
    expect(central.getWorkspaceIdByName("alpha")).not.toBe(first);
  });
});

describe("hub canonical database wiring", () => {
  it("keeps an explicit identity path shared with the workspace registry", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-hub-db-"));
    const databasePath = path.join(stateDir, "custom-identity.db");
    const { centralData, identityDb } = openHubDataStores(databasePath);
    try {
      centralData.addWorkspace("alpha");
      const workspaceId = centralData.getWorkspaceIdByName("alpha")!;
      const users = new UserStore(identityDb);
      const memberships = new MembershipStore(identityDb, users);
      const root = users.createRoot({ handle: "root", displayName: "Root" });
      const member = users.inviteUser({
        handle: "alice",
        displayName: "Alice",
        role: "member",
        createdBy: root.id,
      });

      expect(() => memberships.add(member.id, workspaceId, root.id)).not.toThrow();
      expect(memberships.has(member.id, workspaceId)).toBe(true);
    } finally {
      identityDb.close();
      centralData.close();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
