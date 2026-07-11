/**
 * Signaling client — the peer side of the `apps/signaling` Durable Object
 * (workstream B). It implements the transport-facing `SignalingClient` contract
 * (`webrtcSignaling.ts`) over a WebSocket to a UUID room, plus one HTTP GET for
 * per-session TURN/STUN credentials.
 *
 * Two surfaces, one job each (no redundancy):
 *   - **WebSocket** (`WebSocketImpl`) — blind-relays our SDP/ICE to the peer and
 *     delivers the peer's back, plus room lifecycle
 *     (`peer-joined`/`peer-left`). The room PERSISTS, so a reconnect re-joins the
 *     same room to re-signal a fresh pipe (a full re-establish, no re-pair — an
 *     in-place ICE-restart isn't supported by the answerer stack; see
 *     docs/webrtc-ice-restart-findings.md). A join declares its slot via a
 *     required `role=offerer|answerer`
 *     query param; a same-role reconnect evicts our own ghost (§4). Keepalive is
 *     out-of-band: we ping every 20s (the DO auto-responds with a pong without
 *     waking) and reap a socket that goes 40s without a pong. ping/pong never
 *     relay to the peer.
 *   - **HTTP GET** (`fetchImpl`) — `fetchIceServers()` pulls the room's
 *     per-session ICE config. A request/response cred fetch maps onto an HTTP
 *     GET and fails loud on a non-200 (no racy push waiter on the relay socket).
 *
 * Both the WebSocket constructor and fetch are INJECTABLE so this runs unchanged
 * on Node (server, `ws`/built-in `WebSocket`), browser, and React Native, and is
 * fully unit-testable with an in-memory fake fabric (`webrtcSignalingClient.test.ts`).
 */

import type { RtcIceCandidate, RtcIceServer, RtcSessionDescription } from "./webrtcPeer.js";
import type { SignalingClient } from "./webrtcSignaling.js";

// --- Signaling wire protocol -------------------------------------------------
// These mirror `apps/signaling/src/protocol.ts` field-for-field. They are
// duplicated here (not imported) ON PURPOSE: `apps/signaling` is a standalone
// Cloudflare Worker with its own build boundary and is NOT a dependency of this
// foundational package. The wire contract IS the JSON shape; both ends declare
// it locally. Any change here MUST be mirrored in the room's protocol.ts.

/** Which rendezvous slot a peer fills (mirrors `SignalingRole` in the room). */
export type SignalingRole = "offerer" | "answerer";

interface DescriptionMessage {
  t: "description";
  desc: RtcSessionDescription;
}
interface CandidateMessage {
  t: "candidate";
  cand: RtcIceCandidate;
}
interface PeerLifecycleMessage {
  t: "peer-joined" | "peer-left";
  peers: number;
}
/** Reply the DO auto-responds with to our keepalive `{"t":"ping"}`. */
interface PongMessage {
  t: "pong";
}
type SignalingServerMessage =
  | DescriptionMessage
  | CandidateMessage
  | PeerLifecycleMessage
  | PongMessage;

interface IceServersResponse {
  iceServers: RtcIceServer[];
}

/** Minimal WHATWG `WebSocket` surface used here (browser/RN/Node all expose it). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", handler: () => void): void;
  addEventListener(type: "close", handler: (ev: { code?: number; reason?: string }) => void): void;
  addEventListener(type: "error", handler: (ev: unknown) => void): void;
  addEventListener(type: "message", handler: (ev: { data: unknown }) => void): void;
}

export interface WebSocketCtor {
  new (url: string): WebSocketLike;
}

export interface SignalingClientOptions {
  /** Rendezvous room id (the unguessable UUID from the pairing link `room=`). */
  room: string;
  /**
   * Which rendezvous slot this peer fills. Appended to the join URL as
   * `?role=`; the DO requires it (missing → HTTP 400) and evicts an incumbent
   * holding the same role (§4). The offerer (client/device) uses `"offerer"`,
   * the paired server's answerer pipe uses `"answerer"`.
   */
  role: SignalingRole;
  /** Signaling endpoint base from the pairing link `sig=` (http(s) or ws(s)). */
  sig: string;
  /** Injected `fetch` (defaults to `globalThis.fetch`). Used by `fetchIceServers()`. */
  fetchImpl?: typeof fetch;
  /** Injected WebSocket constructor (defaults to `globalThis.WebSocket`). */
  WebSocketImpl?: WebSocketCtor;
  /** Log prefix for diagnostics. */
  logPrefix?: string;
}

const READY_STATE_OPEN = 1;

/** Out-of-band keepalive: ping cadence and the pong-silence deadline. */
const PING_INTERVAL_MS = 20_000;
const PONG_TIMEOUT_MS = 40_000;
/**
 * Deadline on the one-shot TURN/STUN credential fetch. GENEROUS on purpose: a
 * cold Cloudflare Realtime TURN mint plus a slow relay round-trip can take a
 * few seconds, so this is a fail-LOUD backstop, not an SLA — it exists only so
 * a hung `fetch` (a wedged worker that accepts the TCP connection but never
 * responds) can no longer PARK the answerer's single establish pipeline
 * (`establishInFlight`) and leave the room permanently deaf. On expiry the
 * fetch aborts and rejects; the caller retries (offerer → backoff reestablish;
 * answerer → establish fails → back to lazy-armed, next offer re-drives it).
 */
const ICE_SERVERS_FETCH_TIMEOUT_MS = 20_000;

/** Apply the `/room/:roomId{suffix}` path to the `sig` base — shared by both builders. */
function roomUrl(sig: string, room: string, suffix: string): URL {
  const url = new URL(sig);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/room/${encodeURIComponent(room)}${suffix}`;
  return url;
}

/** Build the `ws(s)://…/room/:roomId?role=<role>` URL from the `sig` base. */
function toRoomWsUrl(sig: string, room: string, role: SignalingRole): string {
  const url = roomUrl(sig, room, "");
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`Unsupported signaling scheme: ${url.protocol} (expected http(s)/ws(s))`);
  }
  // The DO requires the role to slot/evict the join; it is part of the join URL,
  // not a WS frame (the upgrade must be rejected with 400 before any socket).
  url.searchParams.set("role", role);
  return url.toString();
}

/** Build the `http(s)://…/room/:roomId/ice-servers` URL from the `sig` base. */
function toIceServersHttpUrl(sig: string, room: string): string {
  const url = roomUrl(sig, room, "/ice-servers");
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  else if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported signaling scheme: ${url.protocol} (expected http(s)/ws(s))`);
  }
  return url.toString();
}

function decodeMessageData(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data as ArrayBufferView as Uint8Array);
  }
  return null;
}

export function createSignalingClient(options: SignalingClientOptions): SignalingClient {
  const { room, sig, role } = options;
  const log = options.logPrefix ?? "[signaling-client]";
  const WebSocketImpl =
    options.WebSocketImpl ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  if (!WebSocketImpl) {
    throw new Error("No WebSocket implementation available (pass WebSocketImpl)");
  }
  const fetchImpl = options.fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch;

  const wsUrl = toRoomWsUrl(sig, room, role);
  const iceUrl = toIceServersHttpUrl(sig, room);

  const descriptionHandlers = new Set<(desc: RtcSessionDescription) => void>();
  const candidateHandlers = new Set<(candidate: RtcIceCandidate) => void>();
  const closedHandlers = new Set<(reason?: string) => void>();
  const openHandlers = new Set<() => void>();
  const peerJoinedHandlers = new Set<() => void>();
  // Frames that land before the transport has registered a handler are buffered
  // and flushed on first subscription (the offerer's answer can arrive while the
  // transport is still awaiting `provider.create()`). This is an ordering buffer,
  // not a failure backstop.
  const pendingDescriptions: RtcSessionDescription[] = [];
  const pendingCandidates: RtcIceCandidate[] = [];

  let closed = false;
  let closeReason: string | undefined;

  // Out-of-band keepalive state. The DO auto-responds to `{"t":"ping"}` with a
  // pong even while hibernated, so a live socket always answers within the
  // window; `lastPongAt` older than the deadline means the socket is a ghost.
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let lastPongAt = 0;

  const ws = new WebSocketImpl(wsUrl);

  function stopKeepalive(): void {
    if (pingTimer !== undefined) {
      clearInterval(pingTimer);
      pingTimer = undefined;
    }
  }

  function startKeepalive(): void {
    lastPongAt = Date.now();
    pingTimer = setInterval(() => {
      if (closed) return;
      if (ws.readyState !== READY_STATE_OPEN) return;
      if (Date.now() - lastPongAt > PONG_TIMEOUT_MS) {
        // No pong within the deadline — the socket is dead (hibernated-but-alive
        // sockets answer via auto-response). Reap it and fire closed handling so
        // the transport re-establishes instead of waiting on TCP to notice.
        closeReason = closeReason ?? "keepalive-timeout";
        try {
          ws.close(4002, "keepalive timeout");
        } catch {
          /* already closing */
        }
        fireClosed(closeReason);
        return;
      }
      try {
        ws.send(JSON.stringify({ t: "ping" }));
      } catch {
        /* a broken send surfaces via the error/close handlers */
      }
    }, PING_INTERVAL_MS);
    // Don't hold the Node event loop open just to ping an otherwise idle room.
    (pingTimer as unknown as { unref?: () => void }).unref?.();
  }

  let resolveOpen!: () => void;
  let rejectOpen!: (error: unknown) => void;
  const openPromise = new Promise<void>((resolve, reject) => {
    resolveOpen = resolve;
    rejectOpen = reject;
  });
  // `openPromise` is only awaited by an actual send. Mark it handled so a client
  // that closes (or only calls `fetchIceServers`) without ever sending does not
  // surface an unhandled rejection — a real `await openPromise` still rejects.
  void openPromise.catch(() => {});
  let opened = false;

  ws.addEventListener("open", () => {
    opened = true;
    startKeepalive();
    resolveOpen();
    // Proven-live: the room is reachable. Supervisors reset their rejoin
    // backoff here (never on construction — the WS is created eagerly and this
    // constructor never throws for an unreachable host).
    for (const handler of [...openHandlers]) {
      try {
        handler();
      } catch (error) {
        console.warn(`${log} open handler threw`, error);
      }
    }
  });

  ws.addEventListener("error", (ev) => {
    console.warn(`${log} websocket error`, ev);
    if (!opened) rejectOpen(new Error("Signaling websocket failed before open"));
  });

  ws.addEventListener("close", (ev) => {
    const reason = closeReason ?? ev?.reason ?? `code ${ev?.code ?? "?"}`;
    if (!opened) rejectOpen(new Error(`Signaling websocket closed before open: ${reason}`));
    fireClosed(reason);
  });

  ws.addEventListener("message", (ev) => {
    const text = decodeMessageData(ev.data);
    if (text === null) {
      console.warn(`${log} dropping non-text frame`);
      return;
    }
    let message: SignalingServerMessage;
    try {
      message = JSON.parse(text) as SignalingServerMessage;
    } catch (error) {
      console.warn(`${log} dropping malformed frame`, error);
      return;
    }
    switch (message.t) {
      case "description":
        emitDescription((message as DescriptionMessage).desc);
        return;
      case "candidate":
        emitCandidate((message as CandidateMessage).cand);
        return;
      case "pong":
        // Keepalive reply (auto-responded by the DO). Proof of life — reset the
        // liveness deadline. Never relayed; the transport never sees it.
        lastPongAt = Date.now();
        return;
      case "peer-joined":
        // The peer just slotted into the room. The offerer re-sends its current
        // offer on this (a late-arriving server never saw the first one).
        for (const handler of [...peerJoinedHandlers]) {
          try {
            handler();
          } catch (error) {
            console.warn(`${log} peer-joined handler threw`, error);
          }
        }
        return;
      case "peer-left":
        // Lifecycle hint — the transport drives offer/answer itself; nothing to do.
        return;
      default:
        console.warn(`${log} unknown frame`, message);
        return;
    }
  });

  function emitDescription(desc: RtcSessionDescription): void {
    if (descriptionHandlers.size === 0) {
      pendingDescriptions.push(desc);
      return;
    }
    for (const handler of descriptionHandlers) {
      try {
        handler(desc);
      } catch (error) {
        console.warn(`${log} description handler threw`, error);
      }
    }
  }

  function emitCandidate(candidate: RtcIceCandidate): void {
    if (candidateHandlers.size === 0) {
      pendingCandidates.push(candidate);
      return;
    }
    for (const handler of candidateHandlers) {
      try {
        handler(candidate);
      } catch (error) {
        console.warn(`${log} candidate handler threw`, error);
      }
    }
  }

  function fireClosed(reason?: string): void {
    if (closed) return;
    closed = true;
    stopKeepalive();
    for (const handler of closedHandlers) {
      try {
        handler(reason);
      } catch (error) {
        console.warn(`${log} closed handler threw`, error);
      }
    }
  }

  async function sendFrame(frame: DescriptionMessage | CandidateMessage): Promise<void> {
    if (closed) throw new Error("Signaling room is closed");
    if (!opened) await openPromise;
    if (ws.readyState !== READY_STATE_OPEN) {
      throw new Error("Signaling websocket is not open");
    }
    ws.send(JSON.stringify(frame));
  }

  return {
    async sendDescription(desc: RtcSessionDescription): Promise<void> {
      await sendFrame({ t: "description", desc });
    },

    async sendCandidate(candidate: RtcIceCandidate): Promise<void> {
      await sendFrame({ t: "candidate", cand: candidate });
    },

    onDescription(handler: (desc: RtcSessionDescription) => void): () => void {
      descriptionHandlers.add(handler);
      if (pendingDescriptions.length > 0) {
        for (const desc of pendingDescriptions.splice(0)) handler(desc);
      }
      return () => descriptionHandlers.delete(handler);
    },

    onCandidate(handler: (candidate: RtcIceCandidate) => void): () => void {
      candidateHandlers.add(handler);
      if (pendingCandidates.length > 0) {
        for (const candidate of pendingCandidates.splice(0)) handler(candidate);
      }
      return () => candidateHandlers.delete(handler);
    },

    async fetchIceServers(): Promise<RtcIceServer[]> {
      if (!fetchImpl) {
        throw new Error("No fetch implementation available (pass fetchImpl)");
      }
      // GENEROUS abort deadline (see ICE_SERVERS_FETCH_TIMEOUT_MS): a hung fetch
      // must never park the establish pipeline. AbortController.abort() rejects
      // the fetch so the caller's retry path runs instead of wedging forever.
      const controller = new AbortController();
      const timer: ReturnType<typeof setTimeout> = setTimeout(
        () => controller.abort(),
        ICE_SERVERS_FETCH_TIMEOUT_MS
      );
      (timer as unknown as { unref?: () => void }).unref?.();
      try {
        const res = await fetchImpl(iceUrl, {
          method: "GET",
          headers: { accept: "application/json" },
          // React Native's fetch ambient uses its own structurally incompatible
          // AbortSignal declaration. Both runtimes accept the standards-based
          // signal at runtime; isolate the ambient-type seam here.
          signal: controller.signal as unknown as RequestInit["signal"],
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          throw new Error(`Signaling ice-servers ${res.status}: ${detail}`.trim());
        }
        const body = (await res.json()) as IceServersResponse;
        if (!body || !Array.isArray(body.iceServers)) {
          throw new Error("Signaling ice-servers response missing iceServers[]");
        }
        return body.iceServers;
      } catch (error) {
        if (controller.signal.aborted) {
          throw new Error(
            `Signaling ice-servers fetch timed out after ${ICE_SERVERS_FETCH_TIMEOUT_MS}ms`
          );
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },

    onOpen(handler: () => void): () => void {
      openHandlers.add(handler);
      if (opened && !closed) queueMicrotask(() => openHandlers.has(handler) && handler());
      return () => openHandlers.delete(handler);
    },

    onPeerJoined(handler: () => void): () => void {
      peerJoinedHandlers.add(handler);
      return () => peerJoinedHandlers.delete(handler);
    },

    onClosed(handler: (reason?: string) => void): () => void {
      closedHandlers.add(handler);
      if (closed) handler(closeReason);
      return () => closedHandlers.delete(handler);
    },

    close(): void {
      closeReason = closeReason ?? "client-closed";
      try {
        ws.close(1000, "client-closed");
      } catch {
        /* already closing */
      }
      fireClosed(closeReason);
    },
  };
}
