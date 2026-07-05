import { execFile } from "node:child_process";
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
import { RpcServer } from "../src/server/rpcServer.js";
import { DeviceAuthStore } from "../src/server/services/deviceAuthStore.js";
import { createPairingRedeemer } from "../src/server/services/authService.js";
import { mintPairingInvite } from "../src/server/services/auth/model.js";
import { startWebRtcIngress, type WebRtcIngress } from "../src/server/webrtcIngress.js";
import { ensurePersistentCert } from "../src/main/webrtc/cert.js";

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

function makeCliSmokeServer(authStorePath: string): {
  server: RpcServer;
  deviceAuthStore: DeviceAuthStore;
} {
  const tokenManager = new TokenManager();
  const dispatcher = {
    initialized: true,
    dispatch: async (_ctx: ServiceContext, service: string, method: string) => {
      if (service === "workspace" && method === "getActive") return "dev";
      if (service === "auth" && method === "getConnectionInfo") {
        return { serverId: "srv_cli_live", workspaceId: "ws_dev" };
      }
      return { ok: true };
    },
    getPolicy: (service: string) =>
      ["auth", "workspace"].includes(service)
        ? { allowed: ["shell", "server"] as CallerKind[] }
        : undefined,
    getMethodPolicy: () => undefined,
  } as unknown as ServiceDispatcher;
  const deviceAuthStore = new DeviceAuthStore(authStorePath);
  return {
    server: new RpcServer({
      tokenManager,
      dispatcher,
      entityCache: new EntityCache(),
      redeemPairingCredential: createPairingRedeemer({ deviceAuthStore, tokenManager }),
    }),
    deviceAuthStore,
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
      let ingress: WebRtcIngress | null = null;
      try {
        wrangler = await startCliSmokeSignaling();
        const cert = ensurePersistentCert({
          certificatePemFile: path.join(tmp, "server.pem"),
          keyPemFile: path.join(tmp, "server.key"),
        });
        const { server, deviceAuthStore } = makeCliSmokeServer(
          path.join(tmp, "auth", "devices.json")
        );
        ingress = startWebRtcIngress({
          rpcServer: server,
          signalUrl: CLI_SIGNAL_URL,
          certificatePemFile: cert.certificatePemFile,
          keyPemFile: cert.keyPemFile,
          fingerprint: cert.fingerprint,
        });
        deviceAuthStore.onPairingRoomRedeemed((room, deviceId) =>
          ingress!.armRoom(room, { deviceId })
        );
        deviceAuthStore.onPairingRoomReleased((room) => void ingress!.disarmRoom(room));
        const invite = mintPairingInvite({
          deviceAuthStore,
          pairing: { fp: cert.fingerprint, sig: CLI_SIGNAL_URL },
          ingress,
        });
        expect(invite.deepLink).toBeTypeOf("string");

        const childEnv = {
          ...process.env,
          HOME: path.join(tmp, "home"),
          VIBESTUDIO_LOG_LEVEL: "error",
        };
        const pair = await execFileAsync(
          "pnpm",
          ["cli", "remote", "pair", invite.deepLink!, "--label", "CLI live smoke", "--json"],
          { cwd: repoRoot, env: childEnv, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 }
        );
        const pairJson = parseCliJson(pair.stdout);
        expect(pairJson["url"]).toBe(`webrtc://${invite.room}/_workspace/dev`);

        const credentialPath = path.join(
          childEnv.HOME,
          ".config",
          "vibestudio",
          "cli-credentials.json"
        );
        const stored = JSON.parse(fs.readFileSync(credentialPath, "utf8")) as {
          workspaceName?: string;
          pairing?: { room?: string };
        };
        expect(stored.workspaceName).toBe("dev");
        expect(stored.pairing?.room).toBe(invite.room);

        const status = await execFileAsync("pnpm", ["cli", "remote", "status", "--json"], {
          cwd: repoRoot,
          env: childEnv,
          timeout: 60_000,
          maxBuffer: 2 * 1024 * 1024,
        });
        expect(parseCliJson(status.stdout)).toMatchObject({
          url: `webrtc://${invite.room}/_workspace/dev`,
          workspaceId: "ws_dev",
          serverId: "srv_cli_live",
        });
      } finally {
        await ingress?.close().catch(() => undefined);
        wrangler?.kill("SIGTERM");
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
    120_000
  );
});
