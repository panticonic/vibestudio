import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { getWorkspaceDir } from "@vibez1/env-paths";
import { TokenManager } from "@vibez1/shared/tokenManager";
import type { CentralDataManager } from "@vibez1/shared/centralData";
import { DeviceAuthStore } from "./services/deviceAuthStore.js";
import {
  buildWorkspaceChildEnv,
  handleRpc,
  mintChildPairingInvite,
  type HubRuntimeState,
  type WorkspaceRuntime,
} from "./hubServer.js";

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
      // The hub's own paths must NOT leak into children (the old shared-store
      // wiring was a validated cross-process collision bug).
      VIBEZ1_AUTH_STORE_PATH: "/hub/devices.json",
      VIBEZ1_WEBRTC_CERT: "/hub/server.pem",
      VIBEZ1_WEBRTC_KEY: "/hub/server.key",
      VIBEZ1_GATEWAY_PORT: "3030",
      VIBEZ1_WORKSPACE_DIR: "/somewhere",
    } as NodeJS.ProcessEnv,
    appRoot: "/app",
    hubUrl: "http://127.0.0.1:3030",
    ephemeral: false,
    autoApproveStartupUnits: false,
  };

  it("gives every child its OWN auth store and DTLS identity under its state dir", () => {
    const envA = buildWorkspaceChildEnv({ ...base, childWorkspaceName: "alpha" });
    const envB = buildWorkspaceChildEnv({ ...base, childWorkspaceName: "beta" });

    const stateA = path.join(getWorkspaceDir("alpha"), "state");
    expect(envA["VIBEZ1_AUTH_STORE_PATH"]).toBe(path.join(stateA, "auth", "devices.json"));
    expect(envA["VIBEZ1_WEBRTC_CERT"]).toBe(path.join(stateA, "webrtc", "server.pem"));
    expect(envA["VIBEZ1_WEBRTC_KEY"]).toBe(path.join(stateA, "webrtc", "server.key"));

    // Distinct per child; never the hub's paths.
    for (const key of ["VIBEZ1_AUTH_STORE_PATH", "VIBEZ1_WEBRTC_CERT", "VIBEZ1_WEBRTC_KEY"]) {
      expect(envA[key]).not.toBe(envB[key]);
      expect(envA[key]).not.toBe(base.baseEnv[key]);
      expect(envB[key]).not.toBe(base.baseEnv[key]);
    }
  });

  it("keeps the hub-child contract env (startup pairing off, hub URL, cleared ports)", () => {
    const env = buildWorkspaceChildEnv({ ...base, childWorkspaceName: "alpha", ephemeral: true });
    expect(env["VIBEZ1_DISABLE_STARTUP_PAIRING"]).toBe("1");
    expect(env["VIBEZ1_FORCE_WORKSPACE_SERVER"]).toBe("1");
    expect(env["VIBEZ1_HUB_URL"]).toBe("http://127.0.0.1:3030");
    expect(env["VIBEZ1_WORKSPACE"]).toBe("alpha");
    expect(env["VIBEZ1_WORKSPACE_EPHEMERAL"]).toBe("1");
    expect(env["VIBEZ1_GATEWAY_PORT"]).toBeUndefined();
    expect(env["VIBEZ1_WORKSPACE_DIR"]).toBeUndefined();
    expect(env["PATH"]).toBe("/usr/bin");
  });
});

function fakeRuntime(port: number, ready: Record<string, unknown>): WorkspaceRuntime {
  return {
    name: "dev",
    advertisedName: "dev",
    port,
    publicUrl: "http://127.0.0.1:9/_workspace/dev",
    child: { exitCode: null } as ChildProcess,
    ready,
  };
}

const CHILD_INVITE = {
  code: "C".repeat(24),
  deepLink: `vibez1://connect?room=child-room&fp=${"AA".repeat(32)}&code=${"C".repeat(24)}&sig=wss%3A%2F%2Fsignal.example%2F&v=2&ice=all`,
  room: "child-room",
  expiresInMs: 60_000,
  expiresAt: 1_000_060_000,
  serverId: "srv_child",
};

/** A fake workspace child exposing only the invite-minting auth route. */
async function listenFakeChild(expectations: {
  adminToken: string;
  onBody?: (body: unknown) => void;
}): Promise<number> {
  return listen((req, res) => {
    void (async () => {
      if (req.method === "POST" && req.url === "/_r/s/auth/create-pairing-code") {
        if (req.headers.authorization !== `Bearer ${expectations.adminToken}`) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        expectations.onBody?.(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(CHILD_INVITE));
        return;
      }
      res.writeHead(404);
      res.end();
    })();
  });
}

describe("mintChildPairingInvite (hub→child invite proxying)", () => {
  it("mints in the child with the child's admin token and forwards ttlMs", async () => {
    const bodies: unknown[] = [];
    const port = await listenFakeChild({
      adminToken: "child-admin",
      onBody: (body) => bodies.push(body),
    });
    const invite = await mintChildPairingInvite(
      fakeRuntime(port, { adminToken: "child-admin" }),
      45_000
    );
    expect(invite).toEqual(CHILD_INVITE);
    expect(bodies).toEqual([{ ttlMs: 45_000 }]);
  });

  it("returns null (never throws) when the child has no admin token or rejects", async () => {
    expect(await mintChildPairingInvite(fakeRuntime(9, {}))).toBeNull();

    const port = await listenFakeChild({ adminToken: "other-token" });
    expect(await mintChildPairingInvite(fakeRuntime(port, { adminToken: "wrong" }))).toBeNull();
  });
});

describe("hub RPC pairing surfacing (§5)", () => {
  function makeState(runtime: WorkspaceRuntime): {
    state: HubRuntimeState;
    shellToken: string;
  } {
    const tokenManager = new TokenManager();
    tokenManager.setAdminToken("hub-admin");
    const shellToken = tokenManager.ensureToken("shell:test", "shell");
    const deviceAuthStore = new DeviceAuthStore(
      path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vibez1-hub-test-")), "devices.json")
    );
    const state: HubRuntimeState = {
      appRoot: "/app",
      args: {},
      // workspace.select / createPairingInvite never touch central data when
      // the runtime is already running; stubbed to keep the test hermetic.
      centralData: {} as CentralDataManager,
      deviceAuthStore,
      tokenManager,
      serverBootId: "boot_hub",
      adminToken: "hub-admin",
      tokenSource: "generated",
      gatewayPort: 9,
      protocol: "http",
      externalHost: "127.0.0.1",
      bindHost: "127.0.0.1",
      publicUrl: null,
      connectUrl: "http://127.0.0.1:9",
      authStorePath: "/hub/devices.json",
      startupPairingCode: null,
      startupQrPairingCode: null,
      runtimes: new Map([[runtime.advertisedName, runtime]]),
      shuttingDown: false,
    };
    return { state, shellToken };
  }

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

  it("workspace.select surfaces the child's pairing invite (deep link included)", async () => {
    const childPort = await listenFakeChild({ adminToken: "child-admin" });
    const { state, shellToken } = makeState(fakeRuntime(childPort, { adminToken: "child-admin" }));
    const hubPort = await listen((req, res) => void handleRpc(state, req, res));

    const { status, body } = await rpc(hubPort, shellToken, "workspace.select", ["dev"]);
    expect(status).toBe(200);
    expect(body["result"]).toMatchObject({
      workspaceName: "dev",
      running: true,
      pairing: CHILD_INVITE,
    });
  });

  it("auth.createPairingInvite with { workspace } returns the child's invite verbatim", async () => {
    const bodies: unknown[] = [];
    const childPort = await listenFakeChild({
      adminToken: "child-admin",
      onBody: (body) => bodies.push(body),
    });
    const { state, shellToken } = makeState(fakeRuntime(childPort, { adminToken: "child-admin" }));
    const hubPort = await listen((req, res) => void handleRpc(state, req, res));

    const { status, body } = await rpc(hubPort, shellToken, "auth.createPairingInvite", [
      { workspace: "dev", ttlMs: 120_000 },
    ]);
    expect(status).toBe(200);
    expect(body["result"]).toEqual(CHILD_INVITE);
    expect(bodies).toEqual([{ ttlMs: 120_000 }]);
  });

  it("auth.createPairingInvite without a workspace stays a hub-level bare code", async () => {
    const { state, shellToken } = makeState(fakeRuntime(9, {}));
    const hubPort = await listen((req, res) => void handleRpc(state, req, res));

    const { status, body } = await rpc(hubPort, shellToken, "auth.createPairingInvite", [{}]);
    expect(status).toBe(200);
    const result = body["result"] as Record<string, unknown>;
    expect(result["deepLink"]).toBeNull();
    expect(result["room"]).toBeNull();
    // The hub-level code redeems against the HUB's own device store.
    expect(state.deviceAuthStore.hasPendingPairingCode(result["code"] as string)).toBe(true);
  });
});
