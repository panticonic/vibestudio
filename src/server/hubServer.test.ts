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
import { GovernanceLog } from "@vibestudio/shared/governance/governanceLog";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import { IdentityDb } from "@vibestudio/identity/identityDb";
import { UserStore } from "@vibestudio/identity/userStore";
import { MembershipStore } from "@vibestudio/identity/membership";
import { createConnectDeepLink, createConnectPairUrl } from "@vibestudio/shared/connect";
import { DeviceAuthStore } from "./hostCore/deviceAuthStore.js";
import {
  applyWorkspaceHostRuntimeEnv,
  buildHubReadyPayload,
  buildWorkspaceChildArgs,
  buildWorkspaceChildEnv,
  executeHubControl,
  applyHubWorkspacePresenceReport,
  snapshotInternalDOBundleForHub,
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
  isHubControlHttpPath,
  selectWorkspaceCreationRootTemplate,
  selectBootstrapWorkspace,
  selectDevelopmentWritebackWorkspaceId,
  signalWorkspaceChildTree,
  terminateWorkspaceChild,
  waitForWorkspaceReadyFile,
  type HubRuntimeState,
  type WorkspaceRuntime,
} from "./hubServer.js";
import { WORKSPACE_EPOCH_HANDOFF_EXIT_CODE } from "./historicalWorkspaceHost.js";

const removeWorkspaceTreeForTest = (target: string): void => {
  fs.rmSync(target, { recursive: true, force: true });
};

describe("hub control HTTP routing", () => {
  it("routes both RPC dispatch and pre-upgrade admission to the control server", () => {
    expect(isHubControlHttpPath("/rpc")).toBe(true);
    expect(isHubControlHttpPath("/rpc/ws-admission")).toBe(true);
    expect(isHubControlHttpPath("/rpc/other")).toBe(false);
  });
});

describe("hub internal runtime snapshot", () => {
  it("publishes immutable bundle bytes for every workspace child in the hub boot", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-hub-bundle-"));
    try {
      const snapshotPath = snapshotInternalDOBundleForHub(configDir, "exact-bundle-bytes");

      expect(path.isAbsolute(snapshotPath)).toBe(true);
      expect(fs.readFileSync(snapshotPath, "utf8")).toBe("exact-bundle-bytes");
      expect(fs.statSync(snapshotPath).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe("hub bootstrap workspace selection", () => {
  it("assigns source writeback to root System once available and never to another member's pair", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-writeback-owner-"));
    const databasePath = path.join(directory, "identity.db");
    const centralData = new CentralDataManager({ databasePath });
    const identityDb = new IdentityDb({ path: databasePath, readOnly: false });
    const userStore = new UserStore(identityDb);
    const state = { bootstrapWorkspaceId: null, centralData, identityDb, userStore };
    const pin = {
      url: "git+https://example.test/base.git",
      ref: "refs/heads/main",
      commit: "a".repeat(40),
      snapshot: `v1-sha256:${"b".repeat(64)}` as const,
    };
    const templates = { personal: pin, system: pin };
    try {
      expect(selectDevelopmentWritebackWorkspaceId(state)).toBeNull();
      const root = userStore.createRoot({ handle: "root", displayName: "Root" });
      identityDb.insertUser({
        id: "usr_member",
        handle: "member",
        displayName: "Member",
        role: "member",
        createdAt: 1,
      });
      centralData.ensurePrivateWorkspaces("usr_member", templates);
      expect(selectDevelopmentWritebackWorkspaceId(state)).toBeNull();
      const rootPair = centralData.ensurePrivateWorkspaces(root.id, templates);
      expect(selectDevelopmentWritebackWorkspaceId(state)).toBe(rootPair.system.workspaceId);
      centralData.ensurePrivateWorkspaces("usr_member", templates);
      expect(selectDevelopmentWritebackWorkspaceId(state)).toBe(rootPair.system.workspaceId);
      const project = centralData.addWorkspace("explicit");
      const projectState = { ...state, bootstrapWorkspaceId: project.workspaceId };
      expect(selectDevelopmentWritebackWorkspaceId(projectState)).toBe(rootPair.system.workspaceId);
    } finally {
      identityDb.close();
      centralData.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("leaves workspace selection to the authenticated user when no project was requested", () => {
    expect(selectBootstrapWorkspace({}, [{ name: "active" }, { name: "older" }])).toBeNull();
  });

  it("does not fabricate a project for an empty catalog", () => {
    expect(selectBootstrapWorkspace({}, [])).toBeNull();
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

  it("consumes an explicit bootstrap already registered by the desktop", () => {
    expect(
      selectBootstrapWorkspace({ bootstrapWorkspace: "dogfood" }, [{ name: "dogfood" }])
    ).toEqual({ name: "dogfood", lifecycle: "existing" });
  });
});

describe("hub workspace creation template selection", () => {
  const developmentPin = {
    url: "git+https://example.test/development-base.git",
    ref: "refs/heads/main",
    commit: "a".repeat(40),
    snapshot: `v1-sha256:${"b".repeat(64)}` as const,
  };
  const defaultTemplates = {
    base: developmentPin,
    personal: { ...developmentPin, ref: "refs/heads/distributions/personal" },
    system: { ...developmentPin, ref: "refs/heads/distributions/system" },
  };

  it("uses the minimal Base for ordinary creation", () => {
    expect(
      selectWorkspaceCreationRootTemplate({
        appRoot: "/unused",
        environment: {
          VIBESTUDIO_DEFAULT_WORKSPACE_TEMPLATES: JSON.stringify(defaultTemplates),
        },
      })
    ).toEqual(developmentPin);
  });

  it("accepts any explicit exact template", () => {
    expect(
      selectWorkspaceCreationRootTemplate({
        appRoot: "/unused",
        requested: developmentPin,
        environment: {
          VIBESTUDIO_DEFAULT_WORKSPACE_TEMPLATES: JSON.stringify(defaultTemplates),
        },
      })
    ).toEqual(developmentPin);
  });

  it("uses an initial System override only for bootstrap selection", () => {
    const environment = {
      NODE_ENV: "production",
      VIBESTUDIO_DEFAULT_WORKSPACE_TEMPLATES: JSON.stringify(defaultTemplates),
      VIBESTUDIO_INITIAL_WORKSPACE_TEMPLATE: JSON.stringify(defaultTemplates.system),
    };
    expect(
      selectWorkspaceCreationRootTemplate({
        appRoot: process.cwd(),
        initial: true,
        environment,
      })
    ).toEqual(defaultTemplates.system);
    expect(selectWorkspaceCreationRootTemplate({ appRoot: process.cwd(), environment })).toEqual(
      defaultTemplates.base
    );
  });

  it("does not constrain an explicit template to one development pin", () => {
    expect(
      selectWorkspaceCreationRootTemplate({
        appRoot: "/unused",
        requested: {
          ...developmentPin,
          commit: "c".repeat(40),
          snapshot: `v1-sha256:${"d".repeat(64)}` as const,
        },
        environment: {
          VIBESTUDIO_DEFAULT_WORKSPACE_TEMPLATES: JSON.stringify(defaultTemplates),
        },
      })
    ).toMatchObject({ commit: "c".repeat(40) });
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

  it("attempts cleanup of the exact detached child process group", async () => {
    const child = fakeChild();
    const missing = Object.assign(new Error("gone"), { code: "ESRCH" });
    const killProcess = vi.fn((_pid: number, signal?: NodeJS.Signals | number): true => {
      if (signal === 0) throw missing;
      return true;
    });

    await reapWorkspaceChildProcessGroup(child, { platform: "linux", killProcess });

    expect(killProcess).toHaveBeenNthCalledWith(1, -4321, "SIGKILL");
    expect(killProcess).toHaveBeenCalledTimes(1);
  });

  it("does not fail an orderly exit when descendant cleanup cannot be verified", async () => {
    const child = fakeChild({ exitCode: 0 });
    const warn = vi.fn();
    const killProcess = vi.fn((): true => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });
    await expect(
      reapWorkspaceChildProcessGroup(child, {
        platform: "darwin",
        killProcess,
        warn,
      })
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("descendant cleanup is unverified"));
  });

  it("does not signal a child whose OS exit is already recorded", async () => {
    const child = fakeChild({ exitCode: 0 });

    await terminateWorkspaceChild(child, { reap: async () => undefined });

    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe("workspace child startup diagnostics", () => {
  it("surfaces the child stderr that explains an early exit", async () => {
    await expect(
      waitForWorkspaceReadyFile(
        path.join(os.tmpdir(), "vibestudio-never-ready.json"),
        { exitCode: 1, signalCode: null },
        () => "Fatal: Failed to load native module: pty.node"
      )
    ).rejects.toThrow(
      "Workspace runtime exited before readiness (code 1)\n\n" +
        "Recent workspace stderr:\nFatal: Failed to load native module: pty.node"
    );
  });

  it("reports signal termination even when no numeric exit code exists", async () => {
    await expect(
      waitForWorkspaceReadyFile(path.join(os.tmpdir(), "vibestudio-never-ready.json"), {
        exitCode: null,
        signalCode: "SIGKILL",
      })
    ).rejects.toThrow("Workspace runtime exited before readiness (signal SIGKILL)");
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
        [
          "ws_dev",
          {
            runtimeToken: "old-token",
            serverBootId: "boot-child",
            revision: 1,
            users: new Map(),
            pendingApprovals: new Map(),
            workspaceApprovalCount: 0,
          },
        ],
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

  it("restarts an intentional epoch handoff even without ordinary route demand", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4321,
      exitCode: WORKSPACE_EPOCH_HANDOFF_EXIT_CODE,
      signalCode: null,
      kill: vi.fn(),
    }) as unknown as ChildProcess;
    const state = runtimeState(child);
    const replacement = {
      ...(state.runtimes.get("dev") as WorkspaceRuntime),
      child: Object.assign(new EventEmitter(), { pid: 8765 }) as unknown as ChildProcess,
    };
    const restart = vi.fn(async () => replacement);

    await handleWorkspaceChildExit(
      state,
      {
        advertisedName: "dev",
        childWorkspaceName: "dev-deadbeef",
        workspaceId: "ws_dev",
        runtimeToken: "child-token",
        child,
        code: WORKSPACE_EPOCH_HANDOFF_EXIT_CODE,
        signal: null,
      },
      { shouldRestart: () => false, reap: async () => undefined, restart }
    );

    expect(restart).toHaveBeenCalledOnce();
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
      removeWorkspaceTreeForTest,
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

    prepareEphemeralWorkspaceDisk(
      centralData,
      "boot-owner",
      "ws_dev",
      "dev-current",
      removeWorkspaceTreeForTest,
      remove
    );

    expect(remove).not.toHaveBeenCalled();
  });

  it("gives a displaced shutdown no filesystem coordinate to delete", () => {
    const remove = vi.fn(() => true);
    const compareRemove = vi.fn(() => null);
    const centralData = {
      removeEphemeralWorkspace: compareRemove,
    } as unknown as CentralDataManager;

    removeOwnedEphemeralWorkspace(
      centralData,
      "boot-displaced",
      removeWorkspaceTreeForTest,
      remove
    );

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

    removeOwnedEphemeralWorkspace(centralData, "boot-owner", removeWorkspaceTreeForTest, remove);

    expect(remove).toHaveBeenCalledWith(
      cleanup,
      centralData,
      "boot-owner",
      removeWorkspaceTreeForTest
    );
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
      VIBESTUDIO_GATEWAY_PORT: "3030",
      VIBESTUDIO_REQUIRE_MOBILE_READY: "1",
      VIBESTUDIO_REQUIRE_ELECTRON_READY: "1",
      VIBESTUDIO_WORKSPACE_DIR: "/somewhere",
      VIBESTUDIO_ADMIN_TOKEN: "hub-operator-token",
      VIBESTUDIO_INTERNAL_DO_BUNDLE_PATH: "/hub/runtime/internal-do.bundle.mjs",
    } as NodeJS.ProcessEnv,
    appRoot: "/app",
    advertisedWorkspaceName: "base",
    hubUrl: "http://127.0.0.1:3030",
    identityDbPath: "/hub/state/identity.db",
    workspaceChildToken: "workspace-child-identity",
    workspaceId: "ws_base",
    ephemeral: false,
  };

  it("shares the hub identity DB read-only and gives each advertised workspace one endpoint identity", () => {
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
    expect(envA["VIBESTUDIO_IROH_IDENTITY"]).toBe(
      path.join(getWorkspaceDir("base"), "reach", "iroh", "endpoint.key")
    );
    expect(envA["VIBESTUDIO_IROH_IDENTITY"]).toBe(envB["VIBESTUDIO_IROH_IDENTITY"]);
    expect(envA["VIBESTUDIO_ADMIN_TOKEN"]).toMatch(/^[a-f0-9]{64}$/);
    expect(envA["VIBESTUDIO_ADMIN_TOKEN"]).not.toBe(base.baseEnv["VIBESTUDIO_ADMIN_TOKEN"]);
    expect(envA["VIBESTUDIO_ADMIN_TOKEN"]).not.toBe(envB["VIBESTUDIO_ADMIN_TOKEN"]);
  });

  it("keeps the strict hub-child control contract and clears inherited ports", () => {
    const env = buildWorkspaceChildEnv({ ...base, childWorkspaceName: "alpha", ephemeral: true });
    expect(env["VIBESTUDIO_REQUIRE_MOBILE_READY"]).toBeUndefined();
    expect(env["VIBESTUDIO_REQUIRE_ELECTRON_READY"]).toBeUndefined();
    expect(env["VIBESTUDIO_PROCESS_ROLE"]).toBe("workspace-child");
    expect(env["VIBESTUDIO_HUB_URL"]).toBe("http://127.0.0.1:3030");
    expect(env["VIBESTUDIO_WORKSPACE_CHILD_TOKEN"]).toBe("workspace-child-identity");
    expect(env["VIBESTUDIO_CURRENT_SYSTEM_EPOCH"]).toBe(String(WORKSPACE_SYSTEM_EPOCH));
    expect(env["VIBESTUDIO_WORKSPACE"]).toBe("alpha");
    expect(env["VIBESTUDIO_ADVERTISED_WORKSPACE"]).toBe("base");
    expect(env["VIBESTUDIO_WORKSPACE_ID"]).toBe("ws_base");
    expect(env["VIBESTUDIO_WORKSPACE_EPHEMERAL"]).toBe("1");
    expect(env["VIBESTUDIO_GATEWAY_PORT"]).toBeUndefined();
    expect(env["VIBESTUDIO_WORKSPACE_DIR"]).toBeUndefined();
    expect(env["VIBESTUDIO_INTERNAL_DO_BUNDLE_PATH"]).toBe("/hub/runtime/internal-do.bundle.mjs");
    expect(env["PATH"]).toBe("/usr/bin");
  });

  it("passes the exact pending creation descriptor only to its child", () => {
    const creationIntent = {
      version: 1 as const,
      workspaceId: "ws_base",
      rootTemplate: {
        url: "git+https://example.test/base.git",
        ref: "refs/tags/v1",
        commit: "a".repeat(40),
        snapshot: `v1-sha256:${"b".repeat(64)}` as const,
      },
    };
    const env = buildWorkspaceChildEnv({
      ...base,
      childWorkspaceName: "base",
      creationIntent,
    });
    expect(JSON.parse(env["VIBESTUDIO_WORKSPACE_CREATION_INTENT"]!)).toEqual(creationIntent);
  });

  it("passes registered exact local sources to a newly created child", () => {
    const source = {
      pin: {
        url: "git+https://example.test/local.git",
        ref: "refs/heads/main",
        commit: "a".repeat(40),
        snapshot: `v1-sha256:${"b".repeat(64)}` as const,
      },
      checkout: "/instance/workspace-source-inspections/one/0",
      review: { repositories: ["panels/example"], files: ["meta/vibestudio.yml"] },
    };
    const env = buildWorkspaceChildEnv({
      ...base,
      childWorkspaceName: "base",
      workspaceSources: [source],
    });
    expect(JSON.parse(env["VIBESTUDIO_WORKSPACE_SOURCES"]!)).toEqual([source]);
  });

  it("strips obsolete unattended startup policy from the child", () => {
    const env = buildWorkspaceChildEnv({
      ...base,
      baseEnv: {
        ...base.baseEnv,
        VIBESTUDIO_AUTO_APPROVE_STARTUP_UNITS: "1",
      },
      childWorkspaceName: "alpha",
    });

    expect(env["VIBESTUDIO_AUTO_APPROVE_STARTUP_UNITS"]).toBeUndefined();
  });

  it("passes source write-back only to the supervisor-designated workspace", () => {
    const writeback = JSON.stringify({ root: "/source/base", repositories: ["meta"] });
    const designated = buildWorkspaceChildEnv({
      ...base,
      baseEnv: {
        ...base.baseEnv,
        VIBESTUDIO_DEV_ROOT_TEMPLATE_WRITEBACK: writeback,
        VIBESTUDIO_DEV_ROOT_TEMPLATE_WRITEBACK_WORKSPACE_ID: "ws_base",
      },
      childWorkspaceName: "base",
    });
    const other = buildWorkspaceChildEnv({
      ...base,
      baseEnv: {
        ...base.baseEnv,
        VIBESTUDIO_DEV_ROOT_TEMPLATE_WRITEBACK: writeback,
        VIBESTUDIO_DEV_ROOT_TEMPLATE_WRITEBACK_WORKSPACE_ID: "ws_base",
      },
      workspaceId: "ws_other",
      childWorkspaceName: "other",
    });

    expect(JSON.parse(designated["VIBESTUDIO_DEV_ROOT_TEMPLATE_WRITEBACK"]!)).toEqual({
      root: "/source/base",
      repositories: ["meta"],
      workspaceId: "ws_base",
    });
    expect(other["VIBESTUDIO_DEV_ROOT_TEMPLATE_WRITEBACK"]).toBeUndefined();
    expect(designated["VIBESTUDIO_DEV_ROOT_TEMPLATE_WRITEBACK_WORKSPACE_ID"]).toBeUndefined();
  });

  it("does not inherit an unrecognized startup approval value", () => {
    const env = buildWorkspaceChildEnv({
      ...base,
      baseEnv: {
        ...base.baseEnv,
        VIBESTUDIO_AUTO_APPROVE_STARTUP_UNITS: "true",
      },
      childWorkspaceName: "alpha",
    });

    expect(env["VIBESTUDIO_AUTO_APPROVE_STARTUP_UNITS"]).toBeUndefined();
  });
});

describe("historical workspace runtime environment", () => {
  it("opts a retained Electron executable into Node mode", () => {
    const env: NodeJS.ProcessEnv = {};
    applyWorkspaceHostRuntimeEnv(env, { historical: true, runtimeMode: "electron-node" });
    expect(env["ELECTRON_RUN_AS_NODE"]).toBe("1");
  });

  it("does not leak Electron's Node mode into a retained Node executable", () => {
    const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1" };
    applyWorkspaceHostRuntimeEnv(env, { historical: true, runtimeMode: "node" });
    expect(env["ELECTRON_RUN_AS_NODE"]).toBeUndefined();
  });

  it("leaves the current host environment unchanged", () => {
    const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "caller-owned" };
    applyWorkspaceHostRuntimeEnv(env, { historical: false, runtimeMode: "node" });
    expect(env["ELECTRON_RUN_AS_NODE"]).toBe("caller-owned");
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
  endpointId: "aa".repeat(32),
  relays: ["https://relay.example/"],
  v: 5 as const,
};

describe("hub public request schemas", () => {
  const credential = {
    deviceId: `dev_${"a".repeat(24)}`,
    refreshToken: "b".repeat(43),
  };

  it("accepts only the current pairing request contract", () => {
    expect(
      HubCompletePairingBodySchema.safeParse({
        code: "c".repeat(21) + "A",
        label: "Desktop",
        platform: "linux",
      }).success
    ).toBe(true);
    expect(
      HubCompletePairingBodySchema.safeParse({
        code: "c".repeat(21) + "A",
        ...credential,
      }).success
    ).toBe(false);
    expect(
      HubCompletePairingBodySchema.safeParse({
        code: "c".repeat(21) + "A",
        deviceId: credential.deviceId,
      }).success
    ).toBe(false);
    expect(
      HubCompletePairingBodySchema.safeParse({ code: "c".repeat(21) + "A", room: "legacy-room" })
        .success
    ).toBe(false);
    expect(
      HubCompletePairingBodySchema.safeParse({ code: "c".repeat(21) + "A", handle: "root_user" })
        .success
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
    membershipStore.add(root.id, runtime.workspaceId, root.id);
    const rootDevice = deviceAuthStore.issueDevice({
      userId: root.id,
      label: "root-cli",
      transport: { kind: "local" },
    });
    const shellToken = tokenManager.ensureToken(`shell:${rootDevice.deviceId}`, "shell");
    const state: HubRuntimeState = {
      appRoot: "/app",
      args: {},
      bootstrapWorkspaceId: runtime.workspaceId,
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
      workspaceSources: [],
      version: "test",
      buildId: "a".repeat(64),
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
        stop: vi.fn(async () => undefined),
      } as never,
      pairing: CHILD_REACH,
      rpcServer: {} as never,
      grantStore: { close: vi.fn() } as never,
      eventService: { emitProjected: vi.fn() } as never,
      inviteExpiryTimers: new Map(),
    };
    return { state, shellToken, rootUserId: root.id, rootDeviceId: rootDevice.deviceId };
  }

  it("retains committed creation through audit failure and reconciles the exact operation after retry", async () => {
    const { state, rootUserId, rootDeviceId } = makeState(fakeRuntime(9, {}));
    const central = new CentralDataManager({ databasePath: state.identityDbPath });
    state.centralData = central;
    const governance = new GovernanceLog({
      databasePath: path.join(path.dirname(state.identityDbPath), "governance.db"),
    });
    state.governanceLog = governance;
    const append = vi
      .spyOn(governance, "append")
      .mockRejectedValueOnce(new Error("Audit unavailable"));
    const subject = {
      userId: rootUserId,
      deviceId: rootDeviceId,
      handle: "root",
      role: "root" as const,
    };
    const input = {
      operationId: "retained-creation-0001",
      workspace: "created-once",
      rootTemplate: {
        url: "git+https://example.test/root.git",
        ref: "refs/tags/v1",
        commit: "a".repeat(40),
        snapshot: `v1-sha256:${"b".repeat(64)}`,
      },
    };
    try {
      await expect(
        executeHubControl(state, subject, "createWorkspace", [input], vi.fn())
      ).rejects.toThrow("Audit unavailable");
      const entry = central.getWorkspaceEntry(input.workspace)!;
      expect(entry).not.toBeNull();
      expect(state.membershipStore.isAdmin(rootUserId, entry.workspaceId)).toBe(true);
      expect(central.pendingWorkspaceCreationAudits()).toHaveLength(1);
      const reply = vi.fn();
      await executeHubControl(
        state,
        subject,
        "workspaceCreationReceipt",
        [{ operationId: input.operationId }],
        reply
      );
      expect(reply).toHaveBeenCalledWith({
        operationId: input.operationId,
        state: "registered",
        workspaceId: entry.workspaceId,
        name: input.workspace,
      });
      await executeHubControl(state, subject, "createWorkspace", [input], vi.fn());
      expect(central.getWorkspaceEntry(input.workspace)?.workspaceId).toBe(entry.workspaceId);
      expect(central.pendingWorkspaceCreationAudits()).toEqual([]);
      expect(append).toHaveBeenCalledTimes(2);
      expect(await governance.query()).toHaveLength(1);
    } finally {
      await governance.close();
      central.close();
      state.identityDb.close();
      fs.rmSync(path.dirname(state.identityDbPath), { recursive: true, force: true });
    }
  });

  it("registers only an instance-owned inspected source and reuses its exact coordinate", async () => {
    const runtime = fakeRuntime(9, {});
    const { state, rootUserId } = makeState(runtime);
    const instanceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-source-owner-"));
    const checkout = path.join(instanceRoot, "workspace-source-inspections", "request", "0");
    fs.mkdirSync(checkout, { recursive: true });
    const source = {
      pin: {
        url: "git+https://example.test/local.git",
        ref: "refs/heads/local",
        commit: "a".repeat(40),
        snapshot: `v1-sha256:${"b".repeat(64)}` as const,
      },
      checkout,
      review: { repositories: ["panels/example"], files: ["meta/vibestudio.yml"] },
    };
    vi.stubEnv("VIBESTUDIO_INSTANCE_ROOT", instanceRoot);
    try {
      const register = async (candidate: typeof source) => {
        let result: unknown;
        await executeHubControl(
          state,
          { userId: rootUserId, handle: "viewer", role: "member" },
          "registerLocalTemplateSource",
          [candidate],
          (value) => {
            result = value;
          }
        );
        return result;
      };
      expect(await register(source)).toEqual({ pin: source.pin, ...source.review });
      expect(await register(source)).toEqual({ pin: source.pin, ...source.review });
      expect(state.workspaceSources).toEqual([source]);
      await expect(register({ ...source, checkout: path.dirname(instanceRoot) })).rejects.toThrow(
        "outside the host-owned inspection root"
      );
    } finally {
      vi.unstubAllEnvs();
      state.identityDb.close();
      fs.rmSync(instanceRoot, { recursive: true, force: true });
    }
  });

  it("publishes an owner-projected full catalog after membership removal", async () => {
    const runtime = fakeRuntime(9, {});
    const { state, rootUserId } = makeState(runtime);
    state.membershipStore.add(rootUserId, runtime.workspaceId, rootUserId, "admin");
    const member = state.userStore.inviteUser({
      handle: "catalog_member",
      displayName: "Catalog member",
      role: "member",
      createdBy: rootUserId,
    });
    state.membershipStore.add(member.id, runtime.workspaceId, rootUserId);
    await executeHubControl(
      state,
      { userId: rootUserId, handle: "root", role: "root" },
      "removeWorkspaceMember",
      [{ workspace: runtime.advertisedName, userId: member.id }],
      vi.fn()
    );
    const emit = vi.mocked(state.controlTransport!.eventService.emitProjected);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[0]).toBe("hub:workspace-catalog-changed");
    const project = emit.mock.calls[0]?.[1];
    expect(project?.({ userId: member.id, callerId: "member", callerKind: "shell" })).toEqual({
      workspaces: [],
    });
    expect(project?.({ userId: rootUserId, callerId: "root", callerKind: "shell" })).toEqual({
      workspaces: [expect.objectContaining({ workspaceId: runtime.workspaceId })],
    });
  });

  it("uses workspace administration for RPC policy independently of account role", async () => {
    const runtime = fakeRuntime(9, {});
    const { state, rootUserId } = makeState(runtime);
    const rootSubject = { userId: rootUserId, handle: "root", role: "root" as const };
    const administrator = state.userStore.inviteUser({
      handle: "workspace_admin",
      displayName: "Workspace admin",
      role: "member",
      createdBy: rootUserId,
    });
    state.membershipStore.add(administrator.id, runtime.workspaceId, rootUserId, "admin");
    const subject = {
      userId: administrator.id,
      handle: administrator.handle,
      role: administrator.role,
    };
    const policy = {
      incoming: [],
      outgoing: [
        {
          workspaceId: "ws_destination",
          userId: administrator.id,
          target: "main",
          operation: "notes.read",
          purpose: "call" as const,
        },
      ],
    };
    const args = [
      { workspaceId: runtime.workspaceId, policy, expectedPolicy: { incoming: [], outgoing: [] } },
    ];
    try {
      for (const method of ["getWorkspaceRpcPolicy", "setWorkspaceRpcPolicy"]) {
        await expect(executeHubControl(state, rootSubject, method, args, vi.fn())).rejects.toThrow(
          "Requires workspace administrator role"
        );
      }
      const respond = vi.fn();
      await executeHubControl(state, subject, "setWorkspaceRpcPolicy", args, respond);
      expect(state.identityDb.getWorkspaceRpcPolicy(runtime.workspaceId)).toEqual(policy);
      await executeHubControl(state, subject, "getWorkspaceRpcPolicy", args, respond);
      expect(respond).toHaveBeenLastCalledWith({
        workspaceId: runtime.workspaceId,
        policy,
        incomingLocked: false,
      });
    } finally {
      state.identityDb.close();
      fs.rmSync(path.dirname(state.identityDbPath), { recursive: true, force: true });
    }
  });

  it("rejects account-admin invitations into a workspace they only belong to", async () => {
    const runtime = fakeRuntime(9, {});
    const { state, rootUserId } = makeState(runtime);
    try {
      await expect(
        executeHubControl(
          state,
          { userId: rootUserId, handle: "root", role: "root" },
          "inviteUser",
          [{ handle: "unapproved_guest", workspaces: [runtime.advertisedName] }],
          vi.fn()
        )
      ).rejects.toThrow("Requires workspace administrator role");
      expect(state.userStore.getByHandle("unapproved_guest")).toBeNull();
      expect(state.identityDb.listMembers(runtime.workspaceId)).toHaveLength(1);
    } finally {
      state.identityDb.close();
      fs.rmSync(path.dirname(state.identityDbPath), { recursive: true, force: true });
    }
  });

  it("projects only the viewer's live approval counts and retires replaced child reports", async () => {
    const runtime = fakeRuntime(9, {});
    const { state, rootUserId } = makeState(runtime);
    const bob = state.userStore.inviteUser({
      handle: "bob",
      displayName: "Bob",
      role: "member",
      createdBy: rootUserId,
    });
    state.membershipStore.add(bob.id, runtime.workspaceId, rootUserId, "admin");
    state.workspaceChildTokens.set(runtime.runtimeToken, runtime.workspaceId);
    const report = {
      serverBootId: `boot_${"C".repeat(24)}`,
      revision: 1,
      users: [],
      pendingApprovals: [
        { userId: rootUserId, count: 2 },
        { userId: bob.id, count: 5 },
        { userId: "outsider", count: 100 },
      ],
      workspaceApprovalCount: 3,
    };
    const list = async (userId: string) => {
      let entries: Array<{ pendingApprovalCount: number }> = [];
      await executeHubControl(
        state,
        { userId, handle: "viewer", role: "member" },
        "listWorkspaces",
        [],
        (result) => {
          entries = result as typeof entries;
        }
      );
      return entries;
    };
    try {
      expect(
        applyHubWorkspacePresenceReport(state, runtime.workspaceId, report, runtime.runtimeToken)
      ).toBe(true);
      expect((await list(rootUserId))[0]?.pendingApprovalCount).toBe(2);
      expect((await list(bob.id))[0]?.pendingApprovalCount).toBe(8);
      expect(await list("outsider")).toEqual([]);
      expect(
        state.workspacePresence.get(runtime.workspaceId)?.pendingApprovals.has("outsider")
      ).toBe(false);
      expect(
        applyHubWorkspacePresenceReport(
          state,
          runtime.workspaceId,
          { ...report, pendingApprovals: [] },
          runtime.runtimeToken
        )
      ).toBe(false);
      state.membershipStore.add(bob.id, runtime.workspaceId, rootUserId, "member");
      expect((await list(bob.id))[0]?.pendingApprovalCount).toBe(5);
      state.workspaceChildTokens.delete(runtime.runtimeToken);
      const replacement = { ...runtime, runtimeToken: "replacement-token" };
      state.runtimes.set(runtime.advertisedName, replacement);
      state.workspaceChildTokens.set(replacement.runtimeToken, runtime.workspaceId);
      expect((await list(rootUserId))[0]?.pendingApprovalCount).toBe(0);
      expect(
        applyHubWorkspacePresenceReport(
          state,
          runtime.workspaceId,
          { ...report, revision: 50 },
          runtime.runtimeToken
        )
      ).toBe(false);
      expect(
        applyHubWorkspacePresenceReport(
          state,
          runtime.workspaceId,
          { ...report, pendingApprovals: [], workspaceApprovalCount: 0 },
          replacement.runtimeToken
        )
      ).toBe(true);
      expect((await list(rootUserId))[0]?.pendingApprovalCount).toBe(0);
      state.runtimes.delete(runtime.advertisedName);
      expect((await list(rootUserId))[0]?.pendingApprovalCount).toBe(0);
    } finally {
      state.identityDb.close();
      fs.rmSync(path.dirname(state.identityDbPath), { recursive: true, force: true });
    }
  });

  it("writes one canonical secret-free hub ready contract", () => {
    const { state } = makeState(fakeRuntime(9, {}));
    const invite = (() => {
      const pairing = {
        endpointId: "aa".repeat(32),
        relays: ["https://relay.example/"],
        code: "R".repeat(21) + "A",
        v: 5 as const,
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
        "buildId",
        "workspaces",
      ].sort()
    );
    expect(payload).toMatchObject({
      mode: "hub",
      gatewayUrl: "http://127.0.0.1:9",
      rootInvite: invite,
      pid: 4242,
      version: "test",
      buildId: "a".repeat(64),
    });
    expect(payload).not.toHaveProperty("adminToken");
    expect(payload).not.toHaveProperty("publicUrl");
    expect(payload.workspaces.length).toBeGreaterThan(0);
    for (const workspace of payload.workspaces) {
      expect(
        Object.keys(workspace).every((key) =>
          ["workspaceId", "name", "lastOpened", "running", "ephemeral"].includes(key)
        )
      ).toBe(true);
      expect(workspace).not.toHaveProperty("pendingApprovalCount");
      expect(workspace).not.toHaveProperty("privateRole");
    }
    expect(payload.rootInvite).not.toHaveProperty("qr");
    expect(payload.rootInvite).not.toHaveProperty("serverUrl");
  });

  it("revokes a device immediately and retires its authenticated caller", async () => {
    const runtime = fakeRuntime(9, {});
    const { state, rootUserId } = makeState(runtime);
    const invite = state.deviceAuthStore.createPairingInvite(30_000, {
      workspaceId: runtime.workspaceId,
      userId: rootUserId,
      intent: "pair-device",
    });
    const paired = state.deviceAuthStore.completePairing({
      code: invite.code,
      label: "phone",
      transport: { kind: "local" },
    });
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
    release();
    await retired;
  });

  it("retires every authenticated device caller when a user is revoked", async () => {
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
      const credential = state.deviceAuthStore.completePairing({
        code: invite.code,
        label,
        transport: { kind: "local" },
      });
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

    for (const credential of paired) {
      releases.get(`shell:${credential.deviceId}`)!();
    }
    await Promise.resolve();
    await Promise.resolve();
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
