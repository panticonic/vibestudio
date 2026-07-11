/**
 * SignalingRoom — a UUID-addressed rendezvous Durable Object that blind-relays
 * SDP/ICE between exactly two peers (plan §2).
 *
 * It is deliberately DUMB: it never parses SDP, never validates candidates, and
 * holds no security state. Security lives in the QR DTLS-fingerprint pin checked
 * by the transport (`webrtcClient.ts`), not here. A signaling box that swapped a
 * fingerprint would simply be detected and rejected by the pinned peer.
 *
 * The room PERSISTS for the connection's lifetime via the WebSocket Hibernation
 * API (`acceptWebSocket`/`webSocketMessage`/`webSocketClose`): it costs no
 * compute while idle but keeps the two sockets alive so it can carry an
 * ICE-restart, not just the first connect. All roster state is derived from
 * `getWebSockets()` + tags, so nothing is lost across hibernation and nothing
 * sensitive is persisted.
 *
 * Relaying is JOIN-ORDER INDEPENDENT. The offerer typically reaches the room
 * before the answerer has finished scanning the pairing QR, so if a peer sends
 * its offer/candidates while the other slot is still empty those frames are
 * BUFFERED (in DO storage, so the buffer also survives a hibernation during the
 * scan gap) and FLUSHED — in order — the instant the second peer joins, rather
 * than dropped for want of a relay target. The buffer is ephemeral: it is
 * bounded (`MAX_BUFFERED_FRAMES`; excess is dropped loudly, never grown) and
 * cleared when the room empties. Buffered frames carry only source-role
 * provenance, so a same-role reconnect drops that old role's stale SDP/ICE
 * while preserving any opposite-role frames that are still useful to the new
 * socket. The frames stay opaque — the room buffers bytes, it does not parse
 * SDP.
 *
 * The two peers fill ROLE-KEYED slots: a join MUST declare `?role=offerer` or
 * `?role=answerer` (missing/invalid → HTTP 400, no upgrade). Relaying always
 * targets the opposite role; the role also gives a deterministic slot and lets
 * a dropped peer rejoin the SAME slot to drive ICE-restart.
 *
 * SAME-ROLE JOINS EVICT THE INCUMBENT (last-writer-wins, on purpose). With one
 * room per paired device, a second socket claiming a role that is already held
 * is BY CONSTRUCTION the same party reconnecting — its own ghost after an
 * unclean drop, or a restarted server re-arming the answerer slot. The old
 * socket is closed (code 4001, "superseded by new <role>") and the fresh one
 * takes the slot, instead of the reconnect wedging behind a dead socket until
 * Cloudflare reaps the TCP. A different-role join simply fills the other slot.
 *
 * A hibernated socket answers keepalive pings on its own via the runtime
 * auto-response (`setWebSocketAutoResponse`, armed in the constructor), so a
 * dead socket is detected in seconds (the client reaps a socket that goes 40s
 * without a pong) without ever waking the DO. `ping`/`pong` are keepalive-only:
 * they are NOT in RELAYED_TYPES and never reach `webSocketMessage`.
 */

import { RELAYED_TYPES, type SignalingRole, type SignalingServerMessage } from "./protocol";
import { mintIceServers, turnIsProvisioned, type TurnEnv } from "./turn";

/** RFC 6455 private-use close code: the slot was reclaimed by a same-role join. */
const CLOSE_SUPERSEDED = 4001;
/**
 * DO-storage key holding the ordered frames a peer sent before its counterpart
 * joined. Flushed to the second joiner, then deleted; also wiped when the room
 * empties so it is never replayed into a later occupancy.
 */
// One storage key PER buffered frame (not one growing array): an append is O(1)
// and a single large SDP offer can't push the whole buffer past the 128 KiB
// per-value storage cap. The zero-padded seq orders the keys lexicographically.
const PENDING_FRAME_PREFIX = "pending-frame:";
const PENDING_SEQ_KEY = "pending-seq";
interface PendingFrame {
  sourceRole: SignalingRole;
  text: string;
}
/**
 * Hard cap on pre-join buffered frames. An offer plus a session's worth of
 * trickled ICE candidates fits comfortably; beyond this the room is being
 * flooded, so excess is dropped LOUDLY rather than letting storage grow without
 * bound.
 */
const MAX_BUFFERED_FRAMES = 64;

/**
 * Durable "a real pairing has touched this room" marker, set on the first WS
 * join. TURN credentials are only minted for an armed (or currently occupied)
 * room, so a drive-by `GET /room/<invented-uuid>/ice-servers` cannot farm
 * operator-billed creds without first joining. Cleared when the room empties so
 * a recycled room id starts cold again.
 */
const PAIRING_ARMED_KEY = "pairing-armed";
/**
 * One-shot grace for the offerer's FIRST ice-servers fetch, which races its own
 * WS join (the client dials the socket then immediately GETs ice-servers, and
 * the two requests can reach this DO in either order). We cannot distinguish
 * that legitimate pre-join fetch from an abuser without auth — the QR-only model
 * has none — so we grant exactly one cold mint per room and lean on the per-IP
 * rate limit + short TTL to bound farming. Cleared with the room.
 */
const ICE_COLD_GRANT_KEY = "ice-cold-grant-used";
/** Fixed-window ice-servers rate limit (generous — trips only on obvious abuse). */
const ICE_RATE_WINDOW_MS = 60_000;
const ICE_RATE_MAX_PER_IP = 30;
const ICE_RATE_MAX_PER_ROOM = 120;

export interface SignalingRoomEnv extends TurnEnv {
  ENVIRONMENT?: string;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/**
 * Throw-safe raw send. Returns whether the socket accepted the bytes: a gone or
 * closing socket throws and yields `false` (the close handler reconciles the
 * roster). Relay uses this directly so it forwards the ORIGINAL bytes verbatim
 * without re-serializing.
 */
function sendRaw(ws: WebSocket, data: string): boolean {
  try {
    ws.send(data);
    return true;
  } catch {
    return false;
  }
}

/** Throw-safe send of a typed server message (lifecycle notifications). */
function send(ws: WebSocket, message: SignalingServerMessage): void {
  sendRaw(ws, JSON.stringify(message));
}

export class SignalingRoom implements DurableObject {
  /** Overridable clock for tests. */
  now: () => number = () => Date.now();
  /** Room id (the rendezvous secret), captured from the first request URL so
   * every log line is attributable in `wrangler tail`. */
  private roomId = "?";
  /** Per-IP fixed-window ice-servers counters. In-memory: lost on hibernation
   * (fail-open), which is fine — the durable arm marker + TTL are the real gate. */
  private readonly iceRateByIp = new Map<string, { windowStart: number; count: number }>();
  /** Room-wide ice-servers counter (all IPs) for the same fixed window. */
  private iceRateRoom = { windowStart: 0, count: 0 };

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: SignalingRoomEnv
  ) {
    // Arm the hibernation-compatible keepalive: the runtime answers `{"t":"ping"}`
    // with `{"t":"pong"}` WITHOUT waking the DO, so a hibernated socket still
    // proves liveness and a dead one is reaped in seconds (the client pings every
    // 20s and treats 40s of silence as death). ping/pong stay off the relay path
    // (not in RELAYED_TYPES) — they never reach the peer.
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}')
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);

    // Expect /room/:roomId  or  /room/:roomId/ice-servers
    if (segments[0] !== "room" || !segments[1]) {
      return jsonResponse({ error: "not found" }, 404);
    }
    // Capture the room id for attributable logging (same DO == same room).
    this.roomId = segments[1];

    if (segments[2] === "ice-servers") {
      return this.handleIceServers(request);
    }

    const upgrade = request.headers.get("Upgrade");
    if (!upgrade || upgrade.toLowerCase() !== "websocket") {
      return jsonResponse({ error: "expected websocket upgrade" }, 426);
    }

    // A join MUST declare which slot it fills — the room cannot pair or evict
    // without knowing the role. Missing/invalid is a hard 400 (no upgrade), not
    // a tolerated default.
    const role = url.searchParams.get("role");
    if (role !== "offerer" && role !== "answerer") {
      return jsonResponse({ error: "join requires ?role=offerer|answerer" }, 400);
    }
    return this.handleJoin(role);
  }

  /**
   * Mint per-session ICE servers, gated so unauthenticated cred-farming can't
   * bill the operator for TURN. The gate is a no-op when TURN is unprovisioned
   * (STUN-only always works). When TURN IS provisioned we require the room to be
   * occupied or previously armed by a real WS join — with a one-shot grace for
   * the offerer's first fetch racing its own join — plus a per-IP + per-room
   * rate limit. TTL is a connection-lifetime backstop (see turn.ts), not 24h.
   */
  private async handleIceServers(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return jsonResponse({ error: "method not allowed" }, 405);
    }
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    if (!this.allowIceRate(ip)) {
      console.warn(`[signaling] room=${this.roomId} ice-servers rate-limited ip=${ip}`);
      return jsonResponse({ error: "too many ice-servers requests" }, 429);
    }

    // STUN-only deploys mint nothing, so there is nothing to gate — always serve.
    if (!turnIsProvisioned(this.env)) {
      const { iceServers } = await mintIceServers(this.env);
      console.log(`[signaling] room=${this.roomId} ice-servers stun-only`);
      return this.iceResponse(iceServers, false);
    }

    // Gate: an occupied or armed room is a genuine pairing; otherwise grant a
    // single cold mint (the offerer's pre-join race) and refuse the rest.
    const occupied = this.state.getWebSockets().length > 0;
    const armed = (await this.state.storage.get<number>(PAIRING_ARMED_KEY)) !== undefined;
    if (!occupied && !armed) {
      const coldUsed = (await this.state.storage.get<boolean>(ICE_COLD_GRANT_KEY)) === true;
      if (coldUsed) {
        console.warn(
          `[signaling] room=${this.roomId} ice-servers denied (unpaired, cold grant spent) ip=${ip}`
        );
        return jsonResponse({ error: "room has no active pairing" }, 403);
      }
      await this.state.storage.put(ICE_COLD_GRANT_KEY, true);
      console.warn(`[signaling] room=${this.roomId} ice-servers cold grant (pre-join) ip=${ip}`);
    }

    try {
      const { iceServers } = await mintIceServers(this.env);
      console.log(`[signaling] room=${this.roomId} ice-servers minted TURN ip=${ip}`);
      return this.iceResponse(iceServers, true);
    } catch (error) {
      // Fail loud: TURN is provisioned but minting broke. The peer's
      // `fetchIceServers()` sees a non-200 and rejects.
      console.warn(`[signaling] room=${this.roomId} ice-servers mint failed: ${String(error)}`);
      return jsonResponse({ error: `ice-servers: ${String(error)}` }, 502);
    }
  }

  private iceResponse(iceServers: unknown, turn: boolean): Response {
    return new Response(JSON.stringify({ iceServers }), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        // Announce the STUN-only baseline so a missing TURN backstop is visible
        // (plan: "every surviving fallback announces itself").
        "x-signaling-turn": turn ? "minted" : "stun-only",
      },
    });
  }

  /** Fixed-window per-IP + per-room rate limit for ice-servers. */
  private allowIceRate(ip: string): boolean {
    const now = this.now();
    const room = this.iceRateRoom;
    if (now - room.windowStart >= ICE_RATE_WINDOW_MS) {
      room.windowStart = now;
      room.count = 0;
    }
    const perIp = this.iceRateByIp.get(ip);
    let ipWindow = perIp;
    if (!ipWindow || now - ipWindow.windowStart >= ICE_RATE_WINDOW_MS) {
      ipWindow = { windowStart: now, count: 0 };
      this.iceRateByIp.set(ip, ipWindow);
    }
    if (room.count >= ICE_RATE_MAX_PER_ROOM || ipWindow.count >= ICE_RATE_MAX_PER_IP) {
      return false;
    }
    room.count += 1;
    ipWindow.count += 1;
    return true;
  }

  private async handleJoin(role: SignalingRole): Promise<Response> {
    const roleTag = `role:${role}`;
    const otherTag = role === "offerer" ? "role:answerer" : "role:offerer";
    const { 0: client, 1: server } = new WebSocketPair();

    // Same-role join = the same party reconnecting (§4). Evict any incumbent
    // holding this role so the fresh socket owns the slot, rather than the
    // reconnect wedging behind a dead socket. Closed sockets leave the roster,
    // so the slot is genuinely reclaimed.
    for (const incumbent of this.state.getWebSockets(roleTag)) {
      console.warn(`[signaling] room=${this.roomId} evict incumbent role=${role} (superseded)`);
      try {
        incumbent.close(CLOSE_SUPERSEDED, `superseded by new ${role}`);
      } catch {
        // Already closing; the close handler reconciles the roster.
      }
    }
    await this.clearPendingFrames(role);

    this.state.acceptWebSocket(server, [roleTag]);
    // A real peer has joined: arm the room so ice-servers minting is allowed for
    // this genuine pairing (see PAIRING_ARMED_KEY / handleIceServers).
    await this.state.storage.put(PAIRING_ARMED_KEY, this.now());

    // The genuine counterpart is the OTHER role's socket (evicted same-role
    // ghosts are excluded by construction). Tell it a peer arrived so the
    // answerer knows to expect an offer.
    const others = this.state.getWebSockets(otherTag);
    const peers = others.length + 1;
    console.log(`[signaling] room=${this.roomId} join role=${role} peers=${peers}`);
    for (const other of others) {
      send(other, { t: "peer-joined", peers });
    }

    // This join completes the pair: deliver anything the counterpart sent while
    // it was alone, in order, before any live frame can reach the new joiner.
    if (others.length > 0) {
      await this.flushPendingTo(server, role === "offerer" ? "answerer" : "offerer");
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  private roleTagForSocket(ws: WebSocket): "role:offerer" | "role:answerer" | null {
    if (this.state.getWebSockets("role:offerer").includes(ws)) return "role:offerer";
    if (this.state.getWebSockets("role:answerer").includes(ws)) return "role:answerer";
    return null;
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    let type: unknown;
    try {
      type = (JSON.parse(text) as { t?: unknown }).t;
    } catch {
      console.warn("[signaling] dropping non-JSON frame");
      return;
    }
    if (typeof type !== "string" || !RELAYED_TYPES.has(type)) {
      console.warn(`[signaling] dropping unrelayable frame t=${String(type)}`);
      return;
    }
    // Blind relay: forward the original bytes verbatim to the opposite-role
    // peer. We parsed only the top-level `t` to route; the SDP/ICE payload is
    // never read.
    const roleTag = this.roleTagForSocket(ws);
    if (!roleTag) {
      console.warn("[signaling] dropping frame from untagged socket");
      return;
    }
    const otherTag = roleTag === "role:offerer" ? "role:answerer" : "role:offerer";
    const others = this.state.getWebSockets(otherTag).filter((other) => other !== ws);
    if (others.length === 0) {
      // No counterpart yet (the answerer is still arriving). Hold the frame so
      // it is delivered on join instead of dropped — the connection no longer
      // depends on who reaches the room first.
      await this.bufferFrame(roleTag === "role:offerer" ? "offerer" : "answerer", text);
      return;
    }
    // Throw-safe relay: a counterpart that is mid-close throws on send. If NO
    // counterpart accepted the frame (the sole peer is already gone), fall back
    // to the pre-join buffer so the frame is delivered to a genuine (re)joiner
    // instead of silently lost.
    let delivered = 0;
    for (const other of others) if (sendRaw(other, text)) delivered++;
    if (delivered === 0) {
      await this.bufferFrame(roleTag === "role:offerer" ? "offerer" : "answerer", text);
    } else {
      console.log(`[signaling] room=${this.roomId} relay from=${roleTag} type=${type} -> ${delivered}`);
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean
  ): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // Already closing.
    }
    // The room is NOT destroyed — the slot is freed for a rejoin (ICE-restart).
    const others = this.state.getWebSockets().filter((w) => w !== ws);
    console.log(`[signaling] room=${this.roomId} leave code=${code} peers=${others.length}`);
    for (const other of others) {
      send(other, { t: "peer-left", peers: others.length });
    }
    if (others.length === 0) {
      // The room is now empty. Drop any frames a solo peer left buffered (an
      // offerer that gave up before the answerer arrived) so they are never
      // replayed into a later occupancy of this room id. Disarm too, so a
      // recycled room id must be re-armed by a real join before minting TURN.
      await this.clearPendingFrames();
      await this.state.storage.delete([PAIRING_ARMED_KEY, ICE_COLD_GRANT_KEY]);
    }
  }

  webSocketError(ws: WebSocket, error: unknown): void {
    console.warn("[signaling] websocket error", error);
    try {
      ws.close(1011, "internal error");
    } catch {
      // Already closing.
    }
  }

  /**
   * Append a frame to the ordered pre-join buffer. Bounded: once the cap is hit
   * the frame is dropped with a loud warning rather than growing storage without
   * limit (the offer and early candidates — all that is needed to connect —
   * arrive first and are well within the cap).
   */
  private async bufferFrame(sourceRole: SignalingRole, text: string): Promise<void> {
    const pending = await this.state.storage.list<PendingFrame>({ prefix: PENDING_FRAME_PREFIX });
    if (pending.size >= MAX_BUFFERED_FRAMES) {
      console.warn(
        `[signaling] room=${this.roomId} pre-join buffer full (cap ${MAX_BUFFERED_FRAMES}); dropping frame until the second peer joins`
      );
      return;
    }
    const seq = (await this.state.storage.get<number>(PENDING_SEQ_KEY)) ?? 0;
    // One batched put: the frame and the advanced sequence counter commit together
    // (atomic — no torn state where the frame is stored but the counter didn't move).
    await this.state.storage.put({
      [PENDING_FRAME_PREFIX + String(seq).padStart(6, "0")]: { sourceRole, text },
      [PENDING_SEQ_KEY]: seq + 1,
    });
  }

  /** Delete buffered frames, optionally only those sourced by one role. */
  private async clearPendingFrames(sourceRole?: SignalingRole): Promise<void> {
    const pending = await this.state.storage.list<PendingFrame>({ prefix: PENDING_FRAME_PREFIX });
    const keys =
      sourceRole === undefined
        ? [...pending.keys()]
        : [...pending.entries()]
            .filter(([, frame]) => frame.sourceRole === sourceRole)
            .map(([key]) => key);
    if (keys.length > 0) await this.state.storage.delete(keys);
    if (sourceRole === undefined) await this.state.storage.delete(PENDING_SEQ_KEY);
  }

  /**
   * Deliver the buffered frames to the freshly joined second peer, in the order
   * they were sent, then clear the buffer. The sends run as a synchronous burst
   * so the backlog lands before any live relay; the delete follows so a crash
   * mid-flush re-delivers (duplicate offer/candidate is harmless) rather than
   * losing the offer.
   */
  private async flushPendingTo(ws: WebSocket, sourceRole: SignalingRole): Promise<void> {
    // list() returns keys in lexicographic order; the zero-padded seq makes that
    // numeric, so send order == arrival order.
    const pending = await this.state.storage.list<PendingFrame>({ prefix: PENDING_FRAME_PREFIX });
    if (pending.size === 0) return;
    const sentKeys: string[] = [];
    for (const [key, frame] of pending) {
      if (frame.sourceRole !== sourceRole) continue;
      ws.send(frame.text);
      sentKeys.push(key);
    }
    if (sentKeys.length > 0) await this.state.storage.delete(sentKeys);
    if ((await this.state.storage.list({ prefix: PENDING_FRAME_PREFIX })).size === 0) {
      await this.state.storage.delete(PENDING_SEQ_KEY);
    }
  }
}
