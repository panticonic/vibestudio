/**
 * SignalingRoom DO tests — prove the dumb two-peer relay with in-memory fakes
 * for the Cloudflare Hibernation API (`acceptWebSocket`/`getWebSockets`/
 * `setWebSocketAutoResponse`), `WebSocketPair`, `WebSocketRequestResponsePair`,
 * and `Response` (Node's undici `Response` throws on status 101, so it is
 * stubbed).
 *
 * Proven here: two role-tagged peers exchange offer/answer + candidates; a join
 * without a role is a 400 (no upgrade); a same-role rejoin EVICTS the incumbent
 * (close 4001) while a different-role join fills the other slot; ice-servers
 * serves the STUN baseline and FAILS LOUD (502) when TURN is provisioned but
 * minting breaks; a dropped peer frees its slot for rejoin; the keepalive ping
 * auto-response is armed on construction.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SignalingRoom, type SignalingRoomEnv } from "./room";

// --- Hibernation-API fakes --------------------------------------------------

class FakeWS {
  sent: string[] = [];
  accepted = false;
  closed = false;
  closeCode?: number;
  closeReason?: string;
  accept(): void {
    this.accepted = true;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
  }
  last<T = { t: string; [k: string]: unknown }>(): T | undefined {
    const s = this.sent[this.sent.length - 1];
    return s === undefined ? undefined : (JSON.parse(s) as T);
  }
}

/** Stand-in for the runtime `WebSocketRequestResponsePair` global. */
class FakeReqRespPair {
  constructor(
    private readonly _request: string,
    private readonly _response: string
  ) {}
  get request(): string {
    return this._request;
  }
  get response(): string {
    return this._response;
  }
}

/** Every server-side socket the DO mints, in creation order. */
let createdServers: FakeWS[] = [];

class FakeWebSocketPair {
  0: FakeWS;
  1: FakeWS;
  constructor() {
    this[0] = new FakeWS(); // client end (returned in the 101 response)
    this[1] = new FakeWS(); // server end (the DO keeps this)
    createdServers.push(this[1]);
  }
}

class FakeResponse {
  status: number;
  webSocket?: unknown;
  headers: Headers;
  private readonly bodyText: string;
  constructor(
    body: unknown,
    init?: { status?: number; headers?: HeadersInit; webSocket?: unknown }
  ) {
    this.status = init?.status ?? 200;
    this.webSocket = init?.webSocket;
    this.headers = new Headers(init?.headers ?? {});
    this.bodyText = typeof body === "string" ? body : "";
  }
  async json(): Promise<unknown> {
    return JSON.parse(this.bodyText);
  }
  async text(): Promise<string> {
    return this.bodyText;
  }
}

/**
 * In-memory stand-in for `DurableObjectStorage` — only the `get`/`put`/`delete`
 * single-key surface the room uses for its pre-join frame buffer. Values are
 * cloned in/out so a stored array cannot be mutated by reference, matching the
 * structured-clone semantics of real DO storage.
 */
class FakeStorage {
  private readonly map = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    const value = this.map.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }
  async put<T>(keyOrEntries: string | Record<string, T>, value?: T): Promise<void> {
    // Mirror the real DO overloads: put(key, value) and the batched put(entries).
    if (typeof keyOrEntries === "string") {
      this.map.set(keyOrEntries, structuredClone(value));
    } else {
      for (const [k, v] of Object.entries(keyOrEntries)) this.map.set(k, structuredClone(v));
    }
  }
  async delete(keys: string | string[]): Promise<boolean | number> {
    if (Array.isArray(keys)) {
      let n = 0;
      for (const k of keys) if (this.map.delete(k)) n++;
      return n;
    }
    return this.map.delete(keys);
  }
  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const prefix = options?.prefix ?? "";
    const out = new Map<string, T>();
    // Real DO storage.list returns keys in UTF-8 lexicographic order.
    for (const key of [...this.map.keys()].sort()) {
      if (key.startsWith(prefix)) out.set(key, structuredClone(this.map.get(key)) as T);
    }
    return out;
  }
}

class FakeState {
  private entries: Array<{ ws: FakeWS; tags: string[] }> = [];
  readonly storage = new FakeStorage();
  /** Captures the arg to `setWebSocketAutoResponse` (the ping/pong keepalive). */
  autoResponse?: FakeReqRespPair;
  acceptWebSocket(ws: FakeWS, tags: string[]): void {
    this.entries.push({ ws, tags });
  }
  /**
   * Mirror the runtime: a CLOSED socket leaves the roster (so `close()` on an
   * evicted incumbent genuinely reclaims its slot), and an optional `tag` filters
   * to sockets accepted with that tag.
   */
  getWebSockets(tag?: string): FakeWS[] {
    return this.entries
      .filter((e) => !e.ws.closed && (tag === undefined || e.tags.includes(tag)))
      .map((e) => e.ws);
  }
  getTags(ws: FakeWS): string[] {
    return this.entries.find((e) => e.ws === ws)?.tags ?? [];
  }
  setWebSocketAutoResponse(pair: FakeReqRespPair): void {
    this.autoResponse = pair;
  }
  /** Mirror the runtime dropping a closed socket from the roster. */
  remove(ws: FakeWS): void {
    this.entries = this.entries.filter((e) => e.ws !== ws);
  }
}

function makeRoom(env: SignalingRoomEnv = { ENVIRONMENT: "test" }): {
  room: SignalingRoom;
  state: FakeState;
} {
  const state = new FakeState();
  const room = new SignalingRoom(state as unknown as DurableObjectState, env);
  return { room, state };
}

// The DO's hibernation handlers take the runtime `WebSocket`; our FakeWS stands
// in for it (only `send`/`accept`/`close` are exercised). Both handlers are
// async now (storage-backed buffer); the relay/notify sends still run
// synchronously before the first await, so callers that do not need the buffer
// path can ignore the returned promise.
const deliver = (room: SignalingRoom, ws: FakeWS, data: string): Promise<void> =>
  room.webSocketMessage(ws as unknown as WebSocket, data);
const drop = (room: SignalingRoom, ws: FakeWS, code: number): Promise<void> =>
  room.webSocketClose(ws as unknown as WebSocket, code, "", false);

type Role = "offerer" | "answerer";

function upgradeRequest(role: Role, roomId = "r1"): Request {
  return {
    url: `https://sig.test/room/${roomId}?role=${role}`,
    method: "GET",
    headers: new Headers({ Upgrade: "websocket" }),
  } as unknown as Request;
}

/** A join upgrade WITHOUT the required `?role=` — the room must reject it 400. */
function upgradeRequestNoRole(roomId = "r1"): Request {
  return {
    url: `https://sig.test/room/${roomId}`,
    method: "GET",
    headers: new Headers({ Upgrade: "websocket" }),
  } as unknown as Request;
}

function iceRequest(roomId = "r1"): Request {
  return {
    url: `https://sig.test/room/${roomId}/ice-servers`,
    method: "GET",
    headers: new Headers(),
  } as unknown as Request;
}

const offer = JSON.stringify({ t: "description", desc: { type: "offer", sdp: "OFFER-SDP" } });
const answer = JSON.stringify({ t: "description", desc: { type: "answer", sdp: "ANSWER-SDP" } });
const candidate = JSON.stringify({
  t: "candidate",
  cand: { candidate: "candidate:1 udp", sdpMid: "0" },
});

beforeEach(() => {
  createdServers = [];
  vi.stubGlobal("WebSocketPair", FakeWebSocketPair);
  vi.stubGlobal("WebSocketRequestResponsePair", FakeReqRespPair);
  vi.stubGlobal("Response", FakeResponse);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SignalingRoom", () => {
  it("relays an offer/answer and candidates between the two role-tagged peers", async () => {
    const { room, state } = makeRoom();

    // The offerer joins its slot, then the answerer fills the other slot.
    await room.fetch(upgradeRequest("offerer"));
    await room.fetch(upgradeRequest("answerer"));
    const [peerA, peerB] = createdServers;
    expect(peerA).toBeDefined();
    expect(peerB).toBeDefined();
    // Both slots are filled — a different-role join fills the second slot.
    expect(state.getWebSockets()).toHaveLength(2);

    // B's arrival notifies the already-present A.
    expect(peerA!.last()).toMatchObject({ t: "peer-joined", peers: 2 });

    // A → offer → relayed verbatim to B (and NOT echoed back to A).
    deliver(room, peerA!, offer);
    expect(peerB!.sent).toContain(offer);
    expect(peerA!.sent).not.toContain(offer);

    // B → answer → relayed to A.
    deliver(room, peerB!, answer);
    expect(peerA!.sent).toContain(answer);

    // Candidates flow both ways.
    deliver(room, peerA!, candidate);
    expect(peerB!.sent).toContain(candidate);
    deliver(room, peerB!, candidate);
    expect(peerA!.sent).toContain(candidate);
  });

  it("buffers an offer + candidates sent before the second peer joins, then flushes them in order", async () => {
    const { room } = makeRoom();

    // Only the offerer (peer A) is in the room — the answerer is still scanning
    // the pairing QR and has not joined yet.
    await room.fetch(upgradeRequest("offerer"));
    const [peerA] = createdServers;
    expect(peerA).toBeDefined();

    // A eagerly trickles its offer and two candidates into the still-empty room.
    // With no counterpart present these are BUFFERED (not dropped for want of a
    // relay target) and are never echoed back to the lone sender.
    const candidate2 = JSON.stringify({
      t: "candidate",
      cand: { candidate: "candidate:2 udp", sdpMid: "0" },
    });
    await deliver(room, peerA!, offer);
    await deliver(room, peerA!, candidate);
    await deliver(room, peerA!, candidate2);
    expect(peerA!.sent).toEqual([]); // nothing relayed back to itself

    // The answerer (peer B) joins. The buffered frames flush onto B's socket in
    // the exact order A sent them — and nothing else leaks onto it.
    await room.fetch(upgradeRequest("answerer"));
    const peerB = createdServers[1]!;
    expect(peerB).toBeDefined();
    expect(peerB.sent).toEqual([offer, candidate, candidate2]);

    // The flush targets only the joiner; A still just gets the peer-joined event.
    expect(peerA!.last()).toMatchObject({ t: "peer-joined", peers: 2 });

    // Live relay resumes normally now that both peers are present.
    await deliver(room, peerB, answer);
    expect(peerA!.sent).toContain(answer);
  });

  it("bounds the pre-join buffer — a flood past the cap is dropped LOUDLY, not grown (negative test)", async () => {
    const { room } = makeRoom();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Only peer A is present; it floods candidates far past the cap while alone.
    await room.fetch(upgradeRequest("offerer"));
    const [peerA] = createdServers;
    const FLOOD = 200;
    const candAt = (i: number): string =>
      JSON.stringify({ t: "candidate", cand: { candidate: `candidate:${i} udp`, sdpMid: "0" } });
    for (let i = 0; i < FLOOD; i++) await deliver(room, peerA!, candAt(i));

    // The overflow was dropped LOUDLY rather than silently swallowed.
    expect(warn).toHaveBeenCalled();

    // Peer B joins: it receives a bounded backlog (never the whole flood),
    // and the frames it does get are the in-order EARLIEST prefix — so the
    // offer and first candidates, the ones that matter, always survive.
    await room.fetch(upgradeRequest("answerer"));
    const peerB = createdServers[1]!;
    expect(peerB.sent.length).toBeGreaterThan(0);
    expect(peerB.sent.length).toBeLessThan(FLOOD);
    peerB.sent.forEach((frame, i) => expect(frame).toBe(candAt(i)));
  });

  it("rejects a join without a role — 400, no upgrade (negative test)", async () => {
    const { room, state } = makeRoom();
    const res = await room.fetch(upgradeRequestNoRole());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("role");
    // No socket entered the roster — the upgrade never happened.
    expect(state.getWebSockets()).toHaveLength(0);
    expect(createdServers).toHaveLength(0);
  });

  it("rejects a join with an invalid role — 400 (negative test)", async () => {
    const { room } = makeRoom();
    const res = await room.fetch(upgradeRequest("spectator" as Role));
    expect(res.status).toBe(400);
    expect(createdServers).toHaveLength(0);
  });

  it("evicts the same-role incumbent and accepts the new socket (last-writer-wins)", async () => {
    const { room, state } = makeRoom();

    // First offerer joins, then a SECOND offerer joins the same room.
    await room.fetch(upgradeRequest("offerer"));
    await room.fetch(upgradeRequest("offerer"));
    const [first, second] = createdServers;

    // The incumbent is evicted with 4001 "superseded by new offerer".
    expect(first!.closed).toBe(true);
    expect(first!.closeCode).toBe(4001);
    expect(first!.closeReason).toBe("superseded by new offerer");
    // The fresh socket takes the slot and is NOT closed; only it remains.
    expect(second!.closed).toBe(false);
    expect(state.getWebSockets()).toEqual([second]);

    // The replacement is a working member: a different-role join now pairs with
    // IT (not the evicted ghost) and relay flows.
    await room.fetch(upgradeRequest("answerer"));
    const answerer = createdServers[2]!;
    expect(second!.last()).toMatchObject({ t: "peer-joined", peers: 2 });
    deliver(room, second!, offer);
    expect(answerer.sent).toContain(offer);
  });

  it("relays only to the opposite role when a same-role socket is still rostered", async () => {
    const { room, state } = makeRoom();
    await room.fetch(upgradeRequest("offerer"));
    await room.fetch(upgradeRequest("answerer"));
    const [offerer, answerer] = createdServers;
    const staleOfferer = new FakeWS();
    state.acceptWebSocket(staleOfferer, ["role:offerer"]);

    await deliver(room, offerer!, offer);

    expect(answerer!.sent).toContain(offer);
    expect(staleOfferer.sent).not.toContain(offer);
  });

  it("drops stale buffered frames from an evicted same-role socket", async () => {
    const { room } = makeRoom();

    // Offerer A joins alone and buffers an offer + candidate (no counterpart).
    await room.fetch(upgradeRequest("offerer"));
    const [peerA] = createdServers;
    await deliver(room, peerA!, offer);
    await deliver(room, peerA!, candidate);

    // A same-role offerer A' evicts A. A's buffered SDP/ICE belongs to the old
    // socket incarnation and must not be replayed to the answerer.
    await room.fetch(upgradeRequest("offerer"));
    const peerAPrime = createdServers[1]!;
    expect(peerA!.closed).toBe(true);
    expect(peerAPrime.closed).toBe(false);

    await room.fetch(upgradeRequest("answerer"));
    const peerB = createdServers[2]!;
    expect(peerB.sent).toEqual([]);
  });

  it("preserves opposite-role buffered frames for a reconnecting socket", async () => {
    const { room } = makeRoom();

    await room.fetch(upgradeRequest("offerer"));
    await room.fetch(upgradeRequest("answerer"));
    const [offerer, answerer] = createdServers;

    // The offerer disappears from the runtime roster before the close callback
    // arrives. The answerer's frame has no deliverable counterpart, so it is
    // buffered with answerer provenance.
    offerer!.close(1006, "network drop");
    await deliver(room, answerer!, answer);

    // A fresh offerer socket should receive the still-useful answerer frame.
    await room.fetch(upgradeRequest("offerer"));
    const offererPrime = createdServers[2]!;
    expect(offererPrime.sent).toEqual([answer]);
  });

  it("arms the ping auto-response on construction so dead sockets reap without waking the DO", () => {
    const { state } = makeRoom();
    expect(state.autoResponse).toBeDefined();
    expect(state.autoResponse!.request).toBe('{"t":"ping"}');
    expect(state.autoResponse!.response).toBe('{"t":"pong"}');
  });

  it("never relays a frame it does not understand (stays a dumb SDP/ICE pipe)", async () => {
    const { room } = makeRoom();
    await room.fetch(upgradeRequest("offerer"));
    await room.fetch(upgradeRequest("answerer"));
    const [peerA, peerB] = createdServers;
    const before = peerB!.sent.length;

    deliver(room, peerA!, JSON.stringify({ t: "evict-peer" }));
    deliver(room, peerA!, "not even json");

    expect(peerB!.sent.length).toBe(before);
  });

  it("frees a dropped peer's slot so it can rejoin for ICE-restart", async () => {
    const { room, state } = makeRoom();
    await room.fetch(upgradeRequest("offerer"));
    await room.fetch(upgradeRequest("answerer"));
    const [peerA, peerB] = createdServers;

    // Peer A's (offerer) signaling socket drops.
    drop(room, peerA!, 1006);
    expect(peerB!.last()).toMatchObject({ t: "peer-left", peers: 1 });
    state.remove(peerA!); // runtime drops the closed socket from the roster

    // The room persists; the offerer rejoins its now-free slot (no eviction of
    // the surviving answerer, which is a different role).
    await room.fetch(upgradeRequest("offerer"));
    expect(state.getWebSockets()).toHaveLength(2);
    const rejoined = createdServers[2]!;
    expect(rejoined.closed).toBe(false); // accepted, not refused
    expect(peerB!.closed).toBe(false); // the answerer was untouched
  });

  it("serves the free STUN baseline when TURN is not provisioned", async () => {
    const { room } = makeRoom({ ENVIRONMENT: "test" });
    const res = await room.fetch(iceRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-signaling-turn")).toBe("stun-only");
    const body = (await res.json()) as { iceServers: Array<{ urls: string }> };
    expect(body.iceServers).toEqual([{ urls: "stun:stun.cloudflare.com:3478" }]);
  });

  it("mints Cloudflare TURN credentials with the generate-ice-servers endpoint", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        iceServers: [
          {
            urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
            username: "user",
            credential: "pass",
          },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { room } = makeRoom({
      ENVIRONMENT: "test",
      TURN_KEY_ID: "key-1",
      TURN_KEY_API_TOKEN: "secret-1",
    });
    const res = await room.fetch(iceRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-signaling-turn")).toBe("minted");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://rtc.live.cloudflare.com/v1/turn/keys/key-1/credentials/generate-ice-servers",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ ttl: 86400 }),
      })
    );
    const body = (await res.json()) as { iceServers: Array<{ urls: string[] }> };
    expect(body.iceServers[0]).toMatchObject({
      urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
      username: "user",
      credential: "pass",
    });
  });

  it("FAILS LOUD (502) when TURN is provisioned but minting breaks — negative test", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        statusText: "Server Error",
        text: async () => "upstream down",
      }))
    );
    const { room } = makeRoom({
      ENVIRONMENT: "test",
      TURN_KEY_ID: "key-1",
      TURN_KEY_API_TOKEN: "secret-1",
    });
    const res = await room.fetch(iceRequest());
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("mint failed");
  });

  it("rejects a non-websocket request to the room path", async () => {
    const { room } = makeRoom();
    const res = await room.fetch({
      url: "https://sig.test/room/r1",
      method: "GET",
      headers: new Headers(),
    } as unknown as Request);
    expect(res.status).toBe(426);
  });
});
