/**
 * Real-native WebRTC end-to-end test — v2 stack. Wires TWO actual
 * `node-datachannel` peers (via createNodeDatachannelProvider) through an
 * in-process signaling relay, and runs the full v2 transport + protocol stack
 * over REAL DTLS:
 *
 *   createWebRtcTransport (offerer)  ⇄  createWebRtcAnswererPipe (answerer)
 *                                        + RpcServer.attachWebRtcPipe
 *
 * It proves, against the live native module: ICE/DTLS connect, the fingerprint
 * pin (accept on match, FAIL CLOSED on mismatch), the hello preamble (proto=2,
 * negotiated internally by both ends), the session handshake, an RPC
 * round-trip, a bulk stream decoded by the client (writeBulkFrame → stream
 * body), a pipe-level bulk round-trip (sendBulkFrame → onBulkFrame), and the
 * §9.8 candidateType surface on both ends. This is the bedrock the wrangler-dev
 * harness builds on (it only swaps the in-process signaling for the real
 * signaling DO).
 *
 * Gated behind VIBESTUDIO_RUN_WEBRTC_E2E=1 (opens real UDP sockets + loads the
 * native binary), like the other integration tests.
 *
 *   VIBESTUDIO_RUN_WEBRTC_E2E=1 npx vitest run tests/webrtc-native.e2e.test.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { RpcEnvelope } from "@vibestudio/rpc";
import {
  createWebRtcTransport,
  FINGERPRINT_MISMATCH_CODE,
} from "@vibestudio/rpc/transports/webrtcClient";
import { createWebRtcAnswererPipe } from "@vibestudio/rpc/transports/webrtcAnswerer";
import type {
  RtcCandidateType,
  RtcIceCandidate,
  RtcIceServer,
  RtcSessionDescription,
} from "@vibestudio/rpc/transports/webrtcPeer";
import type { SignalingClient } from "@vibestudio/rpc/transports/webrtcSignaling";
import { FRAME_DATA, FRAME_END } from "@vibestudio/rpc/protocol/streamCodec";
import type {
  CallerKind,
  ServiceContext,
  ServiceDispatcher,
} from "@vibestudio/shared/serviceDispatcher";
import { TokenManager } from "@vibestudio/shared/tokenManager";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import { RpcServer } from "../src/server/rpcServer.js";
import { createNodeDatachannelProvider } from "../src/main/webrtc/nodeDatachannelPeer.js";
import { ensurePersistentCert } from "../src/main/webrtc/cert.js";

const RUN = process.env["VIBESTUDIO_RUN_WEBRTC_E2E"] === "1";
const TURN_ICE_SERVERS = turnIceServersFromEnv();

/** Candidate types a loopback pair may legitimately select (never TURN). */
const LOOPBACK_CANDIDATE_TYPES: Array<RtcCandidateType | null> = ["host", "srflx", "prflx", null];

/** In-process signaling relay: each peer's send reaches the other's handlers. */
function signalingPair(): { offerer: SignalingClient; answerer: SignalingClient } {
  const onDesc = {
    a: new Set<(d: RtcSessionDescription) => void>(),
    b: new Set<(d: RtcSessionDescription) => void>(),
  };
  const onCand = {
    a: new Set<(c: RtcIceCandidate) => void>(),
    b: new Set<(c: RtcIceCandidate) => void>(),
  };
  // Buffer pre-subscription frames (mirrors the real DO's join-order buffer).
  const buf = { a: [] as Array<["d" | "c", unknown]>, b: [] as Array<["d" | "c", unknown]> };
  const flush = (side: "a" | "b"): void => {
    for (const [t, x] of buf[side].splice(0)) {
      if (t === "d") for (const h of onDesc[side]) h(x as RtcSessionDescription);
      else for (const h of onCand[side]) h(x as RtcIceCandidate);
    }
  };
  const make = (self: "a" | "b", peer: "a" | "b"): SignalingClient => ({
    async sendDescription(d) {
      queueMicrotask(() => {
        if (onDesc[peer].size === 0) buf[peer].push(["d", d]);
        else for (const h of onDesc[peer]) h(d);
      });
    },
    async sendCandidate(c) {
      queueMicrotask(() => {
        if (onDesc[peer].size === 0) buf[peer].push(["c", c]);
        else for (const h of onCand[peer]) h(c);
      });
    },
    onDescription(h) {
      onDesc[self].add(h);
      queueMicrotask(() => flush(self));
      return () => onDesc[self].delete(h);
    },
    onCandidate(h) {
      onCand[self].add(h);
      return () => onCand[self].delete(h);
    },
    onClosed() {
      return () => {};
    },
    close() {},
  });
  return { offerer: make("a", "b"), answerer: make("b", "a") };
}

interface Harness {
  client: ReturnType<typeof createWebRtcTransport>;
  pipe: ReturnType<typeof createWebRtcAnswererPipe>;
  shellToken: string;
  dispatched: Array<{ service: string; method: string; args: unknown[] }>;
  /** §9.8 feed: everything the ANSWERER emitted via onCandidateType. */
  pipeCandidateTypes: Array<RtcCandidateType | null>;
  close: () => Promise<void>;
}

function makeServer(): {
  server: RpcServer;
  shellToken: string;
  dispatched: Array<{ service: string; method: string; args: unknown[] }>;
} {
  const tokenManager = new TokenManager();
  const dispatched: Array<{ service: string; method: string; args: unknown[] }> = [];
  const dispatcher = {
    initialized: true,
    dispatch: async (_ctx: ServiceContext, service: string, method: string, args: unknown[]) => {
      dispatched.push({ service, method, args });
      if (service === "demo" && method === "stream") {
        return new Response("real-dtls-bytes", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      return { pong: true, method: `${service}.${method}`, args };
    },
    getPolicy: (service: string) =>
      service === "demo"
        ? { allowed: ["shell", "panel", "worker", "server"] as CallerKind[] }
        : undefined,
    getMethodPolicy: () => undefined,
  } as unknown as ServiceDispatcher;

  return {
    server: new RpcServer({
      tokenManager,
      dispatcher,
      entityCache: new EntityCache(),
    }),
    shellToken: tokenManager.ensureToken("shell:e2e", "shell"),
    dispatched,
  };
}

function turnIceServersFromEnv(): RtcIceServer[] {
  const urls = (process.env["VIBESTUDIO_TEST_TURN_URLS"] ?? process.env["VIBESTUDIO_TEST_TURN_URL"] ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  if (urls.length === 0) return [];
  const username = process.env["VIBESTUDIO_TEST_TURN_USERNAME"];
  const credential = process.env["VIBESTUDIO_TEST_TURN_CREDENTIAL"];
  return [
    {
      urls: urls.length === 1 ? urls[0]! : urls,
      ...(username ? { username } : {}),
      ...(credential ? { credential } : {}),
    },
  ];
}

/** Build one v2 pipe pair. `attachServer: false` leaves the answerer's control/
 * bulk handlers free for raw pipe-level assertions. */
async function connect(opts: {
  pinnedFp: string;
  certFile: string;
  keyFile: string;
  attachServer?: boolean;
  iceServers?: RtcIceServer[];
  iceTransportPolicy?: "all" | "relay";
}): Promise<Harness> {
  const sig = signalingPair();
  const serverProvider = createNodeDatachannelProvider({ peerName: "server" });
  const clientProvider = createNodeDatachannelProvider({ peerName: "client" });
  const { server, shellToken, dispatched } = makeServer();

  const pipe = createWebRtcAnswererPipe({
    provider: serverProvider,
    // v2: the pipe owns a supervised signaling rejoin loop and calls this
    // factory on connect() and after every drop. The in-process client never
    // drops, so it is handed out once.
    createSignaling: () => sig.answerer,
    pairing: {
      iceServers: opts.iceServers ?? [],
      iceTransportPolicy: opts.iceTransportPolicy,
      certificatePemFile: opts.certFile,
      keyPemFile: opts.keyFile,
    },
  });

  const pipeCandidateTypes: Array<RtcCandidateType | null> = [];
  pipe.onCandidateType((type) => pipeCandidateTypes.push(type));

  if (opts.attachServer !== false) server.attachWebRtcPipe(pipe);

  const client = createWebRtcTransport({
    provider: clientProvider,
    createSignaling: () => sig.offerer,
    pairing: {
      room: "e2e-room",
      fingerprint: opts.pinnedFp,
      iceServers: opts.iceServers ?? [],
      iceTransportPolicy: opts.iceTransportPolicy,
    },
    role: "offerer",
  });

  // Arm the answerer first so it is subscribed before the offer arrives (the
  // in-process buffer also covers any residual race). connect() resolves after
  // the hello exchange completes on both ends (proto=2, negotiated internally).
  const answering = pipe.connect();
  await new Promise((r) => setTimeout(r, 50));
  const connecting = client.connect();
  try {
    await Promise.all([answering, connecting]);
  } catch (error) {
    await client.close().catch(() => {});
    await pipe.close().catch(() => {});
    await answering.catch(() => {});
    throw error;
  }

  return {
    client,
    pipe,
    shellToken,
    dispatched,
    pipeCandidateTypes,
    close: async () => {
      await client.close();
      await pipe.close();
    },
  };
}

describe.runIf(RUN)("WebRTC real-native end-to-end (node-datachannel, v2)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-rtc-e2e-"));
  const cert = ensurePersistentCert({
    identityPemFile: path.join(tmp, "identity.pem"),
  });
  const harnesses: Harness[] = [];

  afterAll(async () => {
    for (const h of harnesses) await h.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("establishes real DTLS, pins the server fingerprint, and round-trips RPC", async () => {
    const h = await connect({
      pinnedFp: cert.fingerprint,
      certFile: cert.certificatePemFile,
      keyFile: cert.keyPemFile,
    });
    harnesses.push(h);
    expect(h.client.status()).toBe("connected");

    const session = h.client.openSession({
      connectionId: "cli-1",
      callerKind: "shell",
      getToken: () => h.shellToken,
    });
    await session.ready!();
    expect(session.callerId()).toBe("shell:e2e");

    const received: RpcEnvelope[] = [];
    session.onMessage((e) => received.push(e));
    await session.send({
      from: "shell:e2e",
      target: "main",
      delivery: { caller: { callerId: "shell:e2e", callerKind: "shell" } },
      provenance: [{ callerId: "shell:e2e", callerKind: "shell" }],
      message: {
        type: "request",
        requestId: "r1",
        fromId: "shell:e2e",
        method: "demo.healthz",
        args: [],
      },
    });
    await waitFor(() => received.length > 0);
    expect(
      (received[0]!.message as { result: { pong: boolean; method: string; args: unknown[] } })
        .result
    ).toEqual({
      pong: true,
      method: "demo.healthz",
      args: [],
    });
    expect(h.dispatched).toContainEqual({ service: "demo", method: "healthz", args: [] });
  }, 20_000);

  it("surfaces the selected candidate type on BOTH ends (§9.8 relay alarm feed)", () => {
    const h = harnesses[0]!;
    // Loopback selects a P2P path — never TURN.
    expect(LOOPBACK_CANDIDATE_TYPES).toContain(h.client.candidateType());
    expect(LOOPBACK_CANDIDATE_TYPES).toContain(h.pipe.candidateType());
    // The answerer emitted its hello-complete candidate type (the feed the
    // ingress pool's relay alarm and path log ride).
    expect(h.pipeCandidateTypes.length).toBeGreaterThanOrEqual(1);
    expect(LOOPBACK_CANDIDATE_TYPES).toContain(h.pipeCandidateTypes[0]);
  });

  it("streams a bulk body over the real bulk DataChannel (writeBulkFrame → client stream decode)", async () => {
    const h = harnesses[0]!;
    const session = h.client.openSession({
      connectionId: "cli-2",
      callerKind: "shell",
      getToken: () => h.shellToken,
    });
    await session.ready!();
    const resp = await session.stream!({
      from: "shell:e2e",
      target: "main",
      delivery: { caller: { callerId: "shell:e2e", callerKind: "shell" } },
      provenance: [{ callerId: "shell:e2e", callerKind: "shell" }],
      message: {
        type: "stream-request",
        requestId: "s1",
        fromId: "shell:e2e",
        method: "demo.stream",
        args: ["rtc://x"],
      },
    });
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("real-dtls-bytes");
    expect(h.dispatched).toContainEqual({ service: "demo", method: "stream", args: ["rtc://x"] });
  }, 20_000);

  it("round-trips pipe-level bulk frames chunked under the negotiated size (sendBulkFrame → onBulkFrame)", async () => {
    // Raw pipe (no RpcServer attached) so the bulk-frame handler is ours.
    const h = await connect({
      pinnedFp: cert.fingerprint,
      certFile: cert.certificatePemFile,
      keyFile: cert.keyPemFile,
      attachServer: false,
    });
    harnesses.push(h);

    const streamId = 41;
    const payload = new Uint8Array(300 * 1024); // > one negotiated chunk
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) & 0xff;

    const chunks: Uint8Array[] = [];
    let sawEnd = false;
    h.pipe.onBulkFrame((sid, type, bytes) => {
      if (sid !== streamId) return;
      if (type === FRAME_DATA) chunks.push(bytes.slice()); // view — copy to retain
      if (type === FRAME_END) sawEnd = true;
    });

    await h.client.sendBulkFrame(streamId, FRAME_DATA, payload);
    await h.client.sendBulkFrame(streamId, FRAME_END, new TextEncoder().encode("{}"));
    await waitFor(() => sawEnd);

    expect(chunks.length).toBeGreaterThanOrEqual(2); // was chunked on the wire
    const total = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const c of chunks) {
      total.set(c, offset);
      offset += c.length;
    }
    expect(total.length).toBe(payload.length);
    expect(total).toEqual(payload);
  }, 20_000);

  it("FAILS CLOSED when the pinned fingerprint does not match the server cert (negative)", async () => {
    const wrongFp = "00".repeat(32);
    await expect(
      connect({ pinnedFp: wrongFp, certFile: cert.certificatePemFile, keyFile: cert.keyPemFile })
    ).rejects.toMatchObject({ code: FINGERPRINT_MISMATCH_CODE });
  }, 20_000);

  it.skipIf(TURN_ICE_SERVERS.length === 0)(
    "connects and dispatches through a forced TURN relay path",
    async () => {
      const h = await connect({
        pinnedFp: cert.fingerprint,
        certFile: cert.certificatePemFile,
        keyFile: cert.keyPemFile,
        iceServers: TURN_ICE_SERVERS,
        iceTransportPolicy: "relay",
      });
      harnesses.push(h);
      expect(h.client.status()).toBe("connected");
      expect(h.client.candidateType()).toBe("relay");
      expect(h.pipe.candidateType()).toBe("relay");
      expect(h.pipeCandidateTypes).toContain("relay");

      const session = h.client.openSession({
        connectionId: "cli-turn",
        callerKind: "shell",
        getToken: () => h.shellToken,
      });
      await session.ready!();
      expect(session.callerId()).toBe("shell:e2e");

      const received: RpcEnvelope[] = [];
      session.onMessage((e) => received.push(e));
      await session.send({
        from: "shell:e2e",
        target: "main",
        delivery: { caller: { callerId: "shell:e2e", callerKind: "shell" } },
        provenance: [{ callerId: "shell:e2e", callerKind: "shell" }],
        message: {
          type: "request",
          requestId: "turn-r1",
          fromId: "shell:e2e",
          method: "demo.healthz",
          args: ["turn"],
        },
      });
      await waitFor(() => received.length > 0);
      expect(
        (received[0]!.message as { result: { pong: boolean; method: string; args: unknown[] } })
          .result
      ).toEqual({
        pong: true,
        method: "demo.healthz",
        args: ["turn"],
      });
    },
    30_000
  );
});

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
