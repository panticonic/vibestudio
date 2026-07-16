/**
 * COMPLETE WebRTC system end-to-end — the v2 multi-client stack, locally, with
 * Cloudflare's local runtime for signaling:
 *
 *   `wrangler dev apps/signaling`  (real SignalingRoom Durable Object, Miniflare)
 *        ▲                                            ▲
 *   createPairedConnection (offerer)       startWebRtcIngress (answerer pool)
 *        │            real node-datachannel DTLS            │
 *        ⇄═══════ DTLS + fingerprint pin (per invite) ══════⇄
 *        │                                                  │
 *   main shell session (real handleAuth)      RpcServer.attachWebRtcPipe
 *        │                                                  │
 *        └──────────────── real RPC round-trip ─────────────┘
 *
 * This boots the server EXACTLY the way `src/server/index.ts` does now: the
 * WebRTC ingress POOL (`startWebRtcIngress`) supervises one answerer pipe per
 * signaling room, rooms are minted PER INVITE (`mintPairingInvite` — plan §2.1),
 * redemption re-tags the invite's room onto the device record
 * (`onPairingRoomRedeemed` → `armRoom`), and clients connect through the ONE
 * shared bootstrap (`createPairedConnection`), parsing the invite's real
 * `vibestudio://connect` (v=2) deep link.
 *
 * Scenarios: invite → pairing → RPC dispatch; consumed-code rejection;
 * pairing → refresh-credential reconnect; TWO concurrent clients on two invite
 * rooms with independent sessions (plan §9.5); same-device reconnect on the
 * SAME room → deterministic takeover.
 *
 * Gated behind VIBESTUDIO_RUN_WEBRTC_E2E=1 (spawns wrangler dev + opens real UDP):
 *   VIBESTUDIO_RUN_WEBRTC_E2E=1 npx vitest run tests/webrtc-system.e2e.test.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CallerKind, ServiceContext, ServiceDispatcher } from "@vibestudio/shared/serviceDispatcher";
import { TokenManager } from "@vibestudio/shared/tokenManager";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import {
  createConnectDeepLink,
  PAIRING_PROTOCOL_VERSION,
  parseConnectLink,
} from "@vibestudio/shared/connect";
import { CentralDataManager } from "@vibestudio/shared/centralData";
import { IdentityDb } from "@vibestudio/identity/identityDb";
import { UserStore } from "@vibestudio/identity/userStore";
import { createRpcClient } from "@vibestudio/rpc";
import {
  createPairedConnection,
  type DeviceCredential,
  type PairedConnection,
} from "@vibestudio/rpc/transports/pairedConnection";
import type { PairedDeviceCredential } from "../src/server/hostCore/deviceAuthStore.js";
import { RpcServer } from "../src/server/rpcServer.js";
import { DeviceAuthStore } from "../src/server/hostCore/deviceAuthStore.js";
import { createHubCredentialRedeemer } from "../src/server/services/authService.js";
import { startWebRtcIngress, type WebRtcIngress } from "../src/server/webrtcIngress.js";
import { createNodeDatachannelProvider } from "../src/node/webrtc/nodeDatachannelPeer.js";
import { ensurePersistentCert } from "../src/node/webrtc/cert.js";

const RUN = process.env["VIBESTUDIO_RUN_WEBRTC_E2E"] === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIGNAL_PORT = 8798;
const SIG = `ws://127.0.0.1:${SIGNAL_PORT}`;

let wrangler: ChildProcess | null = null;

interface MintedPairingInvite {
  room: string;
  code: string;
  deepLink: string;
}

async function startSignaling(): Promise<void> {
  wrangler = spawn(
    path.join(repoRoot, "node_modules/.bin/wrangler"),
    ["dev", "--port", String(SIGNAL_PORT), "--local", "--var", "ENVIRONMENT:test"],
    { cwd: path.join(repoRoot, "apps/signaling"), stdio: "ignore" },
  );
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${SIGNAL_PORT}/healthz`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("wrangler dev (signaling) did not become healthy");
}

/** Minimal real RpcServer whose dispatcher echoes the call (proves the dispatch path). */
function makeServer(
  databasePath: string,
  onRedeemed: (credential: PairedDeviceCredential) => Promise<void>
): {
  server: RpcServer;
  tokenManager: TokenManager;
  deviceAuthStore: DeviceAuthStore;
  identityDb: IdentityDb;
  userStore: UserStore;
  workspaceId: string;
  dispatched: Array<{ service: string; method: string; args: unknown[] }>;
} {
  const central = new CentralDataManager({ databasePath });
  const workspaceId = central.addWorkspace("test").workspaceId;
  central.close();
  const identityDb = new IdentityDb({ path: databasePath, readOnly: false });
  const userStore = new UserStore(identityDb);
  const root = userStore.createRoot({ handle: "root", displayName: "Root" });
  const tokenManager = new TokenManager();
  const dispatched: Array<{ service: string; method: string; args: unknown[] }> = [];
  const dispatcher = {
    initialized: true,
    dispatch: async (_ctx: ServiceContext, service: string, method: string, args: unknown[]) => {
      dispatched.push({ service, method, args });
      return { ok: true, echo: { service, method, args } };
    },
    getPolicy: (service: string) =>
      service === "demo" ? { allowed: ["shell", "panel", "worker", "server"] as CallerKind[] } : undefined,
    getMethodPolicy: () => undefined,
  } as unknown as ServiceDispatcher;
  // Real device-auth store + the over-the-pipe pairing redeemer, so a fresh
  // device can present an invite code (and a returning one a refresh credential).
  const deviceAuthStore = new DeviceAuthStore({
    db: identityDb,
    serverIdPath: path.join(path.dirname(databasePath), "server-id.json"),
  });
  const server = new RpcServer({
    tokenManager,
    dispatcher,
    entityCache: new EntityCache(),
    redeemPairingCredential: createHubCredentialRedeemer({
      deviceAuthStore,
      tokenManager,
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
  });
  // Keep the root binding explicit: every test invite represents the normal
  // pair-another-device flow, not the one-time root-bootstrap flow.
  expect(root.role).toBe("root");
  return {
    server,
    tokenManager,
    deviceAuthStore,
    identityDb,
    userStore,
    workspaceId,
    dispatched,
  };
}

let clientSeq = 0;

/**
 * Dial the invite's deep link the way every real platform does now: parse the
 * v=2 `vibestudio://connect` link, then `createPairedConnection` (the ONE shared
 * bootstrap — connect + main-session auth + close-on-failure).
 */
async function dial(
  invite: MintedPairingInvite,
  opts?: {
    /** Defaults to the invite code (fresh pairing). */
    getToken?: () => string;
    onPaired?: (credential: DeviceCredential) => void;
  },
): Promise<PairedConnection> {
  const link = parseConnectLink(invite.deepLink!);
  if (link.kind !== "ok") throw new Error(`invite deep link did not parse: ${link.reason}`);
  clientSeq += 1;
  return createPairedConnection({
    pairing: {
      room: link.room,
      fingerprint: link.fp,
      iceTransportPolicy: link.ice,
      iceServers: [],
    },
    sig: link.sig,
    provider: createNodeDatachannelProvider({ peerName: `client-${clientSeq}` }),
    webSocketImpl: WebSocket,
    fetchImpl: fetch,
    getShellToken: opts?.getToken ?? (() => link.code),
    connectionId: randomUUID(),
    callerKind: "shell",
    clientPlatform: "desktop",
    platform: "desktop",
    connectTimeoutMs: 30_000,
    ...(opts?.onPaired ? { onPaired: opts.onPaired } : {}),
  });
}

/** RPC round-trip over a paired connection's main session (real dispatch path). */
async function rpcEcho(conn: PairedConnection, marker: string): Promise<void> {
  const callerId = conn.mainSession.callerId();
  if (!callerId) throw new Error("paired connection has no authenticated caller id");
  const rpc = createRpcClient({
    selfId: callerId,
    callerKind: "shell",
    transport: conn.mainSession,
  });
  const result = (await rpc.call("main", "demo.echo", [marker])) as {
    ok: boolean;
    echo: { service: string; method: string; args: unknown[] };
  };
  expect(result.ok).toBe(true);
  expect(result.echo).toEqual({ service: "demo", method: "echo", args: [marker] });
}

describe.runIf(RUN)("WebRTC complete system e2e (wrangler-dev signaling + ingress pool + createPairedConnection)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-rtc-sys-"));
  const cert = ensurePersistentCert({
    identityPemFile: path.join(tmp, "identity.pem"),
  });
  let deviceAuthStore: DeviceAuthStore;
  let identityDb: IdentityDb;
  let userStore: UserStore;
  let workspaceId: string;
  let dispatched: Array<{ service: string; method: string; args: unknown[] }> = [];
  let ingress: WebRtcIngress;
  const openConnections = new Set<PairedConnection>();

  const mintInvite = async (): Promise<MintedPairingInvite> => {
    const root = userStore.getByHandle("root");
    if (!root) throw new Error("test root user is missing");
    const invite = deviceAuthStore.createPairingInvite(undefined, {
      workspaceId,
      userId: root.id,
    });
    await ingress.armRoom(invite.room, {});
    const deepLink = createConnectDeepLink({
      room: invite.room,
      fp: cert.fingerprint,
      code: invite.code,
      sig: SIG,
      v: PAIRING_PROTOCOL_VERSION,
      ice: "all",
    });
    expect(deepLink).toContain("v=2");
    return { room: invite.room, code: invite.code, deepLink };
  };

  const track = (conn: PairedConnection): PairedConnection => {
    openConnections.add(conn);
    return conn;
  };

  const pairFresh = async (): Promise<{
    invite: MintedPairingInvite;
    credential: DeviceCredential;
    connection: PairedConnection;
  }> => {
    const invite = await mintInvite();
    let credential: DeviceCredential | null = null;
    const connection = track(
      await dial(invite, {
        onPaired: (issued) => {
          credential = issued;
        },
      })
    );
    if (!credential) {
      await connection.close();
      openConnections.delete(connection);
      throw new Error("fresh pairing completed without returning its device credential");
    }
    return { invite, credential, connection };
  };

  beforeAll(async () => {
    await startSignaling();
    const s = makeServer(path.join(tmp, "identity.db"), async (credential) => {
      await ingress.armRoom(credential.controlRoom, { deviceId: credential.deviceId });
    });
    dispatched = s.dispatched;
    deviceAuthStore = s.deviceAuthStore;
    identityDb = s.identityDb;
    userStore = s.userStore;
    workspaceId = s.workspaceId;
    // The EXACT wiring src/server/index.ts runs: the pool over the live
    // RpcServer, invite redemption re-tagging rooms, releases disarming them.
    ingress = startWebRtcIngress({
      rpcServer: s.server,
      signalUrl: SIG,
      certificatePemFile: cert.certificatePemFile,
      keyPemFile: cert.keyPemFile,
    });
  }, 120_000);

  afterAll(async () => {
    for (const conn of openConnections) await conn.close().catch(() => {});
    await ingress?.close().catch(() => {});
    identityDb?.close();
    wrangler?.kill("SIGTERM");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("pairs a fresh device via a minted invite (per-invite room) and round-trips a real RPC dispatch", async () => {
    const { invite, credential, connection } = await pairFresh();

    // The server redeemed the code → issued a device credential (delivered back
    // on the auth-result) and bound the session to the device's shell principal.
    expect(credential.deviceId).toMatch(/^dev_/);
    expect(credential.refreshToken.length).toBeGreaterThan(16);
    expect(connection.mainSession.callerId()).toBe(`shell:${credential.deviceId}`);

    await rpcEcho(connection, "hello-A");
    expect(dispatched.some((d) => d.service === "demo" && d.method === "echo")).toBe(true);

    // Redemption persisted the invite's room onto the device record (§2.1) and
    // the pool's status surfaces the connected pipe with its selected path.
    const device = deviceAuthStore.listDevices().find((d) => d.deviceId === credential.deviceId);
    expect(device?.userId).toBe(userStore.getByHandle("root")?.id);
    const room = ingress.status().find((r) => r.room === invite.room);
    expect(room).toMatchObject({ status: "connected", deviceId: credential.deviceId });
    expect(["host", "srflx", "prflx"]).toContain(room!.candidateType); // loopback: never TURN

    await connection.close();
    openConnections.delete(connection);
  }, 60_000);

  it("rejects a consumed one-shot invite without issuing another device", async () => {
    const { invite, connection } = await pairFresh();
    const devicesBeforeRetry = deviceAuthStore.listDevices();
    const replay = connection.openSession({
      connectionId: "replay-1",
      callerKind: "shell",
      getToken: () => invite.code,
    });
    await expect(replay.ready!()).rejects.toThrow();
    expect(deviceAuthStore.listDevices()).toEqual(devicesBeforeRetry);
    replay.close();
    await connection.close();
    openConnections.delete(connection);
  }, 30_000);

  it("reconnects the paired device with its refresh credential (pairing → refresh lifecycle)", async () => {
    const { invite, credential, connection } = await pairFresh();
    await connection.close();
    openConnections.delete(connection);

    // The returning device authenticates with `refresh:<deviceId>:<refreshToken>`
    // on its persisted room — no re-pairing, no new credential issued.
    let secondCredential: DeviceCredential | null = null;
    const reconnected = track(
      await dial(invite, {
        getToken: () => `refresh:${credential.deviceId}:${credential.refreshToken}`,
        onPaired: (credential) => {
          secondCredential = credential;
        },
      }),
    );
    expect(reconnected.mainSession.callerId()).toBe(`shell:${credential.deviceId}`);
    expect(secondCredential).toBeNull();
    await rpcEcho(reconnected, "back-again");
    await reconnected.close();
    openConnections.delete(reconnected);
  }, 60_000);

  it("runs TWO clients concurrently on two invite rooms with independent sessions (§9.5)", async () => {
    const { connection: existing } = await pairFresh();
    const [inviteB, inviteC] = await Promise.all([mintInvite(), mintInvite()]);
    expect(inviteB.room).not.toBe(inviteC.room);

    const credentials: Record<string, DeviceCredential | null> = { b: null, c: null };
    const [connB, connC] = await Promise.all([
      dial(inviteB, { onPaired: (credential) => (credentials["b"] = credential) }).then(track),
      dial(inviteC, { onPaired: (credential) => (credentials["c"] = credential) }).then(track),
    ]);

    // Independent principals on independent pipes.
    expect(credentials["b"]!.deviceId).not.toBe(credentials["c"]!.deviceId);
    expect(connB.mainSession.callerId()).toBe(`shell:${credentials["b"]!.deviceId}`);
    expect(connC.mainSession.callerId()).toBe(`shell:${credentials["c"]!.deviceId}`);
    await Promise.all([rpcEcho(connB, "from-B"), rpcEcho(connC, "from-C")]);

    // Neither client evicted the other — and the existing device (its own room)
    // is untouched.
    expect(connB.transport.status()).toBe("connected");
    expect(connC.transport.status()).toBe("connected");
    expect(existing.transport.status()).toBe("connected");
    await rpcEcho(existing, "A-still-alive");

    const byRoom = new Map(ingress.status().map((r) => [r.room, r]));
    expect(byRoom.get(inviteB.room!)?.status).toBe("connected");
    expect(byRoom.get(inviteC.room!)?.status).toBe("connected");

    await connB.close();
    await connC.close();
    await existing.close();
    openConnections.delete(connB);
    openConnections.delete(connC);
    openConnections.delete(existing);
  }, 90_000);

  it("same-device reconnect on the SAME room performs a deterministic takeover", async () => {
    const { invite, credential, connection } = await pairFresh();
    expect(connection.transport.status()).toBe("connected");

    // A second connect for the SAME device on the SAME room (app relaunch /
    // ghost self-replacement): the new offer re-pairs the answerer's pipe and
    // the signaling DO evicts the old same-role socket.
    const takeover = track(
      await dial(invite, {
        getToken: () => `refresh:${credential.deviceId}:${credential.refreshToken}`,
      }),
    );
    expect(takeover.mainSession.callerId()).toBe(`shell:${credential.deviceId}`);
    await rpcEcho(takeover, "takeover");

    // The OLD connection lost the pipe (deterministically — the takeover owns
    // the room now). Close it before its recovery loop can fight back.
    await waitFor(() => connection.transport.status() !== "connected", 20_000);
    await connection.close();
    openConnections.delete(connection);

    // With the loser gone, the takeover (re)settles as THE connection.
    await waitFor(() => takeover.transport.status() === "connected", 20_000);
    await rpcEcho(takeover, "takeover-still-owns-the-room");
    await takeover.close();
    openConnections.delete(takeover);
  }, 90_000);
});

async function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
