import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  CallerKind,
  ServiceContext,
  ServiceDispatcher,
} from "@vibestudio/shared/serviceDispatcher";
import { TokenManager } from "@vibestudio/shared/tokenManager";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import {
  createConnectDeepLink,
  PAIRING_PROTOCOL_VERSION,
} from "@vibestudio/shared/connect";
import { CentralDataManager } from "@vibestudio/shared/centralData";
import { IdentityDb } from "@vibestudio/identity/identityDb";
import { UserStore } from "@vibestudio/identity/userStore";
import { RpcServer } from "../src/server/rpcServer.js";
import { DeviceAuthStore } from "../src/server/hostCore/deviceAuthStore.js";
import type { PairedDeviceCredential } from "../src/server/hostCore/deviceAuthStore.js";
import {
  createHubCredentialRedeemer,
  createWorkspaceCredentialRedeemer,
} from "../src/server/services/authService.js";
import { startWebRtcIngress, type WebRtcIngress } from "../src/server/webrtcIngress.js";
import { ensurePersistentCert } from "../src/node/webrtc/cert.js";

const execFileAsync = promisify(execFile);
const RUN_WEBRTC_E2E = process.env["VIBESTUDIO_RUN_WEBRTC_E2E"] === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_SIGNAL_PORT = 8799;
const CLI_SIGNAL_URL = `ws://127.0.0.1:${CLI_SIGNAL_PORT}`;

async function startCliSmokeSignaling(): Promise<ChildProcess> {
  const wrangler = spawn(
    path.join(repoRoot, "node_modules/.bin/wrangler"),
    ["dev", "--port", String(CLI_SIGNAL_PORT), "--local", "--var", "ENVIRONMENT:test"],
    { cwd: path.join(repoRoot, "apps/signaling"), stdio: "ignore" }
  );
  for (let i = 0; i < 90; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${CLI_SIGNAL_PORT}/healthz`);
      if (response.ok) return wrangler;
    } catch {
      // Wait for Miniflare to bind the port.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  wrangler.kill("SIGTERM");
  throw new Error("wrangler dev (CLI smoke signaling) did not become healthy");
}

function makeCliSmokeServers(
  databasePath: string,
  workspaceReach: {
    room: string;
    fp: string;
    sig: string;
    v: typeof PAIRING_PROTOCOL_VERSION;
    ice: "all" | "relay";
  },
  onRedeemed: (credential: PairedDeviceCredential) => Promise<void>
): {
  hubServer: RpcServer;
  workspaceServer: RpcServer;
  deviceAuthStore: DeviceAuthStore;
  identityDb: IdentityDb;
  userStore: UserStore;
  workspaceId: string;
} {
  const central = new CentralDataManager({ databasePath });
  const workspaceId = central.addWorkspace("dev").workspaceId;
  central.close();
  const identityDb = new IdentityDb({ path: databasePath, readOnly: false });
  const userStore = new UserStore(identityDb);
  userStore.createRoot({ handle: "root", displayName: "Root" });
  const deviceAuthStore = new DeviceAuthStore({
    db: identityDb,
    serverIdPath: path.join(path.dirname(databasePath), "server-id.json"),
  });
  const serverId = deviceAuthStore.getServerId();
  const serverBootId = `boot_${"b".repeat(24)}`;
  const hubDispatcher = {
    initialized: true,
    dispatch: async (_ctx: ServiceContext, service: string, method: string) => {
      if (service === "hubControl" && method === "routeWorkspace") {
        return {
          workspace: "dev",
          workspaceId,
          running: true,
          serverUrl: `webrtc://${workspaceReach.room}/_workspace/dev`,
          workspaceReach,
          serverId,
          serverBootId,
        };
      }
      return { ok: true };
    },
    getPolicy: (service: string) =>
      service === "hubControl" ? { allowed: ["shell"] as CallerKind[] } : undefined,
    getMethodPolicy: () => undefined,
  } as unknown as ServiceDispatcher;
  const workspaceDispatcher = {
    initialized: true,
    dispatch: async (_ctx: ServiceContext, service: string, method: string) => {
      if (service === "workspace" && method === "getActive") return "dev";
      if (service === "auth" && method === "getConnectionInfo") {
        return { serverId, workspaceId };
      }
      return { ok: true };
    },
    getPolicy: (service: string) =>
      ["auth", "workspace"].includes(service)
        ? { allowed: ["shell", "server"] as CallerKind[] }
        : undefined,
    getMethodPolicy: () => undefined,
  } as unknown as ServiceDispatcher;
  const hubTokenManager = new TokenManager();
  const workspaceTokenManager = new TokenManager();
  return {
    hubServer: new RpcServer({
      tokenManager: hubTokenManager,
      dispatcher: hubDispatcher,
      entityCache: new EntityCache(),
      redeemPairingCredential: createHubCredentialRedeemer({
        deviceAuthStore,
        tokenManager: hubTokenManager,
        redeemPairingCode: async (code, input) => {
          const credential = deviceAuthStore.completePairing({
            code,
            ...input,
          });
          await onRedeemed(credential);
          return credential;
        },
        resolveUser: (userId) => userStore.getUser(userId),
      }),
    }),
    workspaceServer: new RpcServer({
      tokenManager: workspaceTokenManager,
      dispatcher: workspaceDispatcher,
      entityCache: new EntityCache(),
      redeemPairingCredential: createWorkspaceCredentialRedeemer({
        deviceAuthStore,
        tokenManager: workspaceTokenManager,
        resolveUser: (userId) => userStore.getUser(userId),
        resolveRuntimeEntity: () => null,
      }),
    }),
    deviceAuthStore,
    identityDb,
    userStore,
    workspaceId,
  };
}

function parseCliJson(stdout: string): Record<string, unknown> {
  const line = stdout
    .trim()
    .split(/\r?\n/)
    .findLast((entry) => entry.trim().startsWith("{"));
  if (!line) throw new Error(`CLI did not emit JSON. stdout:\n${stdout}`);
  return JSON.parse(line) as Record<string, unknown>;
}

describe("live CLI smoke", () => {
  it("routes remote serve help to the live TypeScript server entry", async () => {
    const { stdout } = await execFileAsync("pnpm", ["cli", "remote", "serve", "--help"], {
      timeout: 10_000,
    });

    expect(stdout).toContain("vibestudio remote serve");
    expect(stdout).toContain("src/server/index.ts");
  });

  it.runIf(RUN_WEBRTC_E2E)(
    "pairs and checks status through the real CLI WebRTC path",
    async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-cli-live-"));
      let wrangler: ChildProcess | null = null;
      let hubIngress: WebRtcIngress | null = null;
      let workspaceIngress: WebRtcIngress | null = null;
      let identityDb: IdentityDb | null = null;
      try {
        wrangler = await startCliSmokeSignaling();
        const cert = ensurePersistentCert({
          identityPemFile: path.join(tmp, "identity.pem"),
        });
        const workspaceRoom = randomUUID();
        const workspaceReach = {
          room: workspaceRoom,
          fp: cert.fingerprint,
          sig: CLI_SIGNAL_URL,
          v: PAIRING_PROTOCOL_VERSION,
          ice: "all" as const,
        };
        const smoke = makeCliSmokeServers(
          path.join(tmp, "identity.db"),
          workspaceReach,
          async (credential) => {
            if (!hubIngress || !workspaceIngress) {
              throw new Error("CLI smoke ingresses are not ready");
            }
            await Promise.all([
              hubIngress.armRoom(credential.controlRoom, { deviceId: credential.deviceId }),
              workspaceIngress.armRoom(workspaceRoom, { deviceId: credential.deviceId }),
            ]);
          }
        );
        const { hubServer, workspaceServer, deviceAuthStore, userStore, workspaceId } = smoke;
        identityDb = smoke.identityDb;
        hubIngress = startWebRtcIngress({
          rpcServer: hubServer,
          signalUrl: CLI_SIGNAL_URL,
          certificatePemFile: cert.certificatePemFile,
          keyPemFile: cert.keyPemFile,
        });
        workspaceIngress = startWebRtcIngress({
          rpcServer: workspaceServer,
          signalUrl: CLI_SIGNAL_URL,
          certificatePemFile: cert.certificatePemFile,
          keyPemFile: cert.keyPemFile,
        });
        const root = userStore.getByHandle("root");
        if (!root) throw new Error("CLI smoke root user is missing");
        const invite = deviceAuthStore.createPairingInvite(undefined, {
          workspaceId,
          userId: root.id,
        });
        await hubIngress.armRoom(invite.room, {});
        const deepLink = createConnectDeepLink({
          room: invite.room,
          fp: cert.fingerprint,
          code: invite.code,
          sig: CLI_SIGNAL_URL,
          v: PAIRING_PROTOCOL_VERSION,
          ice: "all",
        });

        const childEnv = {
          ...process.env,
          HOME: path.join(tmp, "home"),
          VIBESTUDIO_LOG_LEVEL: "error",
        };
        const pair = await execFileAsync(
          "pnpm",
          ["cli", "remote", "pair", deepLink, "--label", "CLI live smoke", "--json"],
          { cwd: repoRoot, env: childEnv, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 }
        );
        const pairJson = parseCliJson(pair.stdout);
        expect(pairJson["url"]).toBe(`webrtc://${workspaceRoom}/_workspace/dev`);

        const credentialPath = path.join(
          childEnv.HOME,
          ".config",
          "vibestudio",
          "cli-credentials.json"
        );
        const stored = JSON.parse(fs.readFileSync(credentialPath, "utf8")) as {
          workspaceName?: string;
          controlPairing?: { room?: string };
          workspacePairing?: { room?: string };
        };
        expect(stored.workspaceName).toBe("dev");
        expect(stored.controlPairing?.room).toBe(invite.room);
        expect(stored.workspacePairing?.room).toBe(workspaceRoom);

        const status = await execFileAsync("pnpm", ["cli", "remote", "status", "--json"], {
          cwd: repoRoot,
          env: childEnv,
          timeout: 60_000,
          maxBuffer: 2 * 1024 * 1024,
        });
        expect(parseCliJson(status.stdout)).toMatchObject({
          url: `webrtc://${workspaceRoom}/_workspace/dev`,
          workspaceId,
          serverId: deviceAuthStore.getServerId(),
        });
      } finally {
        await Promise.allSettled([hubIngress?.close(), workspaceIngress?.close()]);
        identityDb?.close();
        wrangler?.kill("SIGTERM");
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
    120_000
  );
});
