/**
 * Signaling client tests — drive `createSignalingClient` against an in-memory
 * fake WebSocket fabric (a stand-in for the `apps/signaling` DO) and a fake
 * fetch. Proven: two role-tagged peers exchange offer/answer + candidates;
 * ice-servers are pulled over HTTP and fail loud on a non-200; a same-role
 * rejoin evicts the incumbent; frames that arrive before a handler is registered
 * are buffered and flushed; out-of-band keepalive pings and reaps a dead socket.
 */

import { describe, expect, it, vi } from "vitest";

import type { RtcIceCandidate, RtcSessionDescription } from "./webrtcPeer.js";
import {
  createSignalingClient,
  type SignalingRole,
  type WebSocketCtor,
  type WebSocketLike,
} from "./webrtcSignalingClient.js";

// --- In-memory signaling fabric (stands in for the SignalingRoom DO) --------
//
// Mirrors the new DO semantics: role-keyed slots (`?role=offerer|answerer`), a
// same-role join EVICTS the incumbent (close 4001), and the DO auto-responds to
// `{"t":"ping"}` with `{"t":"pong"}` (never relaying ping/pong to the peer).

class FakeSignalingHub {
  private rooms = new Map<string, Map<SignalingRole, FakeClientWS>>();

  private roomOf(ws: FakeClientWS): Map<SignalingRole, FakeClientWS> {
    let room = this.rooms.get(ws.roomKey);
    if (!room) {
      room = new Map();
      this.rooms.set(ws.roomKey, room);
    }
    return room;
  }

  join(ws: FakeClientWS): void {
    const room = this.roomOf(ws);
    const incumbent = room.get(ws.role);
    if (incumbent && incumbent !== ws) {
      // Same-role join = the same party reconnecting → evict the incumbent.
      queueMicrotask(() => incumbent.fireClose(4001, `superseded by new ${ws.role}`));
    }
    room.set(ws.role, ws);
    queueMicrotask(() => {
      ws.fireOpen();
      for (const [, other] of room) {
        if (other !== ws && other.readyState === 1) {
          other.deliver(JSON.stringify({ t: "peer-joined", peers: room.size }));
        }
      }
    });
  }

  relay(from: FakeClientWS, data: string): void {
    let t: unknown;
    try {
      t = (JSON.parse(data) as { t?: unknown }).t;
    } catch {
      t = undefined;
    }
    if (t === "ping") {
      // DO auto-response: pong the sender, never relay ping/pong to the peer.
      from.deliver(JSON.stringify({ t: "pong" }));
      return;
    }
    for (const [, ws] of this.roomOf(from)) {
      if (ws !== from && ws.readyState === 1) ws.deliver(data);
    }
  }

  leave(ws: FakeClientWS): void {
    const room = this.rooms.get(ws.roomKey);
    if (room && room.get(ws.role) === ws) room.delete(ws.role);
  }
}

class FakeClientWS implements WebSocketLike {
  readyState = 0;
  readonly roomKey: string;
  readonly role: SignalingRole;
  private readonly listeners = new Map<string, Set<(ev: unknown) => void>>();
  constructor(url: string, private readonly hub: FakeSignalingHub) {
    const parsed = new URL(url);
    this.roomKey = parsed.pathname;
    this.role = parsed.searchParams.get("role") as SignalingRole;
    hub.join(this);
  }
  send(data: string): void {
    this.hub.relay(this, data);
  }
  close(): void {
    if (this.readyState === 3) return;
    this.hub.leave(this);
    this.fireClose(1000, "client-closed");
  }
  addEventListener(type: string, handler: (ev: never) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(handler as (ev: unknown) => void);
  }
  fireOpen(): void {
    this.readyState = 1;
    this.emit("open", {});
  }
  deliver(data: string): void {
    this.emit("message", { data });
  }
  fireClose(code: number, reason: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code, reason });
  }
  private emit(type: string, ev: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(ev);
  }
}

function wsCtorFor(hub: FakeSignalingHub): WebSocketCtor {
  return class extends FakeClientWS {
    constructor(url: string) {
      super(url, hub);
    }
  } as unknown as WebSocketCtor;
}

// --- Controllable fake WS (no fabric) — for the keepalive timer tests -------

class ControllableWS implements WebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<string, Set<(ev: unknown) => void>>();
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
    this.emit("close", { code, reason });
  }
  addEventListener(type: string, handler: (ev: never) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(handler as (ev: unknown) => void);
  }
  fireOpen(): void {
    this.readyState = 1;
    this.emit("open", {});
  }
  deliver(data: string): void {
    this.emit("message", { data });
  }
  private emit(type: string, ev: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(ev);
  }
}

function controllableWsCtor(): { WS: WebSocketCtor; instances: ControllableWS[] } {
  const instances: ControllableWS[] = [];
  const WS = class extends ControllableWS {
    constructor(url: string) {
      super(url);
      instances.push(this);
    }
  } as unknown as WebSocketCtor;
  return { WS, instances };
}

function okIceFetch(iceServers: unknown): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ iceServers }),
    text: async () => JSON.stringify({ iceServers }),
  })) as unknown as typeof fetch;
}

const PING = JSON.stringify({ t: "ping" });

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("createSignalingClient", () => {
  it("relays offer/answer and candidates between the two role-tagged peers", async () => {
    const hub = new FakeSignalingHub();
    const WS = wsCtorFor(hub);
    const base = { room: "r1", sig: "https://sig.test", WebSocketImpl: WS, fetchImpl: okIceFetch([]) };
    const a = createSignalingClient({ ...base, role: "offerer" });
    const b = createSignalingClient({ ...base, role: "answerer" });

    const aDescs: RtcSessionDescription[] = [];
    const bDescs: RtcSessionDescription[] = [];
    const aCands: RtcIceCandidate[] = [];
    const bCands: RtcIceCandidate[] = [];
    a.onDescription((d) => aDescs.push(d));
    b.onDescription((d) => bDescs.push(d));
    a.onCandidate((c) => aCands.push(c));
    b.onCandidate((c) => bCands.push(c));

    await a.sendDescription({ type: "offer", sdp: "OFFER" });
    await flush();
    expect(bDescs).toEqual([{ type: "offer", sdp: "OFFER" }]);
    expect(aDescs).toEqual([]); // never echoed back to the sender

    await b.sendDescription({ type: "answer", sdp: "ANSWER" });
    await flush();
    expect(aDescs).toEqual([{ type: "answer", sdp: "ANSWER" }]);

    await a.sendCandidate({ candidate: "cand-a", sdpMid: "0" });
    await b.sendCandidate({ candidate: "cand-b", sdpMid: "0" });
    await flush();
    expect(bCands).toEqual([{ candidate: "cand-a", sdpMid: "0" }]);
    expect(aCands).toEqual([{ candidate: "cand-b", sdpMid: "0" }]);

    a.close();
    b.close();
  });

  it("appends the role to the join URL", async () => {
    const hub = new FakeSignalingHub();
    let observedUrl = "";
    const WS = class extends FakeClientWS {
      constructor(url: string) {
        observedUrl = url;
        super(url, hub);
      }
    } as unknown as WebSocketCtor;
    const client = createSignalingClient({
      room: "abc-123",
      role: "answerer",
      sig: "https://sig.test/base",
      WebSocketImpl: WS,
      fetchImpl: okIceFetch([]),
    });
    expect(observedUrl).toBe("wss://sig.test/base/room/abc-123?role=answerer");
    client.close();
  });

  it("buffers inbound frames that arrive before a handler is registered", async () => {
    const hub = new FakeSignalingHub();
    const WS = wsCtorFor(hub);
    const base = { room: "r1", sig: "https://sig.test", WebSocketImpl: WS, fetchImpl: okIceFetch([]) };
    const a = createSignalingClient({ ...base, role: "offerer" });
    const b = createSignalingClient({ ...base, role: "answerer" });

    // B sends before A has subscribed — the frame must not be lost.
    await b.sendDescription({ type: "offer", sdp: "EARLY" });
    await flush();

    const received: RtcSessionDescription[] = [];
    a.onDescription((d) => received.push(d));
    expect(received).toEqual([{ type: "offer", sdp: "EARLY" }]);
  });

  it("fetches per-session ice servers over HTTP from the room", async () => {
    const hub = new FakeSignalingHub();
    const iceServers = [
      { urls: ["stun:stun.cloudflare.com:3478", "turn:turn.cloudflare.com:3478?transport=tcp"], username: "u", credential: "c" },
    ];
    const fetchImpl = okIceFetch(iceServers);
    const client = createSignalingClient({ room: "r1", role: "offerer", sig: "https://sig.test", WebSocketImpl: wsCtorFor(hub), fetchImpl });

    const servers = await client.fetchIceServers!();
    expect(servers).toEqual(iceServers);
    // The ice-servers URL carries NO role (it is a plain HTTP GET, not a join).
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://sig.test/room/r1/ice-servers",
      expect.objectContaining({ method: "GET" }),
    );
    client.close();
  });

  it("fails loud when ice-servers returns a non-200 — negative test", async () => {
    const hub = new FakeSignalingHub();
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 502,
      text: async () => "turn mint failed",
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const client = createSignalingClient({ room: "r1", role: "offerer", sig: "https://sig.test", WebSocketImpl: wsCtorFor(hub), fetchImpl });

    await expect(client.fetchIceServers!()).rejects.toThrow(/502/);
    client.close();
  });

  it("aborts a HUNG ice-servers fetch after the deadline so the pipeline can't wedge (bug #5)", async () => {
    vi.useFakeTimers();
    const hub = new FakeSignalingHub();
    // A fetch that hangs until its AbortSignal fires (a wedged worker that
    // accepts the connection but never responds).
    const fetchImpl = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ) as unknown as typeof fetch;
    const client = createSignalingClient({
      room: "r1",
      role: "answerer",
      sig: "https://sig.test",
      WebSocketImpl: wsCtorFor(hub),
      fetchImpl,
    });
    const pending = client.fetchIceServers!();
    const expectation = expect(pending).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(20_001);
    await expectation;
    client.close();
    vi.useRealTimers();
  });

  it("fires onOpen when the room socket opens, and immediately for a late subscriber (proven-live seam)", async () => {
    const hub = new FakeSignalingHub();
    const client = createSignalingClient({
      room: "r1",
      role: "answerer",
      sig: "https://sig.test",
      WebSocketImpl: wsCtorFor(hub),
      fetchImpl: okIceFetch([]),
    });
    let opens = 0;
    client.onOpen!(() => opens++);
    await flush();
    expect(opens).toBe(1);
    // A subscriber added AFTER the open still fires (unswallowable proof of life).
    let lateOpens = 0;
    client.onOpen!(() => lateOpens++);
    await flush();
    expect(lateOpens).toBe(1);
    client.close();
  });

  it("fires onPeerJoined when the peer slots into the room (offerer re-offer seam)", async () => {
    const hub = new FakeSignalingHub();
    const base = {
      room: "r1",
      sig: "https://sig.test",
      WebSocketImpl: wsCtorFor(hub),
      fetchImpl: okIceFetch([]),
    };
    const offerer = createSignalingClient({ ...base, role: "offerer" });
    let joined = 0;
    offerer.onPeerJoined!(() => joined++);
    await flush();
    expect(joined).toBe(0); // alone in the room
    const answerer = createSignalingClient({ ...base, role: "answerer" });
    await flush();
    expect(joined).toBe(1); // the answerer joined → offerer notified
    offerer.close();
    answerer.close();
  });

  it("evicts the incumbent when a same-role peer rejoins the room", async () => {
    const hub = new FakeSignalingHub();
    const WS = wsCtorFor(hub);
    const base = { room: "r1", sig: "https://sig.test", WebSocketImpl: WS, fetchImpl: okIceFetch([]) };
    const first = createSignalingClient({ ...base, role: "offerer" });

    let firstClosed: string | undefined;
    let firstCloses = 0;
    first.onClosed((reason) => {
      firstClosed = reason;
      firstCloses++;
    });
    await flush();

    // A second OFFERER joins the same room — the incumbent is evicted (close 4001).
    const second = createSignalingClient({ ...base, role: "offerer" });
    await flush();
    expect(firstCloses).toBe(1);
    expect(firstClosed).toContain("superseded");

    // The replacement is live and can still relay to the answerer.
    const answerer = createSignalingClient({ ...base, role: "answerer" });
    await flush(); // let the answerer's socket open before the live relay
    const got: RtcSessionDescription[] = [];
    answerer.onDescription((d) => got.push(d));
    await second.sendDescription({ type: "offer", sdp: "FRESH" });
    await flush();
    expect(got).toEqual([{ type: "offer", sdp: "FRESH" }]);

    second.close();
    answerer.close();
  });

  it("derives ws/wss and http/https endpoints from the sig scheme", async () => {
    const hub = new FakeSignalingHub();
    let observedUrl = "";
    const WS = class extends FakeClientWS {
      constructor(url: string) {
        observedUrl = url;
        super(url, hub);
      }
    } as unknown as WebSocketCtor;
    const fetchImpl = okIceFetch([]);
    const client = createSignalingClient({ room: "abc-123", role: "offerer", sig: "https://sig.test/base", WebSocketImpl: WS, fetchImpl });

    expect(observedUrl).toBe("wss://sig.test/base/room/abc-123?role=offerer");
    await client.fetchIceServers!();
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://sig.test/base/room/abc-123/ice-servers",
      expect.objectContaining({ method: "GET" }),
    );
    client.close();
  });

  it("close() fires onClosed exactly once", async () => {
    const hub = new FakeSignalingHub();
    const client = createSignalingClient({ room: "r1", role: "offerer", sig: "https://sig.test", WebSocketImpl: wsCtorFor(hub), fetchImpl: okIceFetch([]) });
    let calls = 0;
    let reason: string | undefined;
    client.onClosed((r) => {
      calls++;
      reason = r;
    });
    client.close();
    await flush();
    expect(calls).toBe(1);
    expect(reason).toBe("client-closed");
  });

  it("pings on the keepalive interval and stays open while pongs arrive", () => {
    vi.useFakeTimers();
    try {
      const { WS, instances } = controllableWsCtor();
      const client = createSignalingClient({ room: "r1", role: "offerer", sig: "https://sig.test", WebSocketImpl: WS });
      const sock = instances[0]!;
      let closed = false;
      client.onClosed(() => {
        closed = true;
      });
      sock.fireOpen();

      // One immediate proof plus five 20s intervals, each answered with a pong:
      // the socket stays alive.
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(20_000);
        sock.deliver(JSON.stringify({ t: "pong" }));
      }
      expect(sock.sent.filter((s) => s === PING)).toHaveLength(6);
      expect(closed).toBe(false);
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reaps a socket that goes 40s without a pong — dead-socket detection", () => {
    vi.useFakeTimers();
    try {
      const { WS, instances } = controllableWsCtor();
      const client = createSignalingClient({ room: "r1", role: "offerer", sig: "https://sig.test", WebSocketImpl: WS });
      const sock = instances[0]!;
      let closedReason: string | undefined;
      let closes = 0;
      client.onClosed((r) => {
        closedReason = r;
        closes++;
      });
      sock.fireOpen();

      // First ping goes out at 20s; still within the deadline, not yet reaped.
      vi.advanceTimersByTime(20_000);
      expect(sock.sent).toContain(PING);
      expect(closedReason).toBeUndefined();

      // Past 40s of pong silence → the socket is a ghost: reaped with 4002.
      vi.advanceTimersByTime(40_000);
      expect(closes).toBe(1);
      expect(closedReason).toBe("keepalive-timeout");
      expect(sock.closeCalls.some((c) => c.code === 4002)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
