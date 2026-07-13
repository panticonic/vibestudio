import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getWorkspaceDir } from "@vibestudio/env-paths";
import { TokenManager } from "@vibestudio/shared/tokenManager";
import { CentralDataManager } from "@vibestudio/shared/centralData";
import { IdentityDb } from "@vibestudio/shared/users/identityDb";
import { UserStore } from "@vibestudio/shared/users/userStore";
import { MembershipStore } from "@vibestudio/shared/users/membership";
import { createConnectDeepLink, createConnectPairUrl } from "@vibestudio/shared/connect";
import { DeviceAuthStore } from "./services/deviceAuthStore.js";
import {
  applyHubWorkspacePresenceReport,
  buildHubReadyPayload,
  buildWorkspaceChildArgs,
  buildWorkspaceChildEnv,
  handleRpc,
  HubCompletePairingBodySchema,
  HubDeviceCredentialBodySchema,
  HubRootCompletePairingBodySchema,
  openHubDataStores,
  prepareEphemeralWorkspaceDisk,
  signalWorkspaceChildTree,
  terminateWorkspaceChild,
  type HubRuntimeState,
  type WorkspaceRuntime,
} from "./hubServer.js";

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

    await terminateWorkspaceChild(child);

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

  it("does not signal a child whose OS exit is already recorded", async () => {
    const child = fakeChild({ exitCode: 0 });

    await terminateWorkspaceChild(child);

    expect(child.kill).not.toHaveBeenCalled();
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
      getEphemeralWorkspace: () => record,
      setEphemeralWorkspaceDiskName: (workspaceId: string, diskName: string) => {
        record = { workspaceId, diskName };
      },
    } as unknown as CentralDataManager;

    prepareEphemeralWorkspaceDisk(centralData, "ws_dev", "dev-replacement", (name) => {
      calls.push(name);
      return true;
    });

    expect(calls).toEqual(["dev-crashed"]);
    expect(record).toEqual({ workspaceId: "ws_dev", diskName: "dev-replacement" });
  });

  it("does not remove a checkout when re-registering the same disk name", () => {
    const remove = vi.fn(() => true);
    const centralData = {
      getEphemeralWorkspace: () => ({ workspaceId: "ws_dev", diskName: "dev-current" }),
      setEphemeralWorkspaceDiskName: vi.fn(),
    } as unknown as CentralDataManager;

    prepareEphemeralWorkspaceDisk(centralData, "ws_dev", "dev-current", remove);

    expect(remove).not.toHaveBeenCalled();
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

const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function listen(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

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
    hubControlToken: "hub-child-capability",
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

    const advertisedState = path.join(getWorkspaceDir("base"), "state");
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
      path.join(advertisedState, "webrtc", "identity.pem")
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
    expect(env["VIBESTUDIO_HUB_CONTROL_TOKEN"]).toBe("hub-child-capability");
    expect(env["VIBESTUDIO_WORKSPACE"]).toBe("alpha");
    expect(env["VIBESTUDIO_ADVERTISED_WORKSPACE"]).toBe("base");
    expect(env["VIBESTUDIO_WORKSPACE_ID"]).toBe("ws_base");
    expect(env["VIBESTUDIO_ROUTED_ROOM_STATE_PATH"]).toBe(
      path.join(getWorkspaceDir("base"), "state", "webrtc", "routes.json")
    );
    expect(env["VIBESTUDIO_WORKSPACE_EPHEMERAL"]).toBe("1");
    expect(env["VIBESTUDIO_GATEWAY_PORT"]).toBeUndefined();
    expect(env["VIBESTUDIO_WORKSPACE_DIR"]).toBeUndefined();
    expect(env["PATH"]).toBe("/usr/bin");
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
    controlToken: "child-control",
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
    touchWorkspace: () => {},
    setLastWorkspaceForUser: () => {},
  } as unknown as CentralDataManager;
}

/** Hub RPC round-trip helper (loopback `/rpc`), shared across the suites below. */
async function rpc(
  port: number,
  token: string,
  method: string,
  args: unknown[]
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ method, args }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
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
      HubRootCompletePairingBodySchema.safeParse({
        code: "c".repeat(32),
        handle: "root_user",
        displayName: "Root User",
        label: "Desktop",
        platform: "linux",
      }).success
    ).toBe(true);
    expect(
      HubRootCompletePairingBodySchema.safeParse({
        code: "c".repeat(32),
        ...credential,
      }).success
    ).toBe(true);
    expect(
      HubRootCompletePairingBodySchema.safeParse({
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

/** A fake read-only workspace child exposing only the ingress-routing route. */
async function listenFakeChild(expectations: {
  adminToken: string;
  onBody?: (body: unknown) => void;
  responseForBody?: (body: Record<string, unknown>) => Record<string, unknown>;
}): Promise<number> {
  return listen((req, res) => {
    void (async () => {
      if (req.method === "POST" && req.url === "/_r/s/internal/route") {
        if (req.headers.authorization !== `Bearer ${expectations.adminToken}`) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<
          string,
          unknown
        >;
        expectations.onBody?.(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(expectations.responseForBody?.(body) ?? CHILD_REACH));
        return;
      }
      res.writeHead(404);
      res.end();
    })();
  });
}

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
      startupPairingCode: null,
      startupQrPairingCode: null,
      childControlTokens: new Map(),
      workspacePresence: new Map(),
      runtimes: new Map([[runtime.advertisedName, runtime]]),
      shuttingDown: false,
    };
    return { state, shellToken, rootUserId: root.id, rootDeviceId: rootDevice.deviceId };
  }

  it("writes one canonical secret-free hub ready contract", () => {
    const { state } = makeState(fakeRuntime(9, {}));
    const invite = (kind: "desktop" | "mobile") => {
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
        serverId: state.deviceAuthStore.getServerId(),
        serverBootId: state.serverBootId,
      };
    };
    const desktop = invite("desktop");
    const mobile = invite("mobile");

    const payload = buildHubReadyPayload(state, { desktop, mobile }, 4242);

    expect(Object.keys(payload).sort()).toEqual(
      [
        "mode",
        "gatewayUrl",
        "connectUrl",
        "rootInvites",
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
      connectUrl: "http://127.0.0.1:9",
      rootInvites: { desktop, mobile },
      pid: 4242,
      version: "test",
    });
    expect(payload).not.toHaveProperty("adminToken");
    expect(payload).not.toHaveProperty("publicUrl");
    expect(payload.rootInvites).not.toHaveProperty("qr");
    expect(payload.rootInvites?.desktop).not.toHaveProperty("serverUrl");
  });

  it("hubControl.routeWorkspace arms a child room without writing identity state", async () => {
    const bodies: unknown[] = [];
    const childPort = await listenFakeChild({
      adminToken: "child-admin",
      onBody: (body) => bodies.push(body),
      responseForBody: (body) => ({
        ...CHILD_REACH,
        room: body["purpose"] === "control" ? "control-room" : "workspace-room",
      }),
    });
    const { state, shellToken } = makeState(fakeRuntime(childPort, { adminToken: "child-admin" }));
    const hubPort = await listen((req, res) => void handleRpc(state, req, res));

    const { status, body } = await rpc(hubPort, shellToken, "hubControl.routeWorkspace", [
      { workspace: "dev" },
    ]);
    expect(status).toBe(200);
    expect(body["result"]).toMatchObject({
      workspace: "dev",
      running: true,
      controlReach: { ...CHILD_REACH, room: "control-room" },
      workspaceReach: { ...CHILD_REACH, room: "workspace-room" },
    });
    const deviceId = expect.stringMatching(/^dev_/);
    expect(bodies).toEqual(
      expect.arrayContaining([
        { deviceId, purpose: "control", reuseExisting: true },
        { deviceId, purpose: "workspace" },
      ])
    );
    expect(bodies).toHaveLength(2);
  });
});

describe("hub membership gating (WP2 §4)", () => {
  /**
   * A hub with two registered+running workspaces (`alpha`, `beta`), a root
   * account, and a `member` (alice) who holds a membership row for `alpha`
   * only. Both runtimes are pre-registered so route/list never spawn a child.
   */
  function makeFixture(): {
    state: HubRuntimeState;
    rootToken: string;
    aliceToken: string;
    rootUserId: string;
    aliceUserId: string;
    aliceDeviceId: string;
  } {
    const tokenManager = new TokenManager();
    tokenManager.setAdminToken("hub-admin");
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-hub-mem-"));
    const identityDbPath = path.join(stateDir, "identity.db");
    const identityDb = new IdentityDb({ path: identityDbPath, readOnly: false });
    const catalog = new DatabaseSync(identityDbPath);
    const insertWorkspace = catalog.prepare(
      "INSERT INTO workspaces (workspace_id, name, last_opened) VALUES (?, ?, ?)"
    );
    insertWorkspace.run("ws_alpha", "alpha", 3000);
    insertWorkspace.run("ws_beta", "beta", 2000);
    catalog.close();
    const userStore = new UserStore(identityDb);
    const membershipStore = new MembershipStore(identityDb, userStore);
    const deviceAuthStore = new DeviceAuthStore({
      db: identityDb,
      serverIdPath: path.join(stateDir, "server-id.json"),
    });

    const root = userStore.createRoot({ handle: "root", displayName: "Root" });
    const alice = userStore.inviteUser({
      handle: "alice",
      displayName: "Alice",
      role: "member",
      createdBy: root.id,
    });
    const rootDevice = deviceAuthStore.issueDevice({ userId: root.id, label: "root-cli" });
    const aliceDevice = deviceAuthStore.issueDevice({ userId: alice.id, label: "alice-laptop" });
    const rootToken = tokenManager.ensureToken(`shell:${rootDevice.deviceId}`, "shell");
    const aliceToken = tokenManager.ensureToken(`shell:${aliceDevice.deviceId}`, "shell");

    // Two registered workspaces; alice is a member of `alpha` only.
    const centralData = makeHubCentralData([
      { name: "alpha", workspaceId: "ws_alpha", lastOpened: 3000 },
      { name: "beta", workspaceId: "ws_beta", lastOpened: 2000 },
    ]);
    membershipStore.add(alice.id, "ws_alpha", root.id);

    // Pre-register both runtimes so route/select attach the existing child
    // instead of spawning a real process. `alpha` advertises a pairing seam.
    const runtimes = new Map<string, WorkspaceRuntime>([
      [
        "alpha",
        fakeRuntime(
          9,
          {
            serverId: `srv_${"A".repeat(24)}`,
            serverBootId: `boot_${"A".repeat(24)}`,
            pairing: {
              sig: "wss://sig.example/",
              fp: "FP",
              v: 2,
              ice: "all",
              srv: "alpha",
            },
          },
          { advertisedName: "alpha", workspaceId: "ws_alpha" }
        ),
      ],
      ["beta", fakeRuntime(9, {}, { advertisedName: "beta", workspaceId: "ws_beta" })],
    ]);

    const state: HubRuntimeState = {
      appRoot: "/app",
      args: {},
      centralData,
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
      startupPairingCode: null,
      startupQrPairingCode: null,
      childControlTokens: new Map(),
      workspacePresence: new Map(),
      runtimes,
      shuttingDown: false,
    };
    return {
      state,
      rootToken,
      aliceToken,
      rootUserId: root.id,
      aliceUserId: alice.id,
      aliceDeviceId: aliceDevice.deviceId,
    };
  }

  it("hubControl.listWorkspaces — root sees the full registry", async () => {
    const { state, rootToken } = makeFixture();
    const hubPort = await listen((req, res) => void handleRpc(state, req, res));

    const { status, body } = await rpc(hubPort, rootToken, "hubControl.listWorkspaces", []);
    expect(status).toBe(200);
    const list = body["result"] as Array<{ name: string; workspaceId: string; running: boolean }>;
    expect(list.map((w) => w.name)).toEqual(["alpha", "beta"]);
    // Each entry surfaces its opaque id and running state.
    expect(list.map((w) => w.workspaceId)).toEqual(["ws_alpha", "ws_beta"]);
    expect(list.every((w) => w.running)).toBe(true);
  });

  it("aggregates ordered child presence reports across visible workspaces", async () => {
    const { state, rootToken, aliceUserId, rootUserId } = makeFixture();
    state.membershipStore.add(aliceUserId, "ws_beta", rootUserId);

    expect(
      applyHubWorkspacePresenceReport(state, "ws_alpha", {
        serverBootId: `boot_${"A".repeat(24)}`,
        revision: 2,
        users: [{ userId: aliceUserId, endpoints: 2 }],
      })
    ).toBe(true);
    expect(
      applyHubWorkspacePresenceReport(state, "ws_alpha", {
        serverBootId: `boot_${"A".repeat(24)}`,
        revision: 1,
        users: [],
      })
    ).toBe(false);
    expect(
      applyHubWorkspacePresenceReport(state, "ws_beta", {
        serverBootId: `boot_${"C".repeat(24)}`,
        revision: 1,
        users: [{ userId: aliceUserId, endpoints: 1 }],
      })
    ).toBe(true);

    const hubPort = await listen((req, res) => void handleRpc(state, req, res));
    const { status, body } = await rpc(hubPort, rootToken, "hubControl.listUserPresence", [
      { handle: "ALICE" },
    ]);
    expect(status).toBe(200);
    expect(body["result"]).toEqual({
      userId: aliceUserId,
      handle: "alice",
      displayName: "Alice",
      workspaces: [
        { workspace: "alpha", workspaceId: "ws_alpha", endpoints: 2 },
        { workspace: "beta", workspaceId: "ws_beta", endpoints: 1 },
      ],
    });
  });

  it("hubControl.listWorkspaces — a member sees only workspaces they belong to", async () => {
    const { state, aliceToken } = makeFixture();
    const hubPort = await listen((req, res) => void handleRpc(state, req, res));

    const { status, body } = await rpc(hubPort, aliceToken, "hubControl.listWorkspaces", []);
    expect(status).toBe(200);
    const list = body["result"] as Array<{ name: string; workspaceId: string }>;
    // alice holds a row for `alpha` only — `beta` is filtered out of her view.
    expect(list.map((w) => w.name)).toEqual(["alpha"]);
    expect(list[0]!.workspaceId).toBe("ws_alpha");
  });

  it("hubControl.routeWorkspace — a non-member is refused before any spawn", async () => {
    const { state, aliceToken } = makeFixture();
    const hubPort = await listen((req, res) => void handleRpc(state, req, res));

    const { status, body } = await rpc(hubPort, aliceToken, "hubControl.routeWorkspace", [
      { workspace: "beta" },
    ]);
    // The membership pre-filter short-circuits BEFORE ensureWorkspaceRuntime,
    // so a non-member never starts (or reaches) the child (WP2 §4).
    expect(status).toBe(403);
    expect(body["code"]).toBe("EACCES");
    expect(body["error"]).toMatch(/Not a member of workspace "beta"/);
  });

  it("hubControl.listWorkspaceMembers includes root's implicit membership", async () => {
    const { state, rootToken, rootUserId } = makeFixture();
    const hubPort = await listen((req, res) => void handleRpc(state, req, res));

    const { status, body } = await rpc(hubPort, rootToken, "hubControl.listWorkspaceMembers", [
      { workspace: "alpha" },
    ]);
    expect(status).toBe(200);
    expect(body["result"]).toMatchObject({
      workspaceId: "ws_alpha",
      members: expect.arrayContaining([
        expect.objectContaining({ userId: rootUserId, role: "root", implicit: true }),
      ]),
    });
  });

  it("restores an existing membership when governance rejects a repeated add", async () => {
    const { state, rootToken, aliceUserId } = makeFixture();
    const before = state.identityDb
      .listMembers("ws_alpha")
      .find((row) => row.userId === aliceUserId)!;
    state.governanceLog = {
      append: async () => {
        throw new Error("governance unavailable");
      },
    } as unknown as HubRuntimeState["governanceLog"];
    const hubPort = await listen((req, res) => void handleRpc(state, req, res));

    const { status } = await rpc(hubPort, rootToken, "hubControl.addWorkspaceMember", [
      { workspace: "alpha", userId: aliceUserId },
    ]);

    expect(status).toBe(500);
    expect(
      state.identityDb.listMembers("ws_alpha").find((row) => row.userId === aliceUserId)
    ).toEqual(before);
  });

  it("removes a newly inserted explicit root row when governance rejects an add", async () => {
    const { state, rootToken, rootUserId } = makeFixture();
    state.governanceLog = {
      append: async () => {
        throw new Error("governance unavailable");
      },
    } as unknown as HubRuntimeState["governanceLog"];
    const hubPort = await listen((req, res) => void handleRpc(state, req, res));

    const { status } = await rpc(hubPort, rootToken, "hubControl.addWorkspaceMember", [
      { workspace: "alpha", userId: rootUserId },
    ]);

    expect(status).toBe(500);
    expect(state.identityDb.listMembers("ws_alpha").some((row) => row.userId === rootUserId)).toBe(
      false
    );
  });

  it("members list only their own devices and can mint a fully-routed device invite", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const childPort = await listenFakeChild({
      adminToken: "child-admin",
      onBody: (body) => bodies.push(body as Record<string, unknown>),
    });
    const { state, aliceToken, aliceUserId } = makeFixture();
    state.runtimes.set(
      "alpha",
      fakeRuntime(
        childPort,
        { adminToken: "child-admin" },
        { advertisedName: "alpha", workspaceId: "ws_alpha" }
      )
    );
    const hubPort = await listen((req, res) => void handleRpc(state, req, res));

    const listed = await rpc(hubPort, aliceToken, "hubControl.listDevices", []);
    expect(listed.status).toBe(200);
    const devices = (listed.body["result"] as { devices: Array<{ userId: string }> }).devices;
    expect(devices).toHaveLength(1);
    expect(devices[0]?.userId).toBe(aliceUserId);

    const paired = await rpc(hubPort, aliceToken, "hubControl.pairDevice", [
      { workspace: "alpha", ttlMs: 30_000 },
    ]);
    expect(paired.status).toBe(200);
    const pairing = (paired.body["result"] as { pairing: { code: string; expiresAt: number } })
      .pairing;
    expect(bodies).toEqual([
      expect.objectContaining({
        inviteCodeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        expiresAt: pairing.expiresAt,
      }),
    ]);
  });

  it("rolls an invited account back when its child reach cannot be armed", async () => {
    const childPort = await listen((req, res) => {
      if (req.url === "/_r/s/internal/release-route") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ released: true }));
        return;
      }
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "ingress unavailable" }));
    });
    const { state, rootToken } = makeFixture();
    state.runtimes.set(
      "alpha",
      fakeRuntime(
        childPort,
        { adminToken: "child-admin" },
        { advertisedName: "alpha", workspaceId: "ws_alpha" }
      )
    );
    const hubPort = await listen((req, res) => void handleRpc(state, req, res));

    const { status, body } = await rpc(hubPort, rootToken, "hubControl.inviteUser", [
      { handle: "mara", workspaces: ["alpha"], ttlMs: 30_000 },
    ]);
    expect(status).toBe(500);
    expect(body["error"]).toMatch(/ingress unavailable/);
    expect(state.userStore.getByHandle("mara")).toBeNull();
    expect(state.membershipStore.listMembers("ws_alpha")).toHaveLength(1);
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
