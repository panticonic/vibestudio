import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcEnvelope } from "../types.js";
import {
  FRAME_DATA,
  FRAME_END,
  FRAME_ERROR,
  FRAME_HEAD,
  type FrameType,
  type HeadFramePayload,
} from "../protocol/streamCodec.js";
import { decodeBulkMessage, encodeBulkMessage } from "../protocol/bulkMux.js";
import {
  decodeControlFrame,
  encodeControlFrame,
  type SessionControlFrame,
  type SessionHelloFrame,
  type SessionOpenFrame,
  type SessionRouteFrame,
  type SessionStreamOpenFrame,
} from "../protocol/sessionNegotiation.js";
import {
  FINGERPRINT_MISMATCH_CODE,
  STREAM_RECEIVE_OVERFLOW_CODE,
  createWebRtcTransport,
  type WebRtcTransport,
} from "./webrtcClient.js";
import type {
  PeerConnectionProvider,
  RtcCandidateType,
  RtcConnectionState,
  RtcDataChannelLike,
  RtcDataChannelState,
  RtcIceCandidate,
  RtcPeerConnectionLike,
  RtcSessionDescription,
} from "./webrtcPeer.js";
import type { SignalingClient } from "./webrtcSignaling.js";
import { frameControlMessage, createControlDefragmenter, type ControlDefragmenter } from "./controlFraming.js";

// ---------------------------------------------------------------------------
// In-memory WebRTC fabric (no native module)
// ---------------------------------------------------------------------------

/**
 * Fake data channel with a REAL `bufferedAmount` model: `send()` accumulates
 * `bufferedAmount` and delivers to the peer end via microtask; the auto-drain
 * microtask (default on) lowers it back to zero and fires
 * `onBufferedAmountLow`. Tests exercise backpressure by turning `autoDrain`
 * off and priming `bufferedAmount` above the transport's high-water.
 */
class FakeChannel implements RtcDataChannelLike {
  readyState: RtcDataChannelState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  maxMessageSize = 256 * 1024;
  autoDrain = true;
  peerCh: FakeChannel | null = null;
  readonly sent: Uint8Array[] = [];
  private msgH = new Set<(d: Uint8Array) => void>();
  private openH = new Set<() => void>();
  private closeH = new Set<() => void>();
  private lowH = new Set<() => void>();
  constructor(readonly label: string) {}
  send(data: Uint8Array): void {
    if (this.readyState !== "open") throw new Error(`send on ${this.readyState} channel`);
    const copy = data.slice();
    this.sent.push(copy);
    this.bufferedAmount += copy.byteLength;
    queueMicrotask(() => {
      const peer = this.peerCh;
      if (!peer || peer.readyState !== "open") return;
      for (const h of [...peer.msgH]) h(copy);
    });
    if (this.autoDrain) queueMicrotask(() => this.drain());
  }
  /** Simulate the SCTP queue flushing: bufferedAmount → 0, low event fires. */
  drain(): void {
    if (this.bufferedAmount === 0) return;
    this.bufferedAmount = 0;
    for (const h of [...this.lowH]) h();
  }
  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    for (const h of [...this.closeH]) h();
  }
  onOpen(h: () => void): () => void {
    this.openH.add(h);
    if (this.readyState === "open") queueMicrotask(() => this.openH.has(h) && h());
    return () => this.openH.delete(h);
  }
  onClose(h: () => void): () => void {
    this.closeH.add(h);
    return () => this.closeH.delete(h);
  }
  onError(): () => void {
    return () => {};
  }
  onMessage(h: (d: Uint8Array) => void): () => void {
    this.msgH.add(h);
    return () => this.msgH.delete(h);
  }
  onBufferedAmountLow(h: () => void): () => void {
    this.lowH.add(h);
    return () => this.lowH.delete(h);
  }
}

class FakePeer implements RtcPeerConnectionLike {
  connectionState: RtcConnectionState = "new";
  remoteSet = false;
  /** Every addRemoteCandidate call, tagged with whether the remote description
   * had been applied first (the buffering contract under test). */
  readonly candidatesAdded: Array<{ afterRemoteDesc: boolean }> = [];
  private stateH = new Set<(s: RtcConnectionState) => void>();
  private localDescH = new Set<(d: RtcSessionDescription) => void>();
  constructor(private readonly fabric: Fabric, readonly id: number) {}
  createDataChannel(label: string, init?: { id?: number }): RtcDataChannelLike {
    return this.fabric.createChannelPair(this, init?.id ?? 0, label);
  }
  async createOffer(): Promise<RtcSessionDescription> {
    return { type: "offer", sdp: `offer-${this.id}` };
  }
  async createAnswer(): Promise<RtcSessionDescription> {
    return { type: "answer", sdp: `answer-${this.id}` };
  }
  async setLocalDescription(desc?: RtcSessionDescription): Promise<void> {
    if (desc) for (const h of [...this.localDescH]) h(desc);
  }
  async setRemoteDescription(): Promise<void> {
    // Genuinely async (the RN adapter is) — candidates racing this were dropped.
    await Promise.resolve();
    this.remoteSet = true;
    queueMicrotask(() => {
      if (this.connectionState === "new") this.fireState("connected");
    });
  }
  async addRemoteCandidate(_c: RtcIceCandidate): Promise<void> {
    this.candidatesAdded.push({ afterRemoteDesc: this.remoteSet });
  }
  remoteFingerprint(): string | null {
    return this.connectionState === "connected" ? this.fabric.serverFp : null;
  }
  selectedCandidateType(): RtcCandidateType | null {
    return "host";
  }
  fireState(s: RtcConnectionState): void {
    this.connectionState = s;
    for (const h of [...this.stateH]) h(s);
  }
  onConnectionStateChange(h: (s: RtcConnectionState) => void): () => void {
    this.stateH.add(h);
    return () => this.stateH.delete(h);
  }
  onLocalDescription(h: (d: RtcSessionDescription) => void): () => void {
    this.localDescH.add(h);
    return () => this.localDescH.delete(h);
  }
  onLocalCandidate(): () => void {
    return () => {};
  }
  close(): void {
    this.fabric.events.push(`peer:${this.id}:close`);
    this.connectionState = "closed";
  }
}

class FakeSignaling implements SignalingClient {
  closed = false;
  private descH = new Set<(d: RtcSessionDescription) => void>();
  private candH = new Set<(c: RtcIceCandidate) => void>();
  private closedH = new Set<(r?: string) => void>();
  constructor(private readonly onOffer: (sig: FakeSignaling) => void) {}
  async sendDescription(desc: RtcSessionDescription): Promise<void> {
    if (this.closed) throw new Error("signaling closed");
    if (desc.type === "offer") queueMicrotask(() => !this.closed && this.onOffer(this));
  }
  async sendCandidate(): Promise<void> {}
  onDescription(h: (d: RtcSessionDescription) => void): () => void {
    this.descH.add(h);
    return () => this.descH.delete(h);
  }
  onCandidate(h: (c: RtcIceCandidate) => void): () => void {
    this.candH.add(h);
    return () => this.candH.delete(h);
  }
  emitDescription(desc: RtcSessionDescription): void {
    for (const h of [...this.descH]) h(desc);
  }
  emitCandidate(cand: RtcIceCandidate): void {
    for (const h of [...this.candH]) h(cand);
  }
  onClosed(h: (r?: string) => void): () => void {
    this.closedH.add(h);
    if (this.closed) h("closed");
    return () => this.closedH.delete(h);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const h of [...this.closedH]) h("closed");
  }
}

type OpenFrame = SessionOpenFrame;
type StreamOpenFrame = SessionStreamOpenFrame;

interface ServerOpts {
  /** Fingerprint the "server" presents on the wire (client pins AA:BB:CC). */
  fp?: string;
  /** `false`: never send a hello. `"defer"`: only when `sendHello()` is called.
   * Object: overrides merged into the default hello. Default: sent on attach
   * (mirrors the answerer's channel-open hello). */
  hello?: false | "defer" | Partial<Omit<SessionHelloFrame, "t">>;
  serverBootId?: string;
  sessionDirty?: boolean;
  deviceCredential?: { deviceId: string; refreshToken: string };
  /** Reply open-result success to `open` frames (default true). */
  respondToOpen?: boolean;
  /** Reply pong to pings (default true). */
  respondToPing?: boolean;
  /** Relay an ICE candidate BEFORE the answer (the RN ordering-inversion case). */
  candidateBeforeAnswer?: boolean;
  onRpc?: (frame: Extract<SessionControlFrame, { t: "rpc" }>) => SessionControlFrame | null;
  onStreamOpen?: (frame: StreamOpenFrame, fabric: Fabric) => void;
}

/**
 * The whole far end in one object: signaling answerer + fake v2-speaking
 * server. Every reconnect gets fresh signaling/peer/channels; the server logic
 * re-arms per generation (fresh defragmenter, hello per config).
 */
class Fabric {
  readonly serverFp: string;
  readonly events: string[] = [];
  readonly peers: FakePeer[] = [];
  /** Every control frame the server decoded (post-defrag), incl. hello/ping. */
  readonly frames: SessionControlFrame[] = [];
  /** Raw control-channel message sizes as received (fragmentation evidence). */
  readonly rawControlSizes: number[] = [];
  clientControl: FakeChannel | null = null;
  clientBulk: FakeChannel | null = null;
  serverControl: FakeChannel | null = null;
  serverBulk: FakeChannel | null = null;
  currentSignaling: FakeSignaling | null = null;
  createCalls = 0;
  /** Optional gate awaited inside provider.create (serialized-establish test). */
  createGate: (() => Promise<void>) | null = null;
  private serverDefrag: ControlDefragmenter = createControlDefragmenter();
  private serverSeq = 0;
  private pendingChannels = new Map<number, FakeChannel>();

  constructor(private readonly opts: ServerOpts = {}) {
    this.serverFp = opts.fp ?? "AA:BB:CC";
  }

  provider(): PeerConnectionProvider {
    return {
      create: async () => {
        this.createCalls++;
        const n = this.createCalls;
        this.events.push(`create:start:${n}`);
        if (this.createGate) await this.createGate();
        this.events.push(`create:end:${n}`);
        const peer = new FakePeer(this, n);
        this.peers.push(peer);
        return peer;
      },
    };
  }

  createSignaling = (): SignalingClient => {
    const sig = new FakeSignaling((s) => {
      if (this.opts.candidateBeforeAnswer) s.emitCandidate({ candidate: "cand-early" });
      s.emitDescription({ type: "answer", sdp: "server-answer" });
    });
    this.currentSignaling = sig;
    return sig;
  };

  /** Pair a client channel with a fresh server end; attach the server logic
   * once both pre-negotiated channels (ids 0 and 1) of a generation exist. */
  createChannelPair(_peer: FakePeer, id: number, label: string): FakeChannel {
    const client = new FakeChannel(label);
    const server = new FakeChannel(`${label}-server`);
    client.peerCh = server;
    server.peerCh = client;
    this.pendingChannels.set(id, server);
    if (id === 0) {
      this.clientControl = client;
    } else {
      this.clientBulk = client;
    }
    const control = this.pendingChannels.get(0);
    const bulk = this.pendingChannels.get(1);
    if (control && bulk) {
      this.pendingChannels.clear();
      this.attachServer(control, bulk);
    }
    return client;
  }

  private attachServer(control: FakeChannel, bulk: FakeChannel): void {
    this.serverControl = control;
    this.serverBulk = bulk;
    this.serverDefrag = createControlDefragmenter();
    control.onMessage((data) => {
      this.rawControlSizes.push(data.byteLength);
      const full = this.serverDefrag.accept(data);
      if (!full) return;
      const frame = decodeControlFrame(new TextDecoder().decode(full));
      this.frames.push(frame);
      this.handleFrame(frame);
    });
    // The answerer sends its hello directly on control-channel open.
    if (this.opts.hello !== false && this.opts.hello !== "defer") this.sendHello();
  }

  private handleFrame(frame: SessionControlFrame): void {
    switch (frame.t) {
      case "open":
        if (this.opts.respondToOpen === false) return;
        this.sendControl({
          t: "open-result",
          sid: frame.sid,
          success: true,
          callerId: frame.connectionId ? `panel:${frame.connectionId}` : "shell:host",
          callerKind: "panel",
          connectionId: frame.connectionId,
          serverBootId: this.opts.serverBootId ?? "boot-1",
          sessionDirty: this.opts.sessionDirty ?? false,
          deviceCredential: this.opts.deviceCredential,
        });
        return;
      case "ping":
        if (this.opts.respondToPing === false) return;
        this.sendControl({ t: "pong", ts: frame.ts });
        return;
      case "rpc": {
        const reply = this.opts.onRpc?.(frame as Extract<SessionControlFrame, { t: "rpc" }>);
        if (reply) this.sendControl(reply);
        return;
      }
      case "stream-open":
        this.opts.onStreamOpen?.(frame as StreamOpenFrame, this);
        return;
      default:
        return;
    }
  }

  sendControl(frame: SessionControlFrame): void {
    const channel = this.serverControl;
    if (!channel || channel.readyState !== "open") return;
    const bytes = new TextEncoder().encode(encodeControlFrame(frame));
    this.serverSeq = (this.serverSeq + 1) >>> 0;
    for (const part of frameControlMessage(bytes, 16 * 1024, this.serverSeq)) channel.send(part);
  }

  sendHello(overrides?: Partial<Omit<SessionHelloFrame, "t">>): void {
    const conf = typeof this.opts.hello === "object" ? this.opts.hello : {};
    const hello: SessionHelloFrame = {
      t: "hello",
      proto: 2,
      maxMsg: 256 * 1024,
      platform: "server",
      keepalive: { intervalMs: 15_000, timeoutMs: 45_000 },
      ...conf,
      ...overrides,
    };
    this.sendControl(hello);
  }

  sendBulk(streamId: number, type: FrameType, payload: Uint8Array, more = false): void {
    const channel = this.serverBulk;
    if (!channel || channel.readyState !== "open") return;
    channel.send(encodeBulkMessage(streamId, type, payload, more));
  }

  sendHead(streamId: number, head: HeadFramePayload): void {
    this.sendBulk(streamId, FRAME_HEAD, new TextEncoder().encode(JSON.stringify(head)));
  }

  sendEnd(streamId: number, bytesIn: number): void {
    this.sendBulk(streamId, FRAME_END, new TextEncoder().encode(JSON.stringify({ bytesIn })));
  }

  get opens(): OpenFrame[] {
    return this.frames.filter((f): f is OpenFrame => f.t === "open");
  }

  get clientHellos(): SessionHelloFrame[] {
    return this.frames.filter((f): f is SessionHelloFrame => f.t === "hello");
  }

  currentPeer(): FakePeer {
    const peer = this.peers[this.peers.length - 1];
    if (!peer) throw new Error("no peer created yet");
    return peer;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const PAIR = { room: "room-uuid", fingerprint: "AA:BB:CC" };

function makeTransport(fabric: Fabric, extra: Partial<Parameters<typeof createWebRtcTransport>[0]> = {}): WebRtcTransport {
  return createWebRtcTransport({
    provider: fabric.provider(),
    createSignaling: fabric.createSignaling,
    pairing: PAIR,
    ...extra,
  });
}

function requestEnvelope(method: string, requestId: string, args: unknown[] = []): RpcEnvelope {
  return {
    from: "panel:c1",
    target: "main",
    delivery: { caller: { callerId: "panel:c1", callerKind: "panel" } },
    provenance: [{ callerId: "panel:c1", callerKind: "panel" }],
    message: { type: "request", requestId, fromId: "panel:c1", method, args },
  };
}

/** Caller-to-caller envelope — ships as a `route` frame, not `rpc` (§3.4). */
function routedRequestEnvelope(requestId: string, method = "panel.doThing"): RpcEnvelope {
  return {
    from: "panel:c1",
    target: "panel:c2",
    delivery: { caller: { callerId: "panel:c1", callerKind: "panel" } },
    provenance: [{ callerId: "panel:c1", callerKind: "panel" }],
    message: { type: "request", requestId, fromId: "panel:c1", method, args: [] },
  };
}

/** Our answer to a remote caller's routed request — also a `route` frame. */
function routedResponseEnvelope(requestId: string): RpcEnvelope {
  return {
    from: "panel:c1",
    target: "panel:c2",
    delivery: { caller: { callerId: "panel:c1", callerKind: "panel" } },
    provenance: [{ callerId: "panel:c1", callerKind: "panel" }],
    message: { type: "response", requestId, result: { ok: true } },
  };
}

function streamEnvelope(requestId: string): RpcEnvelope {
  return {
    from: "panel:c1",
    target: "main",
    delivery: { caller: { callerId: "panel:c1", callerKind: "panel" } },
    provenance: [{ callerId: "panel:c1", callerKind: "panel" }],
    message: {
      type: "stream-request",
      requestId,
      fromId: "panel:c1",
      method: "credentials.proxyFetch",
      args: ["https://x/y"],
    },
  };
}

/** Let queued microtask chains (fabric delivery hops) settle. */
async function flushMicrotasks(turns = 40): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// pin + basic pipe
// ---------------------------------------------------------------------------

describe("WebRTC transport — pin + hello handshake", () => {
  it("connects (pin ok + channels open + hello exchanged) and sets the 256 KiB drain window", async () => {
    const fabric = new Fabric();
    const transport = makeTransport(fabric);
    await transport.connect();
    expect(transport.status()).toBe("connected");
    expect(fabric.clientControl?.bufferedAmountLowThreshold).toBe(256 * 1024);
    expect(fabric.clientBulk?.bufferedAmountLowThreshold).toBe(256 * 1024);
    // Our hello was the FIRST control frame the server saw.
    expect(fabric.frames[0]?.t).toBe("hello");
    await transport.close();
  });

  it("FAILS CLOSED when the signaling box swaps the fingerprint (negative test)", async () => {
    const fabric = new Fabric({ fp: "EVIL-FP" });
    const transport = makeTransport(fabric);
    await expect(transport.connect()).rejects.toMatchObject({ code: FINGERPRINT_MISMATCH_CODE });
    expect(transport.status()).not.toBe("connected");
  });

  it("advertises min(chunkSize option, channel maxMessageSize) with 16 KiB floor and the local keepalive", async () => {
    const fabric = new Fabric();
    const transport = makeTransport(fabric, { chunkSize: 4096, platform: "desktop" });
    await transport.connect();
    const hello = fabric.clientHellos[0]!;
    expect(hello.proto).toBe(2);
    expect(hello.maxMsg).toBe(4096);
    expect(hello.platform).toBe("desktop");
    expect(hello.keepalive).toEqual({ intervalMs: 15_000, timeoutMs: 45_000 });
    await transport.close();

    // No chunkSize option → the channel's real maxMessageSize (256 KiB fake).
    const fabric2 = new Fabric();
    const transport2 = makeTransport(fabric2);
    await transport2.connect();
    expect(fabric2.clientHellos[0]!.maxMsg).toBe(256 * 1024);
    await transport2.close();

    // Channel reports 0 (the RN case) → floor to 16 KiB.
    const fabric3 = new Fabric();
    const transport3 = makeTransport(fabric3);
    const origCreate = fabric3.createChannelPair.bind(fabric3);
    fabric3.createChannelPair = (peer, id, label) => {
      const ch = origCreate(peer, id, label) as FakeChannel;
      (ch as { maxMessageSize: number }).maxMessageSize = 0;
      return ch;
    };
    await transport3.connect();
    expect(fabric3.clientHellos[0]!.maxMsg).toBe(16 * 1024);
    await transport3.close();
  });

  it("fragments outbound control frames under the NEGOTIATED chunk (min of both hellos)", async () => {
    const fabric = new Fabric({ hello: { maxMsg: 2048 } });
    const transport = makeTransport(fabric);
    await transport.connect();
    const session = transport.openSession({ connectionId: "c1", getToken: () => "g" });
    await session.ready!();
    fabric.rawControlSizes.length = 0;
    const payload = "x".repeat(6000);
    await session.send(requestEnvelope("fs.read", "req-big", [payload]));
    await flushMicrotasks(120);
    const sizes = fabric.rawControlSizes;
    expect(sizes.length).toBeGreaterThanOrEqual(3); // fragmented, not one message
    for (const size of sizes) expect(size).toBeLessThanOrEqual(2048);
    // …and it reassembles intact on the far side.
    const rpc = fabric.frames.filter((f) => f.t === "rpc").pop() as Extract<SessionControlFrame, { t: "rpc" }>;
    expect((rpc.envelope.message as { args: string[] }).args[0]).toBe(payload);
    await transport.close();
  });

  it("does NOT report connected until the remote hello arrives", async () => {
    const fabric = new Fabric({ hello: "defer" });
    const transport = makeTransport(fabric);
    const connecting = transport.connect();
    await flushMicrotasks();
    // Pin verified, ICE connected, channels open — but no remote hello yet.
    expect(fabric.currentPeer().connectionState).toBe("connected");
    expect(transport.status()).toBe("connecting");
    fabric.sendHello();
    await flushMicrotasks();
    await connecting;
    expect(transport.status()).toBe("connected");
    await transport.close();
  });

  it("drops the pipe when no remote hello arrives within 10 s", async () => {
    vi.useFakeTimers();
    const fabric = new Fabric({ hello: false });
    const transport = makeTransport(fabric);
    const connecting = transport.connect().catch(() => undefined);
    await flushMicrotasks();
    expect(transport.status()).toBe("connecting"); // our hello sent, waiting
    await vi.advanceTimersByTimeAsync(10_000);
    expect(transport.status()).toBe("disconnected"); // hello timeout → pipe down
    await transport.close();
    await connecting;
  });

  it("drops the pipe on a proto mismatch", async () => {
    const fabric = new Fabric({ hello: { proto: 1 } });
    const transport = makeTransport(fabric);
    const connecting = transport.connect().catch(() => undefined);
    await flushMicrotasks();
    expect(transport.status()).toBe("disconnected");
    await transport.close();
    await connecting;
  });

  it("drops the pipe on a non-hello first frame", async () => {
    const fabric = new Fabric({ hello: "defer" });
    const transport = makeTransport(fabric);
    const connecting = transport.connect().catch(() => undefined);
    await flushMicrotasks();
    fabric.sendControl({ t: "pong", ts: 1 }); // pipe frame before hello
    await flushMicrotasks();
    expect(transport.status()).toBe("disconnected");
    await transport.close();
    await connecting;
  });
});

// ---------------------------------------------------------------------------
// keepalive
// ---------------------------------------------------------------------------

describe("WebRTC transport — keepalive", () => {
  it("negotiates the interval down (min of both hellos) and pings out-of-band under a saturated scheduler", async () => {
    const fabric = new Fabric({ hello: { keepalive: { intervalMs: 25, timeoutMs: 45_000 } } });
    const transport = makeTransport(fabric);
    await transport.connect();
    const session = transport.openSession({ connectionId: "c1", getToken: () => "g" });
    await session.ready!();

    // Saturate the control channel: nothing scheduled can depart.
    const control = fabric.clientControl!;
    control.autoDrain = false;
    control.bufferedAmount = 1_000_000; // way above the 256 KiB high-water
    fabric.frames.length = 0;
    await session.send(requestEnvelope("fs.read", "req-parked", ["y".repeat(40_000)]));

    await sleep(120);
    // The ping bypassed the queue (negotiated 25 ms — the local 15 s default
    // would never fire inside this window); the rpc is still parked.
    expect(fabric.frames.some((f) => f.t === "ping")).toBe(true);
    expect(fabric.frames.some((f) => f.t === "rpc")).toBe(false);
    expect(transport.status()).toBe("connected"); // pongs kept it alive

    // Un-saturate: the parked frame departs intact.
    control.autoDrain = true;
    control.drain();
    await sleep(50);
    await flushMicrotasks(120);
    expect(fabric.frames.some((f) => f.t === "rpc")).toBe(true);
    await transport.close();
  });

  it("drops the pipe when pongs stop for the negotiated timeout", async () => {
    const fabric = new Fabric({
      respondToPing: false,
      hello: { keepalive: { intervalMs: 20, timeoutMs: 30 } },
    });
    const transport = makeTransport(fabric);
    const statuses: string[] = [];
    transport.onStatusChange((s) => statuses.push(s));
    await transport.connect();
    await sleep(200);
    expect(statuses).toContain("disconnected"); // keepalive timeout fired
    await transport.close();
  });
});

// ---------------------------------------------------------------------------
// recovery state machine
// ---------------------------------------------------------------------------

describe("WebRTC transport — recovery", () => {
  it("walks disconnected → connecting → connected across a pipe drop", async () => {
    vi.useFakeTimers();
    const fabric = new Fabric();
    const transport = makeTransport(fabric);
    const statuses: string[] = [];
    transport.onStatusChange((s) => statuses.push(s));
    await transport.connect();
    expect(statuses).toEqual(["connecting", "connected"]);

    fabric.currentPeer().fireState("failed");
    expect(statuses).toEqual(["connecting", "connected", "disconnected"]); // BEFORE recovery
    await vi.advanceTimersByTimeAsync(2_000); // backoff ≤ 1.5 s, then re-establish
    expect(statuses).toEqual(["connecting", "connected", "disconnected", "connecting", "connected"]);
    expect(transport.status()).toBe("connected");
    await transport.close();
  });

  it("re-arms connect() after a drop so connect()/ready() during recovery awaits the new pipe", async () => {
    const fabric = new Fabric();
    const transport = makeTransport(fabric);
    await transport.connect();
    expect(transport.status()).toBe("connected");

    fabric.currentPeer().fireState("failed");
    expect(transport.status()).not.toBe("connected");

    // connect() during recovery must be PENDING — not the stale resolved promise.
    const reconnecting = transport.connect();
    const pendingMarker = Symbol("pending");
    const raced = await Promise.race([
      reconnecting.then(() => "resolved"),
      Promise.resolve(pendingMarker),
    ]);
    expect(raced).toBe(pendingMarker);

    await transport.close(); // stops the reestablish loop + rejects the re-armed promise
    await reconnecting.catch(() => undefined);
  });

  it("serializes establish: a down-event mid-establish re-runs recovery once, never concurrently", async () => {
    vi.useFakeTimers();
    const fabric = new Fabric();
    let releaseFirstCreate!: () => void;
    const firstGate = new Promise<void>((r) => {
      releaseFirstCreate = r;
    });
    let gated = false;
    fabric.createGate = () => {
      if (gated) return Promise.resolve();
      gated = true;
      return firstGate;
    };
    const transport = makeTransport(fabric);
    const connecting = transport.connect();
    await flushMicrotasks();
    expect(fabric.events).toEqual(["create:start:1"]); // establish #1 parked in create

    // Down-event DURING the in-flight establish: signaling room dies.
    fabric.currentSignaling!.close();
    await flushMicrotasks();
    expect(transport.status()).toBe("disconnected");
    expect(fabric.createCalls).toBe(1); // no concurrent establish started

    releaseFirstCreate();
    await flushMicrotasks();
    // Attempt settled; the dirty flag re-runs recovery through backoff.
    await vi.advanceTimersByTimeAsync(2_000);
    await connecting;
    expect(transport.status()).toBe("connected");
    // Strict ordering: create #2 starts only after create #1 fully settled, and
    // peer #1 was closed before the new peer was stood up.
    const ev = fabric.events;
    expect(ev.indexOf("create:end:1")).toBeGreaterThan(ev.indexOf("create:start:1"));
    expect(ev.indexOf("peer:1:close")).toBeGreaterThan(ev.indexOf("create:end:1"));
    expect(ev.indexOf("create:start:2")).toBeGreaterThan(ev.indexOf("peer:1:close"));
    expect(fabric.createCalls).toBe(2);
    await transport.close();
  });

  it("buffers remote candidates until the remote description is applied, then flushes them", async () => {
    const fabric = new Fabric({ candidateBeforeAnswer: true });
    const transport = makeTransport(fabric);
    await transport.connect();
    const peer = fabric.currentPeer();
    // The early candidate was NOT dropped and NOT applied pre-description.
    expect(peer.candidatesAdded).toEqual([{ afterRemoteDesc: true }]);
    await transport.close();
  });
});

// ---------------------------------------------------------------------------
// §3.4 delivery gap — unflushed routed requests re-drive on resubscribe
// ---------------------------------------------------------------------------

describe("WebRTC transport — unflushed routed request re-drive (§3.4)", () => {
  /** Connect + open a session, then stall the control channel so the next
   * scheduled control frame is QUEUED but never hits the wire. */
  async function connectWithSession(fabric: Fabric, sessionExtra: Record<string, unknown> = {}) {
    const transport = makeTransport(fabric);
    await transport.connect();
    const session = transport.openSession({ connectionId: "c1", getToken: () => "g", ...sessionExtra });
    await session.ready!();
    return { transport, session };
  }

  function stallControl(fabric: Fabric): void {
    const control = fabric.clientControl!;
    control.autoDrain = false;
    control.bufferedAmount = 1_000_000; // way above the 256 KiB high-water: the pump parks
  }

  function routeFrames(fabric: Fabric): SessionRouteFrame[] {
    return fabric.frames.filter((f): f is SessionRouteFrame => f.t === "route");
  }

  it("re-drives a routed request that was enqueued but unflushed at pipe-down, and the call completes", async () => {
    vi.useFakeTimers();
    const fabric = new Fabric();
    const { transport, session } = await connectWithSession(fabric);
    const received: RpcEnvelope[] = [];
    session.onMessage((e) => received.push(e));

    stallControl(fabric);
    await session.send(routedRequestEnvelope("routed-1"));
    await flushMicrotasks(120);
    expect(routeFrames(fabric)).toHaveLength(0); // parked client-side, never delivered

    fabric.currentPeer().fireState("failed"); // pipe-down: the queued batch settles 'dropped'
    await vi.advanceTimersByTimeAsync(2_000); // backoff → reestablish → open → resubscribe
    await flushMicrotasks(120);
    expect(transport.status()).toBe("connected");

    // The frame was re-driven exactly once, intact, on the NEW pipe generation.
    const routes = routeFrames(fabric);
    expect(routes).toHaveLength(1);
    expect((routes[0]!.envelope.message as { requestId: string }).requestId).toBe("routed-1");

    // …so the far end can answer and the pending settles ("nothing hangs, ever").
    fabric.sendControl({
      t: "routed",
      sid: session.sid,
      envelope: {
        from: "panel:c2",
        target: "panel:c1",
        delivery: { caller: { callerId: "panel:c2", callerKind: "panel" } },
        provenance: [{ callerId: "panel:c2", callerKind: "panel" }],
        message: { type: "response", requestId: "routed-1", result: { ok: true } },
      },
    });
    await flushMicrotasks(120);
    expect(
      received.some((e) => (e.message as { requestId?: string }).requestId === "routed-1"),
    ).toBe(true);
    await transport.close();
  });

  it("does NOT re-send a routed request that FLUSHED before pipe-down (no duplicate execution)", async () => {
    vi.useFakeTimers();
    const fabric = new Fabric();
    const { transport, session } = await connectWithSession(fabric);

    await session.send(routedRequestEnvelope("routed-flushed"));
    await flushMicrotasks(120);
    expect(routeFrames(fabric)).toHaveLength(1); // delivered on the first pipe

    fabric.currentPeer().fireState("failed");
    await vi.advanceTimersByTimeAsync(2_000); // resubscribe recovery
    await flushMicrotasks(120);
    expect(transport.status()).toBe("connected");
    expect(routeFrames(fabric)).toHaveLength(1); // still exactly one — no re-drive
    await transport.close();
  });

  it("re-drives a routed RESPONSE that was enqueued but unflushed at pipe-down (remote caller unstranded)", async () => {
    vi.useFakeTimers();
    const fabric = new Fabric();
    const { transport, session } = await connectWithSession(fabric);

    // We are the CALLEE: our answer to a remote caller's request gets queued
    // just as the pipe dies. The caller's pipe never went down and the server
    // never received the response — without a re-drive their pending hangs.
    stallControl(fabric);
    await session.send(routedResponseEnvelope("remote-req-1"));
    await flushMicrotasks(120);
    expect(routeFrames(fabric)).toHaveLength(0); // parked client-side, never delivered

    fabric.currentPeer().fireState("failed");
    await vi.advanceTimersByTimeAsync(2_000); // resubscribe recovery
    await flushMicrotasks(120);
    expect(transport.status()).toBe("connected");

    const routes = routeFrames(fabric);
    expect(routes).toHaveLength(1); // the response reached the server exactly once
    const message = routes[0]!.envelope.message as { type: string; requestId: string };
    expect(message.type).toBe("response");
    expect(message.requestId).toBe("remote-req-1");
    await transport.close();
  });

  it("does NOT re-send a routed RESPONSE that FLUSHED before pipe-down (no duplicate delivery)", async () => {
    vi.useFakeTimers();
    const fabric = new Fabric();
    const { transport, session } = await connectWithSession(fabric);

    await session.send(routedResponseEnvelope("remote-req-flushed"));
    await flushMicrotasks(120);
    expect(routeFrames(fabric)).toHaveLength(1); // delivered on the first pipe

    fabric.currentPeer().fireState("failed");
    await vi.advanceTimersByTimeAsync(2_000); // resubscribe recovery
    await flushMicrotasks(120);
    expect(transport.status()).toBe("connected");
    expect(routeFrames(fabric)).toHaveLength(1); // still exactly one — no re-drive
    await transport.close();
  });

  it("clears the unflushed requests on cold-recover (client layer rejects; no transport re-drive)", async () => {
    vi.useFakeTimers();
    const fabric = new Fabric({ sessionDirty: true }); // every open-result ⇒ cold-recover
    const kinds: string[] = [];
    const { transport, session } = await connectWithSession(fabric, {
      onRecovery: (kind: string) => kinds.push(kind),
    });

    stallControl(fabric);
    await session.send(routedRequestEnvelope("routed-cold"));
    await flushMicrotasks(120);
    expect(routeFrames(fabric)).toHaveLength(0);

    fabric.currentPeer().fireState("failed");
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks(120);
    expect(transport.status()).toBe("connected");
    expect(kinds).toEqual(["cold-recover", "cold-recover"]); // dirty on both opens
    // The pending was rejected at the CLIENT layer (client.ts §3.4); the
    // transport must not resurrect the call.
    expect(routeFrames(fabric)).toHaveLength(0);

    // …and the entry is GONE, not parked: another full recovery cycle still
    // re-drives nothing.
    fabric.currentPeer().fireState("failed");
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks(120);
    expect(transport.status()).toBe("connected");
    expect(routeFrames(fabric)).toHaveLength(0);
    await transport.close();
  });
});

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

describe("WebRTC transport — session lifecycle", () => {
  it("opens a logical session, redeeming its own grant, and resolves callerId", async () => {
    const fabric = new Fabric();
    const transport = makeTransport(fabric);
    await transport.connect();
    let tokenCalls = 0;
    const session = transport.openSession({
      connectionId: "c1",
      callerKind: "panel",
      getToken: () => {
        tokenCalls++;
        return "grant-1";
      },
    });
    await session.ready!();
    expect(session.callerId()).toBe("panel:c1");
    expect(tokenCalls).toBe(1); // grant is fetched fresh per open (one-shot grants)
    await transport.close();
  });

  it("emits onRecovery('resubscribe') on the FIRST open (WS parity)", async () => {
    const fabric = new Fabric();
    const transport = makeTransport(fabric);
    await transport.connect();
    const kinds: string[] = [];
    const session = transport.openSession({
      connectionId: "c1",
      getToken: () => "g",
      onRecovery: (kind) => kinds.push(kind),
    });
    await session.ready!();
    expect(kinds).toEqual(["resubscribe"]);
    await transport.close();
  });

  it("fires onPaired with the device credential delivered on the open-result", async () => {
    const fabric = new Fabric({ deviceCredential: { deviceId: "dev_42", refreshToken: "rt-secret" } });
    const transport = makeTransport(fabric);
    await transport.connect();
    const paired: Array<{ deviceId: string; refreshToken: string }> = [];
    const session = transport.openSession({
      connectionId: "c1",
      callerKind: "shell",
      getToken: () => "pairing-code",
      onPaired: (cred) => {
        paired.push(cred);
      },
    });
    await session.ready!();
    expect(paired).toEqual([{ deviceId: "dev_42", refreshToken: "rt-secret" }]);
    await transport.close();
  });

  it("send() ships an rpc frame and onMessage() delivers the response", async () => {
    const fabric = new Fabric({
      onRpc: (frame) => {
        const req = frame.envelope.message as { requestId: string };
        return {
          t: "rpc",
          sid: frame.sid,
          envelope: {
            from: "main",
            target: "panel:c1",
            delivery: { caller: { callerId: "main", callerKind: "server" } },
            provenance: [{ callerId: "main", callerKind: "server" }],
            message: { type: "response", requestId: req.requestId, result: { ok: true } },
          },
        };
      },
    });
    const transport = makeTransport(fabric);
    await transport.connect();
    const session = transport.openSession({ connectionId: "c1", getToken: () => "g" });
    await session.ready!();
    const received: RpcEnvelope[] = [];
    session.onMessage((e) => received.push(e));
    await session.send(requestEnvelope("fs.read", "req-1"));
    await flushMicrotasks(120);
    expect(received).toHaveLength(1);
    expect((received[0]!.message as { result: unknown }).result).toEqual({ ok: true });
    await transport.close();
  });

  it("rejects send() before connect (fail loud, never silent hang)", async () => {
    const fabric = new Fabric();
    const transport = makeTransport(fabric);
    const session = transport.openSession({ connectionId: "c1", getToken: () => "g" });
    await expect(session.send(requestEnvelope("fs.read", "r"))).rejects.toThrow(/Not connected/);
    await transport.close();
  });

  it("discards a stale getToken continuation (reopen generation) — the deadline retry's fresh grant wins", async () => {
    vi.useFakeTimers();
    const fabric = new Fabric();
    const transport = makeTransport(fabric);
    await transport.connect();
    let resolveFirstToken!: (token: string) => void;
    const firstToken = new Promise<string>((r) => {
      resolveFirstToken = r;
    });
    let tokenCalls = 0;
    const session = transport.openSession({
      connectionId: "c1",
      getToken: () => {
        tokenCalls++;
        return tokenCalls === 1 ? firstToken : "t2";
      },
    });
    const ready = session.ready!();
    await flushMicrotasks();
    expect(fabric.opens).toHaveLength(0); // token 1 still parked — no open sent

    await vi.advanceTimersByTimeAsync(20_000); // open deadline fires
    await vi.advanceTimersByTimeAsync(1_500); // per-session backoff → attempt 2
    await flushMicrotasks();
    await ready;
    expect(fabric.opens).toHaveLength(1);
    expect(fabric.opens[0]!.token).toBe("t2");

    // The slow first grant finally lands — its generation is stale: DISCARDED.
    resolveFirstToken("t1-stale");
    await flushMicrotasks();
    expect(fabric.opens).toHaveLength(1);
    expect(tokenCalls).toBe(2);
    await transport.close();
  });

  it("retries an open whose open-result never arrives (20 s deadline + backoff)", async () => {
    vi.useFakeTimers();
    const fabric = new Fabric({ respondToOpen: false });
    const transport = makeTransport(fabric);
    await transport.connect();
    const session = transport.openSession({ connectionId: "c1", getToken: () => "g" });
    const ready = session.ready!().catch(() => undefined);
    await flushMicrotasks();
    expect(fabric.opens).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20_000); // deadline
    await vi.advanceTimersByTimeAsync(1_500); // backoff → second attempt
    await flushMicrotasks();
    expect(fabric.opens).toHaveLength(2);
    await transport.close();
    await ready;
  });

  it("auto-reopens on a NON-terminal server closed (code 4008)", async () => {
    vi.useFakeTimers();
    const fabric = new Fabric();
    const transport = makeTransport(fabric);
    await transport.connect();
    const session = transport.openSession({ connectionId: "c1", getToken: () => "g" });
    await session.ready!();
    expect(fabric.opens).toHaveLength(1);

    fabric.sendControl({ t: "closed", sid: session.sid, code: 4008, reason: "session not open", terminal: false });
    await flushMicrotasks();
    expect(session.isClosed()).toBe(false); // non-terminal — session survives
    await vi.advanceTimersByTimeAsync(1_500); // per-session backoff reopen
    await flushMicrotasks();
    expect(fabric.opens).toHaveLength(2);
    await session.ready!(); // usable again
    await transport.close();
  });

  it("removes a TERMINALLY closed session from the map (no reopen ever again)", async () => {
    vi.useFakeTimers();
    const fabric = new Fabric();
    const transport = makeTransport(fabric);
    await transport.connect();
    const session = transport.openSession({ connectionId: "c1", getToken: () => "g" });
    await session.ready!();
    expect(fabric.opens).toHaveLength(1);

    fabric.sendControl({ t: "closed", sid: session.sid, code: 4001, reason: "revoked", terminal: true });
    await flushMicrotasks();
    expect(session.isClosed()).toBe(true);
    await expect(session.send(requestEnvelope("fs.read", "r"))).rejects.toThrow(/Session is closed/);

    await vi.advanceTimersByTimeAsync(16_000); // any leaked retry would fire here
    expect(fabric.opens).toHaveLength(1);

    // The session left the map: a full pipe recovery re-opens NOTHING for it.
    fabric.currentPeer().fireState("failed");
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();
    expect(transport.status()).toBe("connected"); // pipe recovered…
    expect(fabric.opens).toHaveLength(1); // …but the dead session stayed dead
    await transport.close();
  });

  it("openSession() with a live duplicate sid closes the old instance first", async () => {
    const fabric = new Fabric();
    const transport = makeTransport(fabric);
    await transport.connect();
    const first = transport.openSession({ sid: "dup", connectionId: "c1", getToken: () => "g1" });
    await first.ready!();
    const second = transport.openSession({ sid: "dup", connectionId: "c1", getToken: () => "g2" });
    expect(first.isClosed()).toBe(true);
    await second.ready!();
    expect(second.isClosed()).toBe(false);
    await flushMicrotasks(120);
    expect(fabric.frames.some((f) => f.t === "close" && f.sid === "dup")).toBe(true);
    await transport.close();
  });

  it("hardClose settles a parked ready() and clears the sessions map", async () => {
    const fabric = new Fabric();
    const transport = makeTransport(fabric);
    await transport.connect();
    const session = transport.openSession({
      connectionId: "c1",
      getToken: () => new Promise<string>(() => undefined), // never resolves
    });
    const parked = session.ready!();
    await flushMicrotasks();
    await transport.close();
    await expect(parked).rejects.toThrow(/pipe down|closed/i);
  });

  it("waits for session re-open before status-driven sends", async () => {
    const fabric = new Fabric();
    const transport = makeTransport(fabric);
    let releaseToken!: () => void;
    const tokenReady = new Promise<void>((resolve) => {
      releaseToken = resolve;
    });
    const session = transport.openSession({
      connectionId: "c1",
      getToken: async () => {
        await tokenReady;
        return "g";
      },
    });
    let sent: Promise<void> | null = null;
    transport.onStatusChange((status) => {
      if (status === "connected") sent = session.send(requestEnvelope("fs.read", "req-status"));
    });
    const connecting = transport.connect();
    await flushMicrotasks();
    expect(fabric.opens).toEqual([]); // no open until the token resolves
    releaseToken();
    await connecting;
    await session.ready!();
    await sent;
    await flushMicrotasks(120);
    const sessionFrames = fabric.frames.filter((f) => f.t === "open" || f.t === "rpc").map((f) => f.t);
    expect(sessionFrames.slice(0, 2)).toEqual(["open", "rpc"]);
    await transport.close();
  });
});

// ---------------------------------------------------------------------------
// streams (bulk mux)
// ---------------------------------------------------------------------------

describe("WebRTC transport — streams over the bulk mux", () => {
  it("stream() rebuilds a Response from self-describing bulk mux messages", async () => {
    const fabric = new Fabric({
      onStreamOpen: (frame, f) => {
        const id = frame.streamId;
        f.sendHead(id, {
          status: 200,
          statusText: "OK",
          headerPairs: [["content-type", "text/plain"]],
          finalUrl: "https://x/y",
        });
        f.sendBulk(id, FRAME_DATA, new TextEncoder().encode("streamed-"));
        f.sendBulk(id, FRAME_DATA, new TextEncoder().encode("bytes"));
        f.sendEnd(id, 14);
      },
    });
    const transport = makeTransport(fabric);
    await transport.connect();
    const session = transport.openSession({ connectionId: "c1", getToken: () => "g" });
    await session.ready!();
    const resp = await session.stream!(streamEnvelope("s1"));
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/plain");
    expect(await resp.text()).toBe("streamed-bytes");
    await transport.close();
  });

  it("reassembles a HEAD continued via MORE messages", async () => {
    const fabric = new Fabric({
      onStreamOpen: (frame, f) => {
        const id = frame.streamId;
        const head = new TextEncoder().encode(
          JSON.stringify({ status: 200, statusText: "OK", headerPairs: [], finalUrl: "https://x/big" }),
        );
        const half = Math.ceil(head.byteLength / 2);
        f.sendBulk(id, FRAME_HEAD, head.subarray(0, half), true); // MORE
        f.sendBulk(id, FRAME_HEAD, head.subarray(half), false);
        f.sendEnd(id, 0);
      },
    });
    const transport = makeTransport(fabric);
    await transport.connect();
    const session = transport.openSession({ connectionId: "c1", getToken: () => "g" });
    await session.ready!();
    const resp = await session.stream!(streamEnvelope("s-more"));
    expect(resp.status).toBe(200);
    expect((resp as { url?: string }).url).toBe("https://x/big");
    await transport.close();
  });

  it("drops the pipe on a bulk protocol violation (unknown flag bits)", async () => {
    const fabric = new Fabric();
    const transport = makeTransport(fabric);
    await transport.connect();
    const raw = encodeBulkMessage(7, FRAME_DATA, new Uint8Array([1]));
    raw[4] = 0xf2; // unknown high flag bits
    fabric.serverBulk!.send(raw);
    await flushMicrotasks();
    expect(transport.status()).not.toBe("connected");
    await transport.close();
  });

  it("abort settles a pre-HEAD stream locally AND sends stream-cancel", async () => {
    const fabric = new Fabric(); // server never answers the stream-open
    const transport = makeTransport(fabric);
    await transport.connect();
    const session = transport.openSession({ connectionId: "c1", getToken: () => "g" });
    await session.ready!();
    const controller = new AbortController();
    const pending = session.stream!(streamEnvelope("s-abort"), controller.signal);
    await flushMicrotasks(120);
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/i);
    await flushMicrotasks(120);
    const cancel = fabric.frames.find((f) => f.t === "stream-cancel");
    expect(cancel).toBeDefined();
    const open = fabric.frames.find((f) => f.t === "stream-open") as StreamOpenFrame;
    expect((cancel as { streamId: number }).streamId).toBe(open.streamId);
    await transport.close();
  });

  it("Response.body.cancel() sends stream-cancel on the direct WebRTC stream path", async () => {
    const fabric = new Fabric({
      onStreamOpen: (frame, f) => {
        f.sendHead(frame.streamId, {
          status: 200,
          statusText: "OK",
          headerPairs: [],
          finalUrl: "",
        });
        f.sendBulk(frame.streamId, FRAME_DATA, new TextEncoder().encode("partial"));
      },
    });
    const transport = makeTransport(fabric);
    await transport.connect();
    const session = transport.openSession({ connectionId: "c1", getToken: () => "g" });
    await session.ready!();
    const resp = await session.stream!(streamEnvelope("s-cancel-body"));
    await resp.body?.cancel("caller stopped reading");
    await flushMicrotasks(120);
    const open = fabric.frames.find((f) => f.t === "stream-open") as StreamOpenFrame;
    const cancel = fabric.frames.find((f) => f.t === "stream-cancel");
    expect(cancel).toBeDefined();
    expect((cancel as { streamId: number }).streamId).toBe(open.streamId);
    await transport.close();
  });

  it("null-body responses do not synthesize stream-cancel", async () => {
    const fabric = new Fabric({
      onStreamOpen: (frame, f) => {
        f.sendHead(frame.streamId, {
          status: 204,
          statusText: "No Content",
          headerPairs: [],
          finalUrl: "",
        });
        f.sendEnd(frame.streamId, 0);
      },
    });
    const transport = makeTransport(fabric);
    await transport.connect();
    const session = transport.openSession({ connectionId: "c1", getToken: () => "g" });
    await session.ready!();
    const resp = await session.stream!(streamEnvelope("s-no-content"));
    expect(resp.status).toBe(204);
    expect(resp.body).toBeNull();
    await flushMicrotasks(120);
    expect(fabric.frames.some((f) => f.t === "stream-cancel")).toBe(false);
    await transport.close();
  });

  it("removes the abort listener once the stream settles (no accumulation on shared signals)", async () => {
    const fabric = new Fabric({
      onStreamOpen: (frame, f) => {
        f.sendHead(frame.streamId, { status: 200, statusText: "OK", headerPairs: [], finalUrl: "" });
        f.sendEnd(frame.streamId, 0);
      },
    });
    const transport = makeTransport(fabric);
    await transport.connect();
    const session = transport.openSession({ connectionId: "c1", getToken: () => "g" });
    await session.ready!();
    const add = vi.fn();
    const remove = vi.fn();
    const sharedSignal = {
      aborted: false,
      addEventListener: add,
      removeEventListener: remove,
    } as unknown as AbortSignal;
    const resp = await session.stream!(streamEnvelope("s-shared"), sharedSignal);
    await resp.text();
    await flushMicrotasks(120);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0]![1]).toBe(add.mock.calls[0]![1]); // the SAME listener
    await transport.close();
  });

  it("fails a stream that exceeds the 8 MiB receive buffer and cancels it (fail loud)", async () => {
    const fabric = new Fabric({
      onStreamOpen: (frame, f) => {
        const id = frame.streamId;
        f.sendHead(id, { status: 200, statusText: "OK", headerPairs: [], finalUrl: "" });
        // 12 MiB in one synchronous burst — the consumer can't keep up by design.
        const chunk = new Uint8Array(1024 * 1024);
        for (let i = 0; i < 12; i++) f.sendBulk(id, FRAME_DATA, chunk);
      },
    });
    const transport = makeTransport(fabric);
    await transport.connect();
    const session = transport.openSession({ connectionId: "c1", getToken: () => "g" });
    await session.ready!();
    const resp = await session.stream!(streamEnvelope("s-flood"));
    await expect(resp.text()).rejects.toMatchObject({ code: STREAM_RECEIVE_OVERFLOW_CODE });
    await flushMicrotasks(120);
    expect(fabric.frames.some((f) => f.t === "stream-cancel")).toBe(true);
    expect(transport.status()).toBe("connected"); // only the stream died, not the pipe
    await transport.close();
  });

  it("sendBulkFrame chunks DATA into independent mux messages under the negotiated size", async () => {
    const fabric = new Fabric({ hello: { maxMsg: 1024 } }); // effective chunk 1024
    const transport = makeTransport(fabric);
    await transport.connect();
    const received: Array<{ streamId: number; flags: number; len: number }> = [];
    fabric.serverBulk!.onMessage((d) => {
      received.push({
        streamId: ((d[0]! << 24) | (d[1]! << 16) | (d[2]! << 8) | d[3]!) >>> 0,
        flags: d[4]!,
        len: d.byteLength,
      });
    });
    await transport.sendBulkFrame(9, FRAME_DATA, new Uint8Array(2500));
    await flushMicrotasks(120);
    expect(received.length).toBe(3); // ceil(2500 / (1024-5))
    for (const m of received) {
      expect(m.streamId).toBe(9);
      expect(m.flags).toBe(FRAME_DATA); // complete self-describing DATA, no MORE
      expect(m.len).toBeLessThanOrEqual(1024);
    }
    await transport.close();
  });
});

// ---------------------------------------------------------------------------
// observability
// ---------------------------------------------------------------------------

describe("WebRTC transport — nudge (liveness probe)", () => {
  it("sends an immediate ping and drops the pipe when no pong lands within 5 s", async () => {
    vi.useFakeTimers();
    const fabric = new Fabric({ respondToPing: false }); // server never pongs
    const transport = makeTransport(fabric);
    await transport.connect();
    const statuses: string[] = [];
    transport.onStatusChange((s) => statuses.push(s));
    fabric.frames.length = 0;

    transport.nudge();
    await flushMicrotasks();
    expect(fabric.frames.some((f) => f.t === "ping")).toBe(true); // probed immediately
    expect(transport.status()).toBe("connected"); // deadline not yet elapsed

    await vi.advanceTimersByTimeAsync(5_000);
    expect(transport.status()).toBe("disconnected"); // nudge timeout → pipe down
    expect(statuses).toContain("disconnected");
    await transport.close();
  });

  it("a pong clears the nudge deadline (no spurious teardown)", async () => {
    vi.useFakeTimers();
    const fabric = new Fabric(); // server pongs (default)
    const transport = makeTransport(fabric);
    await transport.connect();

    transport.nudge();
    await flushMicrotasks(); // ping out, pong back → deadline cleared
    await vi.advanceTimersByTimeAsync(6_000); // past the 5 s deadline
    expect(transport.status()).toBe("connected"); // the pong kept it alive
    await transport.close();
  });

  it("is a no-op before the pipe is connected (no ping, no throw)", async () => {
    const fabric = new Fabric({ respondToPing: false });
    const transport = makeTransport(fabric);
    transport.nudge(); // never connected
    await flushMicrotasks();
    expect(transport.status()).not.toBe("connected");
    expect(fabric.frames.some((f) => f.t === "ping")).toBe(false);
    await transport.close();
  });

  it("is a no-op while recovery is in flight", async () => {
    vi.useFakeTimers();
    const fabric = new Fabric({ respondToPing: false });
    const transport = makeTransport(fabric);
    await transport.connect();
    fabric.currentPeer().fireState("failed"); // pipe down → recovery scheduled
    expect(transport.status()).not.toBe("connected");
    fabric.frames.length = 0;
    transport.nudge(); // must not probe or force a second teardown
    await flushMicrotasks();
    expect(fabric.frames.some((f) => f.t === "ping")).toBe(false);
    await transport.close();
  });
});

describe("WebRTC transport — candidate type (relay alarm)", () => {
  it("reports the selected ICE candidate type via the option AND the surface subscription", async () => {
    const fabric = new Fabric();
    const viaOption: Array<RtcCandidateType | null> = [];
    const transport = makeTransport(fabric, { onCandidateType: (t) => viaOption.push(t) });
    const viaSurface: Array<RtcCandidateType | null> = [];
    transport.onCandidateType((t) => viaSurface.push(t));
    await transport.connect();
    expect(viaOption).toContain("host");
    expect(viaSurface).toContain("host");
    expect(transport.candidateType()).toBe("host");

    fabric.currentPeer().fireState("failed"); // pipe-down → null (alarm reset)
    expect(viaSurface[viaSurface.length - 1]).toBeNull();
    await transport.close();
  });
});

// ---------------------------------------------------------------------------
// uploads — request bodies on the bulk channel (§1.6)
// ---------------------------------------------------------------------------

describe("WebRTC transport — request-body uploads (§1.6)", () => {
  /** Decode every bulk message the server end receives (whole-message frames). */
  function collectServerBulk(fabric: Fabric) {
    const received: Array<{ streamId: number; type: number; payload: Uint8Array }> = [];
    fabric.serverBulk!.onMessage((d) => {
      const decoded = decodeBulkMessage(d);
      received.push({ streamId: decoded.streamId, type: decoded.type, payload: decoded.payload });
    });
    return received;
  }

  function bodyOf(...chunks: string[]): ReadableStream<Uint8Array> {
    const encoderUtf8 = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoderUtf8.encode(chunk));
        controller.close();
      },
    });
  }

  it("declares bodyStreamId on the stream-open and pumps the body as DATA…END bulk frames", async () => {
    let openFrame: StreamOpenFrame | undefined;
    const fabric = new Fabric({
      onStreamOpen: (frame) => {
        openFrame = frame;
      },
    });
    const transport = makeTransport(fabric);
    await transport.connect();
    const received = collectServerBulk(fabric);
    const session = transport.openSession({ connectionId: "c1", getToken: () => "g" });
    await session.ready!();

    const pending = session.stream!(streamEnvelope("up-1"), null, bodyOf("upload-", "bytes"));
    await flushMicrotasks(120);

    expect(openFrame).toBeDefined();
    expect(typeof openFrame!.bodyStreamId).toBe("number");
    expect(openFrame!.bodyStreamId).not.toBe(openFrame!.streamId);

    const bodyFrames = received.filter((m) => m.streamId === openFrame!.bodyStreamId);
    expect(bodyFrames.map((m) => m.type)).toEqual([FRAME_DATA, FRAME_DATA, FRAME_END]);
    expect(new TextDecoder().decode(bodyFrames[0]!.payload)).toBe("upload-");
    expect(new TextDecoder().decode(bodyFrames[1]!.payload)).toBe("bytes");
    expect(JSON.parse(new TextDecoder().decode(bodyFrames[2]!.payload))).toEqual({ bytesIn: 12 });

    // The response path is untouched: serve it and the caller gets a Response.
    fabric.sendHead(openFrame!.streamId, { status: 201, statusText: "Created", headerPairs: [], finalUrl: "" });
    fabric.sendEnd(openFrame!.streamId, 0);
    const resp = await pending;
    expect(resp.status).toBe(201);
    await transport.close();
  });

  it("streams without a body keep the wire unchanged (no bodyStreamId, no bulk sends)", async () => {
    let openFrame: StreamOpenFrame | undefined;
    const fabric = new Fabric({
      onStreamOpen: (frame, f) => {
        openFrame = frame;
        f.sendHead(frame.streamId, { status: 200, statusText: "OK", headerPairs: [], finalUrl: "" });
        f.sendEnd(frame.streamId, 0);
      },
    });
    const transport = makeTransport(fabric);
    await transport.connect();
    const received = collectServerBulk(fabric);
    const session = transport.openSession({ connectionId: "c1", getToken: () => "g" });
    await session.ready!();
    await session.stream!(streamEnvelope("no-body"));
    await flushMicrotasks(120);
    expect(openFrame).toBeDefined();
    expect(openFrame!.bodyStreamId).toBeUndefined();
    expect(received).toHaveLength(0);
    await transport.close();
  });

  it("AWAITS sendBulkFrame — a stalled bulk channel parks the body reader (upload backpressure)", async () => {
    const fabric = new Fabric();
    const transport = makeTransport(fabric);
    await transport.connect();
    const session = transport.openSession({ connectionId: "c1", getToken: () => "g" });
    await session.ready!();

    // Stall the pipe: no auto-drain, and prime bufferedAmount over the 256 KiB
    // high-water so the scheduler's drain await parks after the first send.
    const bulk = fabric.clientBulk!;
    bulk.autoDrain = false;

    let reads = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads++;
          controller.enqueue(new Uint8Array(300 * 1024)); // each chunk > high-water
        },
      },
      // No pre-buffering: pull fires only on actual reader demand, so `reads`
      // counts exactly the pump's read() calls.
      new CountQueuingStrategy({ highWaterMark: 0 }),
    );
    void session.stream!(streamEnvelope("up-bp"), null, body).catch(() => undefined);
    await flushMicrotasks(200);
    const stalledReads = reads;
    // First chunk sent (buffer was empty), second accepted-but-unsent parks the
    // pump — the reader is NOT pulled again while the channel is stalled.
    expect(stalledReads).toBeLessThanOrEqual(2);

    bulk.drain();
    await flushMicrotasks(200);
    expect(reads).toBeGreaterThan(stalledReads); // drain resumed the pump
    await transport.close();
  });

  it("abort mid-upload sends an UPLOAD_ABORTED ERROR frame + stream-cancel and rejects the stream", async () => {
    let openFrame: StreamOpenFrame | undefined;
    const fabric = new Fabric({
      onStreamOpen: (frame) => {
        openFrame = frame; // server never answers — the stream stays pre-HEAD
      },
    });
    const transport = makeTransport(fabric);
    await transport.connect();
    const received = collectServerBulk(fabric);
    const session = transport.openSession({ connectionId: "c1", getToken: () => "g" });
    await session.ready!();

    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("first"));
        // never closes — only the abort can end this upload
      },
      cancel() {
        cancelled = true;
      },
    });
    const pending = session.stream!(streamEnvelope("up-abort"), controller.signal, body);
    await flushMicrotasks(120);
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/i);
    await flushMicrotasks(120);

    expect(cancelled).toBe(true); // the caller's body producer was released
    const bodyFrames = received.filter((m) => m.streamId === openFrame!.bodyStreamId);
    const errorFrame = bodyFrames.find((m) => m.type === FRAME_ERROR);
    expect(errorFrame).toBeDefined();
    expect(JSON.parse(new TextDecoder().decode(errorFrame!.payload))).toMatchObject({
      code: "UPLOAD_ABORTED",
    });
    expect(bodyFrames.some((m) => m.type === FRAME_END)).toBe(false); // no END masquerade
    const cancel = fabric.frames.find((f) => f.t === "stream-cancel");
    expect((cancel as { streamId: number } | undefined)?.streamId).toBe(openFrame!.streamId);
    await transport.close();
  });

  it("a body reader failure fails the stream() result loudly (ERROR frame + cancel)", async () => {
    let openFrame: StreamOpenFrame | undefined;
    const fabric = new Fabric({
      onStreamOpen: (frame) => {
        openFrame = frame; // pre-HEAD: the pump failure must reject stream()
      },
    });
    const transport = makeTransport(fabric);
    await transport.connect();
    const received = collectServerBulk(fabric);
    const session = transport.openSession({ connectionId: "c1", getToken: () => "g" });
    await session.ready!();

    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("partial"));
        c.error(new Error("disk read failed"));
      },
    });
    const pending = session.stream!(streamEnvelope("up-fail"), null, body);
    await expect(pending).rejects.toThrow("disk read failed");
    await flushMicrotasks(120);

    const bodyFrames = received.filter((m) => m.streamId === openFrame!.bodyStreamId);
    const errorFrame = bodyFrames.find((m) => m.type === FRAME_ERROR);
    expect(errorFrame).toBeDefined();
    expect(JSON.parse(new TextDecoder().decode(errorFrame!.payload))).toMatchObject({
      message: "disk read failed",
      code: "UPLOAD_ABORTED",
    });
    expect(fabric.frames.some((f) => f.t === "stream-cancel")).toBe(true);
    await transport.close();
  });

  it("transport close mid-upload cancels the body producer and rejects the stream (no leaks)", async () => {
    const fabric = new Fabric(); // server never answers the stream-open
    const transport = makeTransport(fabric);
    await transport.connect();
    const session = transport.openSession({ connectionId: "c1", getToken: () => "g" });
    await session.ready!();

    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("first"));
        // never closes — the teardown must stop the pump
      },
      cancel() {
        cancelled = true;
      },
    });
    const pending = session.stream!(streamEnvelope("up-close"), null, body);
    await flushMicrotasks(120);
    await transport.close();
    await expect(pending).rejects.toThrow();
    await flushMicrotasks(120);
    expect(cancelled).toBe(true);
  });

  it("a pre-aborted signal never opens the stream and cancels the body immediately", async () => {
    const fabric = new Fabric();
    const transport = makeTransport(fabric);
    await transport.connect();
    const session = transport.openSession({ connectionId: "c1", getToken: () => "g" });
    await session.ready!();
    const controller = new AbortController();
    controller.abort();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    await expect(session.stream!(streamEnvelope("up-pre"), controller.signal, body)).rejects.toThrow(
      /aborted/i,
    );
    await flushMicrotasks(120);
    expect(fabric.frames.some((f) => f.t === "stream-open")).toBe(false);
    expect(cancelled).toBe(true);
    await transport.close();
  });
});
