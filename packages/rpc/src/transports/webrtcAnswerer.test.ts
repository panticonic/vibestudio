import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebRtcAnswererPipe, type WebRtcAnswererPipe } from "./webrtcAnswerer.js";
import type {
  RtcConnectionState,
  RtcDataChannelLike,
  RtcDataChannelState,
  RtcIceCandidate,
  RtcPeerConnectionLike,
  RtcSessionDescription,
} from "./webrtcPeer.js";
import type { SignalingClient } from "./webrtcSignaling.js";
import { createControlDefragmenter, frameControlMessage } from "./controlFraming.js";
import { createBulkDemux, decodeBulkMessage, encodeBulkMessage } from "../protocol/bulkMux.js";
import { FRAME_DATA, FRAME_HEAD } from "../protocol/streamCodec.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Flush microtask chains (and zero-delay timers when timers are faked). */
const tick = async (turns = 3): Promise<void> => {
  for (let i = 0; i < turns; i++) {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

// ---------------------------------------------------------------------------
// Fakes — a real bufferedAmount model: send() accumulates when trackBuffered,
// and the test controls drain() (fires onBufferedAmountLow), open(), close().
// ---------------------------------------------------------------------------

class FakeChannel implements RtcDataChannelLike {
  readyState: RtcDataChannelState = "connecting";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  maxMessageSize = 256 * 1024;
  /** When true, every send raises bufferedAmount until drain(). */
  trackBuffered = false;
  readonly sent: Uint8Array[] = [];
  private msgH = new Set<(d: Uint8Array) => void>();
  private openH = new Set<() => void>();
  private closeH = new Set<() => void>();
  private errH = new Set<(e: Error) => void>();
  private lowH = new Set<() => void>();
  constructor(readonly label: string) {}
  send(data: Uint8Array): void {
    if (this.readyState !== "open") throw new Error(`send on ${this.readyState} channel`);
    this.sent.push(data.slice());
    if (this.trackBuffered) this.bufferedAmount += data.byteLength;
  }
  open(): void {
    this.readyState = "open";
    for (const h of [...this.openH]) h();
  }
  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    for (const h of [...this.closeH]) h();
  }
  /** Simulate the SCTP queue flushing: bufferedAmount → 0, low event fires. */
  drain(): void {
    this.bufferedAmount = 0;
    for (const h of [...this.lowH]) h();
  }
  deliver(data: Uint8Array): void {
    for (const h of [...this.msgH]) h(data);
  }
  fireError(error: Error): void {
    for (const h of [...this.errH]) h(error);
  }
  onOpen(h: () => void): () => void {
    this.openH.add(h);
    return () => this.openH.delete(h);
  }
  onClose(h: () => void): () => void {
    this.closeH.add(h);
    return () => this.closeH.delete(h);
  }
  onError(h: (e: Error) => void): () => void {
    this.errH.add(h);
    return () => this.errH.delete(h);
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
  channels = new Map<number, FakeChannel>();
  /** Interleaved remote-description/candidate log for ordering assertions. */
  events: string[] = [];
  remoteDescriptions: RtcSessionDescription[] = [];
  candidates: string[] = [];
  closed = false;
  private stateH = new Set<(s: RtcConnectionState) => void>();
  private localDescH = new Set<(d: RtcSessionDescription) => void>();
  createDataChannel(label: string, init?: { id?: number }): RtcDataChannelLike {
    const ch = new FakeChannel(label);
    this.channels.set(init?.id ?? 0, ch);
    return ch;
  }
  async createOffer(): Promise<RtcSessionDescription> {
    return { type: "offer", sdp: "offer-sdp" };
  }
  async createAnswer(): Promise<RtcSessionDescription> {
    return { type: "answer", sdp: "answer-sdp" };
  }
  async setLocalDescription(desc?: RtcSessionDescription): Promise<void> {
    if (desc) for (const h of [...this.localDescH]) h(desc);
  }
  async setRemoteDescription(desc: RtcSessionDescription): Promise<void> {
    this.remoteDescriptions.push(desc);
    this.events.push(`desc:${desc.type}`);
  }
  async addRemoteCandidate(cand: RtcIceCandidate): Promise<void> {
    this.candidates.push(cand.candidate);
    this.events.push(`cand:${cand.candidate}`);
  }
  remoteFingerprint(): string | null {
    return "client-fp";
  }
  selectedCandidateType(): "host" {
    return "host";
  }
  fire(s: RtcConnectionState): void {
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
    this.closed = true;
  }
}

class FakeSignaling implements SignalingClient {
  private descH = new Set<(d: RtcSessionDescription) => void>();
  private candH = new Set<(c: RtcIceCandidate) => void>();
  private closedH = new Set<(reason?: string) => void>();
  sentDescriptions: RtcSessionDescription[] = [];
  closedFlag = false;
  closeReason?: string;
  async sendDescription(desc: RtcSessionDescription): Promise<void> {
    this.sentDescriptions.push(desc);
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
  /** Mirrors the real client: a handler registered after close fires at once
   * (this is what makes a close that landed mid-attempt unswallowable). */
  onClosed(h: (reason?: string) => void): () => void {
    this.closedH.add(h);
    if (this.closedFlag) h(this.closeReason);
    return () => this.closedH.delete(h);
  }
  close(): void {
    this.emitClosed("client-closed");
  }
  deliverOffer(sdp = "offer-sdp"): void {
    for (const h of [...this.descH]) h({ type: "offer", sdp });
  }
  deliverCandidate(candidate: string): void {
    for (const h of [...this.candH]) h({ candidate });
  }
  emitClosed(reason?: string): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.closeReason = reason;
    for (const h of [...this.closedH]) h(reason);
  }
}

// ---------------------------------------------------------------------------
// Harness — a fake offerer that speaks hello + mux
// ---------------------------------------------------------------------------

let offererFrameSeq = 1000;

/** Deliver one control frame the way the offerer sends it (whole/fragments). */
function deliverControl(channel: FakeChannel, frame: object, maxMessageSize = 16 * 1024): void {
  offererFrameSeq += 1;
  const bytes = enc.encode(JSON.stringify(frame));
  for (const part of frameControlMessage(bytes, maxMessageSize, offererFrameSeq)) {
    channel.deliver(part);
  }
}

/** Reassemble + JSON-decode every complete control frame the answerer sent. */
function sentControlFrames(channel: FakeChannel): Array<Record<string, unknown>> {
  const defrag = createControlDefragmenter();
  const frames: Array<Record<string, unknown>> = [];
  for (const message of channel.sent) {
    const full = defrag.accept(message);
    if (full) frames.push(JSON.parse(dec.decode(full)) as Record<string, unknown>);
  }
  return frames;
}

function offererHello(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    t: "hello",
    proto: 2,
    maxMsg: 256 * 1024,
    platform: "desktop",
    keepalive: { intervalMs: 15_000, timeoutMs: 45_000 },
    ...over,
  };
}

interface Harness {
  pipe: WebRtcAnswererPipe;
  peers: FakePeer[];
  signals: FakeSignaling[];
  downs: string[];
}

function makeHarness(createSignaling?: () => SignalingClient): Harness {
  const peers: FakePeer[] = [];
  const signals: FakeSignaling[] = [];
  const pipe = createWebRtcAnswererPipe({
    provider: {
      create: () => {
        const peer = new FakePeer();
        peers.push(peer);
        return peer;
      },
    },
    createSignaling:
      createSignaling ??
      (() => {
        const signaling = new FakeSignaling();
        signals.push(signaling);
        return signaling;
      }),
    pairing: { iceServers: [], certificatePemFile: "/server.pem", keyPemFile: "/server.key" },
  });
  const downs: string[] = [];
  pipe.onDown((reason) => downs.push(reason));
  return { pipe, peers, signals, downs };
}

/** Full pairing ritual: connect → offer → channels open → hello exchange. */
async function pairUp(
  h: Harness,
  remoteHelloOver: Record<string, unknown> = {}
): Promise<{ peer: FakePeer; control: FakeChannel; bulk: FakeChannel }> {
  const connecting = h.pipe.connect();
  await tick();
  h.signals.at(-1)!.deliverOffer();
  await tick();
  const peer = h.peers.at(-1)!;
  const control = peer.channels.get(0)!;
  const bulk = peer.channels.get(1)!;
  control.open();
  bulk.open();
  peer.fire("connected");
  await tick();
  deliverControl(control, offererHello(remoteHelloOver));
  await tick();
  await connecting;
  return { peer, control, bulk };
}

const bytes = (n: number, fill = 7): Uint8Array => new Uint8Array(n).fill(fill);

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe("WebRTC answerer pipe (v2)", () => {
  it("arms lazily: signaling joins on connect(), no peer until the first offer", async () => {
    const h = makeHarness();
    void h.pipe.connect().catch(() => {});
    await tick();
    expect(h.signals).toHaveLength(1);
    expect(h.peers).toHaveLength(0);

    // A stray candidate must not conjure a peer either — it buffers.
    h.signals[0]!.deliverCandidate("early");
    await tick();
    expect(h.peers).toHaveLength(0);

    h.signals[0]!.deliverOffer();
    await tick();
    expect(h.peers).toHaveLength(1);
    await h.pipe.close();
  });

  it("exchanges hellos (server hello first, direct) and negotiates the chunk", async () => {
    const h = makeHarness();
    const { peer, control, bulk } = await pairUp(h, { maxMsg: 105 });

    // Answer went back over signaling during establish.
    expect(h.signals[0]!.sentDescriptions.map((d) => d.type)).toContain("answer");
    // 256 KiB drain high-water on both channels (§1.3/§1.4).
    expect(control.bufferedAmountLowThreshold).toBe(256 * 1024);
    expect(bulk.bufferedAmountLowThreshold).toBe(256 * 1024);

    // Our hello is the FIRST control message, with the §1.1 shape.
    const frames = sentControlFrames(control);
    expect(frames[0]).toEqual({
      t: "hello",
      proto: 2,
      maxMsg: 256 * 1024,
      platform: "server",
      keepalive: { intervalMs: 15_000, timeoutMs: 45_000 },
    });
    expect(h.pipe.status()).toBe("connected");

    // Effective chunk = min(local 256 KiB, remote 105, 256 KiB) = 105:
    // a 300-byte control frame fragments into ≤105-byte messages...
    const before = control.sent.length;
    await h.pipe.writeControl(bytes(300));
    for (const message of control.sent.slice(before)) {
      expect(message.byteLength).toBeLessThanOrEqual(105);
    }
    expect(control.sent.length).toBeGreaterThan(before + 1);

    // ...and bulk DATA chunks into ≤105-byte mux messages (100-byte payloads).
    await h.pipe.writeBulkFrame(3, FRAME_DATA, bytes(250));
    const dataMessages = bulk.sent.map((m) => decodeBulkMessage(m));
    expect(dataMessages.map((m) => m.payload.byteLength)).toEqual([100, 100, 50]);
    expect(dataMessages.every((m) => m.streamId === 3 && m.type === FRAME_DATA && !m.more)).toBe(
      true
    );

    // Inbound control frames reach the handler reassembled, post-hello.
    const got: Uint8Array[] = [];
    h.pipe.onControl((d) => got.push(d));
    deliverControl(control, { t: "close", sid: "s1" });
    expect(JSON.parse(dec.decode(got[0]!))).toEqual({ t: "close", sid: "s1" });

    // Inbound bulk messages demux to onBulkFrame.
    const gotBulk: Array<[number, number, number]> = [];
    h.pipe.onBulkFrame((sid, type, payload) => gotBulk.push([sid, type, payload.byteLength]));
    bulk.deliver(encodeBulkMessage(9, FRAME_DATA, bytes(4)));
    expect(gotBulk).toEqual([[9, FRAME_DATA, 4]]);

    expect(peer.closed).toBe(false);
    await h.pipe.close();
  });

  it("rejects non-positive remote hello maxMsg", async () => {
    const h = makeHarness();
    void h.pipe.connect().catch(() => {});
    await tick();
    h.signals.at(-1)!.deliverOffer();
    await tick();
    const peer = h.peers.at(-1)!;
    const control = peer.channels.get(0)!;
    const bulk = peer.channels.get(1)!;
    control.open();
    bulk.open();
    peer.fire("connected");
    await tick();

    deliverControl(control, offererHello({ maxMsg: 0 }));
    await tick();

    expect(h.downs.at(-1)).toContain("hello maxMsg 0");
    expect(h.pipe.status()).toBe("disconnected");
    expect(peer.closed).toBe(true);
    await h.pipe.close();
  });

  it("connect() resolves only after hello + both channels (not on ICE connected)", async () => {
    const h = makeHarness();
    let resolved = false;
    void h.pipe.connect().then(() => {
      resolved = true;
    });
    await tick();
    h.signals[0]!.deliverOffer();
    await tick();
    const peer = h.peers[0]!;
    const control = peer.channels.get(0)!;
    const bulk = peer.channels.get(1)!;
    control.open();
    bulk.open();
    peer.fire("connected"); // the old pipe resolved here — v2 must not
    await tick();
    expect(resolved).toBe(false);
    expect(h.pipe.status()).toBe("connecting");

    deliverControl(control, offererHello());
    await tick();
    expect(resolved).toBe(true);
    expect(h.pipe.status()).toBe("connected");
    await h.pipe.close();
  });

  it("buffers post-hello session frames until the bulk channel opens", async () => {
    const h = makeHarness();
    let resolved = false;
    const connecting = h.pipe.connect().then(() => {
      resolved = true;
    });
    await tick();
    h.signals[0]!.deliverOffer();
    await tick();

    const peer = h.peers[0]!;
    const control = peer.channels.get(0)!;
    const bulk = peer.channels.get(1)!;
    const got: Array<Record<string, unknown>> = [];
    h.pipe.onControl((data) => got.push(JSON.parse(dec.decode(data)) as Record<string, unknown>));

    control.open();
    peer.fire("connected");
    deliverControl(control, offererHello());
    await tick();
    expect(h.pipe.status()).toBe("connecting");
    expect(resolved).toBe(false);

    deliverControl(control, { t: "open", sid: "s1", token: "tok" });
    await tick();
    expect(got).toEqual([]);

    bulk.open();
    await tick();
    await connecting;
    expect(resolved).toBe(true);
    expect(h.pipe.status()).toBe("connected");
    expect(got).toEqual([{ t: "open", sid: "s1", token: "tok" }]);
    await h.pipe.close();
  });

  it("drops the pipe on a session frame before the hello", async () => {
    const h = makeHarness();
    void h.pipe.connect().catch(() => {});
    await tick();
    h.signals[0]!.deliverOffer();
    await tick();
    const peer = h.peers[0]!;
    peer.channels.get(0)!.open();
    peer.channels.get(1)!.open();
    deliverControl(peer.channels.get(0)!, { t: "open", sid: "s1", token: "tok" });
    expect(h.downs).toEqual(["protocol violation: 'open' frame before hello"]);
    expect(h.pipe.status()).toBe("disconnected");
    expect(peer.closed).toBe(true);
    await h.pipe.close();
  });

  it("drops the pipe on hello with proto !== 2", async () => {
    const h = makeHarness();
    void h.pipe.connect().catch(() => {});
    await tick();
    h.signals[0]!.deliverOffer();
    await tick();
    const peer = h.peers[0]!;
    peer.channels.get(0)!.open();
    peer.channels.get(1)!.open();
    deliverControl(peer.channels.get(0)!, offererHello({ proto: 1 }));
    expect(h.downs).toEqual(["protocol violation: hello proto 1 (want 2)"]);
    await h.pipe.close();
  });

  it("drops the pipe when no remote hello arrives within 10s of channel open", async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    void h.pipe.connect().catch(() => {});
    await tick();
    h.signals[0]!.deliverOffer();
    await tick();
    const peer = h.peers[0]!;
    peer.channels.get(0)!.open();
    peer.channels.get(1)!.open();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(h.downs).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(h.downs).toEqual(["hello timeout (no remote hello within 10000ms)"]);
    expect(peer.closed).toBe(true);
    await h.pipe.close();
  });

  it("drops the pipe on a bulk message before the hello", async () => {
    const h = makeHarness();
    void h.pipe.connect().catch(() => {});
    await tick();
    h.signals[0]!.deliverOffer();
    await tick();
    const peer = h.peers[0]!;
    peer.channels.get(0)!.open();
    peer.channels.get(1)!.open();
    peer.channels.get(1)!.deliver(encodeBulkMessage(1, FRAME_DATA, bytes(3)));
    expect(h.downs).toEqual(["protocol violation: bulk message before hello"]);
    await h.pipe.close();
  });

  it("answers ping with a direct pong that bypasses a saturated control scheduler", async () => {
    const h = makeHarness();
    const { control } = await pairUp(h);
    const helloCount = control.sent.length;

    // Saturate the channel: the scheduler parks awaiting drain.
    control.bufferedAmount = 300 * 1024;
    const queued = h.pipe.writeControl(bytes(100), "s1");
    await tick();
    expect(control.sent.length).toBe(helloCount); // parked — nothing sent

    deliverControl(control, { t: "ping", ts: 42 });
    expect(control.sent.length).toBe(helloCount + 1); // pong went out anyway
    expect(sentControlFrames(control).at(-1)).toEqual({ t: "pong", ts: 42 });

    control.drain();
    await queued; // the parked frame flows after drain, AFTER the pong
    expect(control.sent.length).toBe(helloCount + 2);
    expect(h.downs).toEqual([]);
    await h.pipe.close();
  });

  it("drops the pipe after ping silence of 2x the negotiated timeout", async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    // Remote advertises a 200ms timeout; effective = min(45000, 200) = 200.
    const { peer, control } = await pairUp(h, { keepalive: { intervalMs: 100, timeoutMs: 200 } });

    await vi.advanceTimersByTimeAsync(350);
    expect(h.downs).toEqual([]); // silence 350 < 400 — alive
    deliverControl(control, { t: "ping", ts: 1 });
    await vi.advanceTimersByTimeAsync(350);
    expect(h.downs).toEqual([]); // ping reset the clock
    await vi.advanceTimersByTimeAsync(300);
    expect(h.downs).toEqual(["client keepalive lost"]); // silence > 400
    expect(peer.closed).toBe(true);
    expect(h.pipe.status()).toBe("disconnected");
    await h.pipe.close();
  });

  it("survives ICE disconnected when it recovers within the grace window (split-brain regression)", async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    const { peer } = await pairUp(h);

    peer.fire("disconnected");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.downs).toEqual([]); // still inside the 20s grace
    expect(h.pipe.status()).toBe("connected");

    peer.fire("connected"); // recovery cancels the pending teardown
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.downs).toEqual([]);
    expect(h.pipe.status()).toBe("connected");
    expect(peer.closed).toBe(false); // sessions survived
    await h.pipe.close();
  });

  it("drops the pipe when ICE disconnected outlives the 20s grace", async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    const { peer } = await pairUp(h);
    peer.fire("disconnected");
    await vi.advanceTimersByTimeAsync(19_999);
    expect(h.downs).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(h.downs).toEqual(["ICE disconnected (grace elapsed)"]);
    expect(peer.closed).toBe(true);
    await h.pipe.close();
  });

  it("drops the pipe immediately on ICE failed", async () => {
    const h = makeHarness();
    const { peer } = await pairUp(h);
    peer.fire("failed");
    expect(h.downs).toEqual(["ICE failed"]);
    expect(peer.closed).toBe(true);
    expect(h.pipe.status()).toBe("disconnected");
    await h.pipe.close();
  });

  it("drops the pipe on channel close/error, and later writes settle silently", async () => {
    const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h = makeHarness();
    const { control } = await pairUp(h);
    control.close(); // remote teardown
    expect(h.downs).toEqual(["control channel closed"]);
    expect(info).toHaveBeenCalledWith(expect.stringContaining("pipe down: control channel closed"));
    expect(warning).not.toHaveBeenCalledWith(
      expect.stringContaining("pipe down: control channel closed")
    );

    // Writes after down settle without sending (pipe-down is the signal).
    const sentBefore = control.sent.length;
    await h.pipe.writeControl(bytes(10));
    await h.pipe.writeBulkFrame(1, FRAME_DATA, bytes(10));
    expect(control.sent.length).toBe(sentBefore);
    await h.pipe.close();

    const h2 = makeHarness();
    const { bulk } = await pairUp(h2);
    bulk.fireError(new Error("boom"));
    expect(h2.downs).toEqual(["bulk channel error: boom"]);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("pipe down: bulk channel error: boom")
    );
    await h2.pipe.close();
    info.mockRestore();
    warning.mockRestore();
  });

  it("re-pairs on a new offer, flushing buffered candidates AFTER the new description", async () => {
    const h = makeHarness();
    const { peer: peer1 } = await pairUp(h);

    // Steady state: candidates apply directly to the current peer.
    h.signals[0]!.deliverCandidate("c1");
    await tick();
    expect(peer1.candidates).toEqual(["c1"]);

    // A new offer (same device re-established) plus a candidate racing in
    // behind it — the candidate must land on the NEW peer, after its offer.
    h.signals[0]!.deliverOffer("offer-sdp-2");
    h.signals[0]!.deliverCandidate("c2");
    await tick();

    expect(h.downs).toEqual(["re-pairing offer"]);
    expect(h.peers).toHaveLength(2);
    expect(peer1.closed).toBe(true);
    expect(peer1.candidates).toEqual(["c1"]); // c2 never touched the dead peer
    const peer2 = h.peers[1]!;
    expect(peer2.events).toEqual(["desc:offer", "cand:c2"]); // description FIRST
    expect(h.signals[0]!.sentDescriptions.filter((d) => d.type === "answer")).toHaveLength(2);

    // The replacement pipe comes up like any other, and connect() re-arms.
    const reconnecting = h.pipe.connect();
    peer2.channels.get(0)!.open();
    peer2.channels.get(1)!.open();
    await tick();
    deliverControl(peer2.channels.get(0)!, offererHello());
    await tick();
    await reconnecting;
    expect(h.pipe.status()).toBe("connected");
    await h.pipe.close();
  });

  it("splits an oversized HEAD across MORE messages that demux back to one frame", async () => {
    const h = makeHarness();
    const { bulk } = await pairUp(h, { maxMsg: 105 }); // budget = 100
    await h.pipe.writeBulkFrame(5, FRAME_HEAD, bytes(250, 9));

    const messages = bulk.sent.map((m) => decodeBulkMessage(m));
    expect(messages.map((m) => [m.type, m.more, m.payload.byteLength])).toEqual([
      [FRAME_HEAD, true, 100],
      [FRAME_HEAD, true, 100],
      [FRAME_HEAD, false, 50],
    ]);

    const frames: Array<[number, number, Uint8Array]> = [];
    const demux = createBulkDemux((sid, type, payload) => frames.push([sid, type, payload]));
    for (const m of bulk.sent) demux.push(m);
    expect(frames).toHaveLength(1);
    expect(frames[0]![0]).toBe(5);
    expect(frames[0]![1]).toBe(FRAME_HEAD);
    expect([...frames[0]![2]]).toEqual([...bytes(250, 9)]);
    await h.pipe.close();
  });

  it("round-robins bulk sends across streams at message granularity", async () => {
    const h = makeHarness();
    const { bulk } = await pairUp(h, { maxMsg: 105 });
    const a = h.pipe.writeBulkFrame(1, FRAME_DATA, bytes(250));
    const b = h.pipe.writeBulkFrame(2, FRAME_DATA, bytes(250));
    await Promise.all([a, b]);
    expect(bulk.sent.map((m) => decodeBulkMessage(m).streamId)).toEqual([1, 2, 1, 2, 1, 2]);
    await h.pipe.close();
  });

  it("dropBulkStream discards queued bulk and settles its writers", async () => {
    const h = makeHarness();
    const { bulk } = await pairUp(h, { maxMsg: 105 });
    bulk.bufferedAmount = 300 * 1024; // park the pump
    let settled = false;
    const write = h.pipe.writeBulkFrame(7, FRAME_DATA, bytes(300)).then(() => {
      settled = true;
    });
    await tick();
    expect(bulk.sent).toHaveLength(0);
    expect(h.pipe.bulkPendingBytes(7)).toBe(315); // 3 x (100 payload + 5 header)
    expect(h.pipe.bulkPendingBytes()).toBe(315);

    h.pipe.dropBulkStream(7);
    await write;
    expect(settled).toBe(true);
    expect(h.pipe.bulkPendingBytes(7)).toBe(0);

    bulk.drain();
    await tick();
    expect(bulk.sent).toHaveLength(0); // the cancelled stream never hit the wire
    await h.pipe.close();
  });

  it("drops the pipe on a control defragmenter budget violation", async () => {
    const h = makeHarness();
    const { control } = await pairUp(h);
    // 33 concurrently-incomplete fragment sets breach the 32-set budget.
    const frame = bytes(40);
    for (let i = 0; i < 33; i++) {
      const parts = frameControlMessage(frame, 16, 5000 + i); // fragments of one set
      control.deliver(parts[0]!); // first fragment only — the set never completes
    }
    expect(h.downs).toHaveLength(1);
    expect(h.downs[0]).toMatch(/^control protocol violation: /);
    expect(h.pipe.status()).toBe("disconnected");
    await h.pipe.close();
  });

  it("drops the pipe on a bulk mux violation (unknown flag bits)", async () => {
    const h = makeHarness();
    const { bulk } = await pairUp(h);
    bulk.deliver(new Uint8Array([0, 0, 0, 1, 0x82, 0])); // flags 0x80 unknown
    expect(h.downs).toHaveLength(1);
    expect(h.downs[0]).toMatch(/^bulk protocol violation: /);
    await h.pipe.close();
  });

  it("fails LOUD on a padded (>512B) duplicate hello — size-independent (bug #11)", async () => {
    const h = makeHarness();
    const { control } = await pairUp(h);
    expect(h.pipe.status()).toBe("connected");
    // A duplicate hello padded past the 512B ping-sniff limit used to slip
    // straight through to the session demux; it must now drop the pipe.
    deliverControl(control, offererHello({ pad: "z".repeat(1000) }));
    await tick();
    expect(h.downs.some((d) => /duplicate hello/.test(d))).toBe(true);
    expect(h.pipe.status()).toBe("disconnected");
    await h.pipe.close();
  });

  it("rejoins signaling with backoff, never swallowing a close, without dropping the pipe", async () => {
    vi.useFakeTimers();
    const signals: FakeSignaling[] = [];
    const h = makeHarness(() => {
      const signaling = new FakeSignaling();
      signals.push(signaling);
      // The second join's socket dies DURING the attempt (before the loop can
      // register handlers) — the race the old `signalingRecovery ??=` swallowed.
      if (signals.length === 2) signaling.emitClosed("died mid-attempt");
      return signaling;
    });
    const connecting = h.pipe.connect();
    await tick();
    signals[0]!.deliverOffer();
    await tick();
    const peer = h.peers[0]!;
    peer.channels.get(0)!.open();
    peer.channels.get(1)!.open();
    await tick();
    deliverControl(peer.channels.get(0)!, offererHello());
    await tick();
    await connecting;

    signals[0]!.emitClosed("room websocket dropped");
    await tick();
    expect(h.pipe.status()).toBe("connected"); // healthy pipe untouched
    expect(h.downs).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_501); // first backoff (attempt 0): 1s + jitter <= 500ms
    expect(signals).toHaveLength(2); // rejoined — into the mid-attempt corpse

    // GROWTH (bug #1): the corpse never proved LIVE (no WS open / inbound
    // frame), so its rejoin backoff DOUBLED to ~2s (attempt 1) instead of
    // resetting to ~1s on mere construction. A short advance must NOT reconnect
    // yet — under the old constant-cadence bug another ~1s socket would already
    // have fired here (hammering a down worker ~1/s forever).
    await vi.advanceTimersByTimeAsync(400);
    expect(signals).toHaveLength(2); // still waiting out the GROWN backoff

    await vi.advanceTimersByTimeAsync(2_500); // past the ~2s backoff → retried, not swallowed
    expect(signals).toHaveLength(3);

    // The new room delivers a re-pairing offer — the pipe answers on it.
    signals[2]!.deliverOffer();
    await tick();
    expect(h.peers).toHaveLength(2);
    expect(signals[2]!.sentDescriptions.map((d) => d.type)).toContain("answer");

    // close() stops the loop for good.
    await h.pipe.close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(signals).toHaveLength(3);
    expect(peer.closed).toBe(true);
  });

  it("close() rejects a pending connect() and settles everything", async () => {
    const h = makeHarness();
    const connecting = h.pipe.connect();
    await tick();
    await h.pipe.close();
    await expect(connecting).rejects.toThrow("Answerer pipe closed");
    expect(h.downs).toEqual(["answerer pipe closed"]);
    await expect(h.pipe.connect()).rejects.toThrow("Answerer pipe closed");
    // Writes on a closed pipe settle silently.
    await h.pipe.writeControl(bytes(3));
    await h.pipe.writeBulkFrame(1, FRAME_DATA, bytes(3));
  });

  // --- candidateType surface (§9.8 relay alarm) -----------------------------

  it("candidateType() reads the live peer's selected pair and null when no peer", async () => {
    const h = makeHarness();
    expect(h.pipe.candidateType()).toBeNull(); // lazy-armed, no peer yet
    const { control } = await pairUp(h);
    expect(h.pipe.candidateType()).toBe("host"); // FakePeer.selectedCandidateType()
    control.close(); // pipe down → peer torn down
    await tick();
    expect(h.pipe.candidateType()).toBeNull();
  });

  it("onCandidateType fires the selected type on pipe-up (hello complete) and null on down", async () => {
    const h = makeHarness();
    const seen: Array<string | null> = [];
    const off = h.pipe.onCandidateType((type) => seen.push(type));
    // Nothing fires before hello-complete.
    const connecting = h.pipe.connect();
    await tick();
    h.signals.at(-1)!.deliverOffer();
    await tick();
    const peer = h.peers.at(-1)!;
    const control = peer.channels.get(0)!;
    const bulk = peer.channels.get(1)!;
    control.open();
    bulk.open();
    peer.fire("connected");
    await tick();
    expect(seen).toEqual([]); // channels open, ICE connected — but no hello yet
    deliverControl(control, offererHello());
    await tick();
    await connecting;
    expect(seen).toEqual(["host"]);

    control.close(); // down → null
    await tick();
    expect(seen).toEqual(["host", null]);

    // Unsubscribed listeners stop firing (close() emits a final null).
    off();
    await h.pipe.close();
    expect(seen).toEqual(["host", null]);
  });

  it("close() emits a final null candidate type to remaining listeners", async () => {
    const h = makeHarness();
    const seen: Array<string | null> = [];
    h.pipe.onCandidateType((type) => seen.push(type));
    await pairUp(h);
    expect(seen).toEqual(["host"]);
    await h.pipe.close();
    expect(seen).toEqual(["host", null]);
  });
});
