/**
 * Real-native WebRTC end-to-end test. Wires TWO actual `node-datachannel` peers
 * (via createNodeDatachannelProvider) through an in-process signaling relay, and
 * runs the full transport + protocol stack over REAL DTLS:
 *
 *   createWebRtcTransport (offerer)  ⇄  createWebRtcAnswererPipe (answerer)
 *                                        + RpcServer.attachWebRtcPipe
 *
 * It proves, against the live native module: ICE/DTLS connect, the fingerprint
 * pin (accept on match, FAIL CLOSED on mismatch), the session handshake, an RPC
 * round-trip, and a bulk stream. This is the bedrock the wrangler-dev harness
 * builds on (it only swaps the in-process signaling for the real signaling DO).
 *
 * Gated behind VIBEZ1_RUN_WEBRTC_E2E=1 (opens real UDP sockets + loads the
 * native binary), like the other integration tests.
 *
 *   VIBEZ1_RUN_WEBRTC_E2E=1 npx vitest run tests/webrtc-native.e2e.test.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { RpcEnvelope } from "@vibez1/rpc";
import { createWebRtcTransport, FINGERPRINT_MISMATCH_CODE } from "@vibez1/rpc/transports/webrtcClient";
import { createWebRtcAnswererPipe } from "@vibez1/rpc/transports/webrtcAnswerer";
import type { RtcIceCandidate, RtcSessionDescription } from "@vibez1/rpc/transports/webrtcPeer";
import type { SignalingClient } from "@vibez1/rpc/transports/webrtcSignaling";
import type { CallerKind, ServiceContext, ServiceDispatcher } from "@vibez1/shared/serviceDispatcher";
import { TokenManager } from "@vibez1/shared/tokenManager";
import { EntityCache } from "@vibez1/shared/runtime/entityCache";
import { RpcServer } from "../src/server/rpcServer.js";
import { createNodeDatachannelProvider } from "../src/main/webrtc/nodeDatachannelPeer.js";
import { ensurePersistentCert } from "../src/main/webrtc/cert.js";

const RUN = process.env["VIBEZ1_RUN_WEBRTC_E2E"] === "1";

/** In-process signaling relay: each peer's send reaches the other's handlers. */
function signalingPair(): { offerer: SignalingClient; answerer: SignalingClient } {
  const onDesc = { a: new Set<(d: RtcSessionDescription) => void>(), b: new Set<(d: RtcSessionDescription) => void>() };
  const onCand = { a: new Set<(c: RtcIceCandidate) => void>(), b: new Set<(c: RtcIceCandidate) => void>() };
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
      service === "demo" ? { allowed: ["shell", "panel", "worker", "server"] as CallerKind[] } : undefined,
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

async function connect(opts: { pinnedFp: string; certFile: string; keyFile: string }): Promise<Harness> {
  const sig = signalingPair();
  const serverProvider = createNodeDatachannelProvider({ peerName: "server" });
  const clientProvider = createNodeDatachannelProvider({ peerName: "client" });
  const { server, shellToken, dispatched } = makeServer();

  const pipe = createWebRtcAnswererPipe({
    provider: serverProvider,
    signaling: sig.answerer,
    pairing: { iceServers: [], certificatePemFile: opts.certFile, keyPemFile: opts.keyFile },
  });

  server.attachWebRtcPipe(pipe);

  const client = createWebRtcTransport({
    provider: clientProvider,
    createSignaling: () => sig.offerer,
    pairing: { room: "e2e-room", fingerprint: opts.pinnedFp, sig: "inproc", iceServers: [] },
    role: "offerer",
  });

  // Start the answerer first so it is subscribed before the offer arrives (the
  // in-process buffer also covers any residual race).
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
    close: async () => {
      await client.close();
      await pipe.close();
    },
  };
}

describe.runIf(RUN)("WebRTC real-native end-to-end (node-datachannel)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vibez1-rtc-e2e-"));
  const cert = ensurePersistentCert({
    certificatePemFile: path.join(tmp, "server.pem"),
    keyPemFile: path.join(tmp, "server.key"),
  });
  const harnesses: Harness[] = [];

  afterAll(async () => {
    for (const h of harnesses) await h.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("establishes real DTLS, pins the server fingerprint, and round-trips RPC", async () => {
    const h = await connect({ pinnedFp: cert.fingerprint, certFile: cert.certificatePemFile, keyFile: cert.keyPemFile });
    harnesses.push(h);
    expect(h.client.status()).toBe("connected");
    // The selected candidate type is observable (host on loopback).
    expect(["host", "srflx", "prflx", "relay", null]).toContain(h.client.candidateType());

    const session = h.client.openSession({ connectionId: "cli-1", callerKind: "shell", getToken: () => h.shellToken });
    await session.ready!();
    expect(session.callerId()).toBe("shell:e2e");

    const received: RpcEnvelope[] = [];
    session.onMessage((e) => received.push(e));
    await session.send({
      from: "shell:e2e",
      target: "main",
      delivery: { caller: { callerId: "shell:e2e", callerKind: "shell" } },
      provenance: [{ callerId: "shell:e2e", callerKind: "shell" }],
      message: { type: "request", requestId: "r1", fromId: "shell:e2e", method: "demo.healthz", args: [] },
    });
    await waitFor(() => received.length > 0);
    expect((received[0]!.message as { result: { pong: boolean; method: string; args: unknown[] } }).result).toEqual({
      pong: true,
      method: "demo.healthz",
      args: [],
    });
    expect(h.dispatched).toContainEqual({ service: "demo", method: "healthz", args: [] });
  }, 20_000);

  it("streams a bulk body over the real bulk DataChannel", async () => {
    const h = harnesses[0]!;
    const session = h.client.openSession({ connectionId: "cli-2", callerKind: "shell", getToken: () => h.shellToken });
    await session.ready!();
    const resp = await session.stream!({
      from: "shell:e2e",
      target: "main",
      delivery: { caller: { callerId: "shell:e2e", callerKind: "shell" } },
      provenance: [{ callerId: "shell:e2e", callerKind: "shell" }],
      message: { type: "stream-request", requestId: "s1", fromId: "shell:e2e", method: "demo.stream", args: ["rtc://x"] },
    });
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("real-dtls-bytes");
    expect(h.dispatched).toContainEqual({ service: "demo", method: "stream", args: ["rtc://x"] });
  }, 20_000);

  it("FAILS CLOSED when the pinned fingerprint does not match the server cert (negative)", async () => {
    const wrongFp = "00".repeat(32);
    await expect(
      connect({ pinnedFp: wrongFp, certFile: cert.certificatePemFile, keyFile: cert.keyPemFile }),
    ).rejects.toMatchObject({ code: FINGERPRINT_MISMATCH_CODE });
  }, 20_000);
});

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
