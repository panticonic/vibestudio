/**
 * WebRTC RPC transport, OFFERER side — v2 wire protocol (plan §1) + recovery
 * state machine (plan §3.2–3.5). It is the **host↔server** pipe; the host
 * (shell) multiplexes N logically-authenticated sessions over it: its own
 * `shell` session plus one `panel:<key>` session per panel (each redeeming its
 * own one-time connection grant — per-panel principal identity is preserved,
 * the pipe never collapses panels into the host principal).
 *
 * - **control channel** (reliable/ordered): JSON `SessionControlFrame`s,
 *   fragmented under the negotiated chunk (`controlFraming.ts`) and scheduled
 *   per-session round-robin (`frameScheduler.ts`). `hello`/`ping`/`pong`
 *   bypass the scheduler (direct sends) so a saturated link can never starve
 *   its own keepalive.
 * - **bulk channel** (reliable/ordered): self-describing mux messages
 *   (`protocol/bulkMux.ts` — `[streamId:u32][flags:u8][payload]`) carrying
 *   proxyFetch/asset bodies, demuxed by stream id. The v1 byte-stream decoder
 *   path is deleted; DATA needs no reassembly at all.
 *
 * ### Hello preamble (§1.1)
 * The FIRST control message in each direction is `{t:"hello", proto:2,
 * maxMsg, platform, keepalive}` — sent directly on channel-open (after the
 * pin verifies), bypassing every queue. Effective chunk =
 * `min(both maxMsg, 256 KiB)`; effective keepalive = min of both ends'
 * parameters. The transport reports "connected" only once the pin verified,
 * both channels opened AND the remote hello arrived. A non-hello first frame,
 * `proto !== 2`, or 10 s of hello silence drops the pipe — no tolerant
 * fallback.
 *
 * ### Recovery (§3.2)
 * Exactly ONE in-flight establish, always: a down-event during an establish
 * sets a dirty flag that re-runs recovery after the attempt settles. The
 * previous peer is closed before a new one is assigned; `generation` fences
 * late callbacks from torn-down peers. Backoff mirrors `wsClient`
 * (1s·2ⁿ + jitter, cap 30 s); timers are tracked, cancelled on close, and
 * unref'd. Status: "disconnected" on pipe-down (before recovery),
 * "connecting" during reestablish, "connected" only after hello completes.
 *
 * Security: DTLS authenticates the *pipe* (the observed remote fingerprint is
 * pinned against the QR `fp`, FAIL-CLOSED on mismatch); per-session grants
 * authorize each *principal*. Confidentiality holds end-to-end even when
 * relayed through TURN (DTLS is never terminated by the relay).
 *
 * The transport is written entirely against the `webrtcPeer`/`webrtcSignaling`
 * interfaces, so it carries NO native dependency and is exercised in tests
 * with in-memory fakes (`webrtcClient.test.ts`).
 */

import type {
  AuthenticatedCaller,
  EnvelopeRpcTransport,
  RpcConnectionStatus,
  RpcEnvelope,
  RpcStreamRequest,
} from "../types.js";
import {
  FRAME_DATA,
  FRAME_END,
  FRAME_ERROR,
  type InboundStreamMux,
  type DecodedFramedStream,
  createInboundStreamMux,
  decodeFramedResponseToStreaming,
  decodeFramedStream,
} from "../protocol/streamCodec.js";
import {
  BULK_MUX_HEADER_BYTES,
  createBulkDemux,
  encodeBulkMessage,
  type StreamFrameType,
} from "../protocol/bulkMux.js";
import { createControlCodec } from "./controlFraming.js";
import {
  createFrameScheduler,
  type EnqueueOutcome,
  type FrameScheduler,
} from "./frameScheduler.js";
import {
  SESSION_CLOSE,
  SESSION_HELLO,
  SESSION_OPEN,
  SESSION_PING,
  SESSION_PONG,
  SESSION_PROTOCOL_VERSION,
  SESSION_RPC,
  SESSION_ROUTE,
  SESSION_STREAM_CANCEL,
  SESSION_STREAM_OPEN,
  type SessionControlFrame,
  type SessionEventFrame,
  type SessionHelloFrame,
  type SessionOpenResultFrame,
  type SessionRouteFrame,
  type SessionRoutedFrame,
  type SessionRoutedResponseErrorFrame,
  type SessionRpcFrame,
  decodeControlFrame,
  encodeControlFrame,
} from "../protocol/sessionNegotiation.js";
import type { RecoveryKind } from "../protocol/recoveryCoordinator.js";
import type {
  PeerConnectionProvider,
  RtcCandidateType,
  RtcConnectionState,
  RtcDataChannelLike,
  RtcIceCandidate,
  RtcPeerConnectionLike,
  WebRtcPairing,
} from "./webrtcPeer.js";
import {
  BULK_CHANNEL_ID,
  BULK_LABEL,
  CONTROL_CHANNEL_ID,
  CONTROL_LABEL,
  DEFAULT_CHUNK_SIZE,
} from "./webrtcPeer.js";
import type { SignalingClient } from "./webrtcSignaling.js";

export type { StreamFrameType } from "../protocol/bulkMux.js";

// Upper bound on the INITIAL connect. Generous enough for a slow relayed (TURN)
// DTLS handshake, but finite so an unreachable peer fails loud instead of hanging
// the caller's "connecting" spinner forever. Reconnects (reestablish) are NOT
// bounded by this — the caller is already up and the transport recovers in place.
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
/** Keepalive parameters this end advertises in its hello (§1.1); the effective
 * values are the min of both ends'. */
const LOCAL_KEEPALIVE = { intervalMs: 15_000, timeoutMs: 45_000 } as const;
/** Hard ceiling on the negotiated chunk size (§1.1) — mirrors the answerer. */
const MAX_CHUNK_SIZE = 256 * 1024;
/** Drain high-water for BOTH channels (§1.3/§1.4 — 256 KiB, symmetric). */
const BUFFER_HIGH_WATER = 256 * 1024;
/** The remote hello must arrive within this of our hello going out (§1.1). */
const HELLO_TIMEOUT_MS = 10_000;
/** Reestablish backoff — the exact `wsClient` policy. */
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_JITTER_MS = 500;
/**
 * Per-attempt establish deadline for a RECONNECT (bug #2). Unlike the initial
 * connect — which the caller bounds via `connectTimer` and closes on rejection —
 * a reconnect attempt is purely event-driven: if the answer never arrives while
 * the room WS stays healthy, the re-armed connect promise (with no timer) leaves
 * status stuck at "connecting" forever, `reconnectTimer` is null so `onPipeDown`
 * can't fire, and `nudge()` no-ops. This is a GENEROUS fail-loud backstop for a
 * truly-stuck attempt, NOT an SLA: it matches the ~30s initial-connect scale
 * (relayed DTLS handshakes take seconds) with headroom, so it can never abort a
 * viable in-flight connect — on expiry it routes to onPipeDown → backoff retry.
 */
const RECONNECT_ESTABLISH_DEADLINE_MS = 35_000;
/** Per-attempt deadline on a session open (§3.3) — a lost `open-result` can no
 * longer hang `ready()`; the attempt retries under per-session backoff. */
const SESSION_OPEN_DEADLINE_MS = 20_000;
const SESSION_RETRY_BASE_DELAY_MS = 1_000;
const SESSION_RETRY_MAX_DELAY_MS = 15_000;
const SESSION_RETRY_JITTER_MS = 250;
/** `nudge()` pong deadline (§3.1): after an out-of-band probe ping, a pong must
 * land within this or the pipe is declared down — event-driven reconnect on a
 * mobile foreground/network-change, instead of waiting out the 45 s keepalive. */
const NUDGE_PONG_DEADLINE_MS = 5_000;
/** Receive-side buffer bound per stream (§3.5): exceeding it fails the stream
 * and sends cancel — fail loud, never silent unbounded buffering. */
const STREAM_RECEIVE_CAP_BYTES = 8 * 1024 * 1024;
/** Control-scheduler lane for pipe-level frames that belong to no session
 * (mirrors the answerer's DEFAULT_CONTROL_LANE). */
const PIPE_LANE = "__pipe";

export const PIPE_CLOSED_CODE = "PIPE_CLOSED";
export const FINGERPRINT_MISMATCH_CODE = "DTLS_FINGERPRINT_MISMATCH";
export const STREAM_RECEIVE_OVERFLOW_CODE = "STREAM_RECEIVE_OVERFLOW";
/** A logical session is terminally closed (client close / lease revoke / server
 * terminal close) — distinct from an auth failure so callers don't misdiagnose a
 * revocation as a bad credential (bug #10). */
export const SESSION_CLOSED_CODE = "SESSION_CLOSED";

/** Injectable diagnostics sink so desktop/mobile can route transport logs into
 * their telemetry instead of the hardcoded console (matches the answerer/ingress
 * `warn` injection). Both default to the matching `console` method. */
export interface WebRtcTransportLogger {
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

/** Reconnect progress surfaced to the UX so a stalled reconnect shows
 * "reconnecting, attempt N" instead of a silent forever-spinner. */
export interface ReconnectProgress {
  /** 1-based attempt counter (resets to 0 once a pipe comes up). */
  attempt: number;
  /** 'scheduled' (backoff armed), 'connecting' (attempt in flight), or
   * 'failed' (attempt errored/stalled — a new backoff follows). */
  phase: "scheduled" | "connecting" | "failed";
  /** Human-readable cause of the (re)connect. */
  reason: string;
  /** Whether the last failure was in the SIGNALING layer vs the peer/ICE layer —
   * lets the UX say "can't reach the rendezvous" vs "can't reach your machine". */
  layer: "signaling" | "peer" | null;
}

function errorWithCode(message: string, code: string): Error {
  const e = new Error(message) as Error & { code?: string };
  e.code = code;
  return e;
}

/** Normalize a DTLS SHA-256 fingerprint for comparison (strip colons, upcase). */
function normalizeFingerprint(fp: string): string {
  return fp.replace(/[:\s]/g, "").toUpperCase();
}

type AnyTimer = ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;

/** Timers must never hold the Node event loop open for an idle transport. */
function unrefTimer(timer: AnyTimer): void {
  (timer as unknown as { unref?: () => void }).unref?.();
}

export interface WebRtcSessionOptions {
  /** Logical session id (defaults to the connectionId, or a random id). */
  sid?: string;
  /** Host-chosen connection id — the lease key the server's gate matches. */
  connectionId?: string;
  clientLabel?: string;
  clientSessionId?: string;
  clientPlatform?: "desktop" | "headless" | "mobile";
  /**
   * Token provider for this session's one-time connection grant. Re-invoked on
   * every (re)open because grants are one-shot (rpcServer redeem consumes them).
   * A continuation whose reopen generation went stale is DISCARDED un-sent, so
   * a slow grant fetch can never burn a fresh grant redemption (§3.3).
   */
  getToken(): Promise<string> | string;
  /** Recovery hook — fired with 'cold-recover' | 'resubscribe' on EVERY open,
   * including the first (WS parity; consumers bootstrap subscriptions off it). */
  onRecovery?: (kind: RecoveryKind) => void;
  /**
   * Fired once when this session authenticated by redeeming a pairing code: the
   * freshly issued device credential to persist for reconnects. Only the first
   * (pairing) open delivers it.
   */
  onPaired?: (credential: { deviceId: string; refreshToken: string }) => void | Promise<void>;
  /** Fired when the server terminally closes this logical session. */
  onTerminalClose?: (error: Error) => void;
}

/** A logical session over the pipe — a full `EnvelopeRpcTransport`. */
export interface WebRtcSession extends EnvelopeRpcTransport {
  readonly sid: string;
  /** Resolved server identity after handshake (callerId the server assigned). */
  callerId(): string | undefined;
  /** True once the server terminally closed this logical session (e.g. a lease
   * revoke). `send()` then throws "Session is closed"; callers must not reuse it —
   * the transport status can still read "connected" (the pipe outlives sessions). */
  isClosed(): boolean;
  close(): void;
}

export interface WebRtcTransportOptions {
  provider: PeerConnectionProvider;
  /**
   * Factory for the signaling-room client. Invoked once per (re)establish so a
   * recovery gets a FRESH signaling connection: the room WS idle-closes after the
   * pipe connects (e.g. a dev-worker 1006 timeout), and that closed instance
   * cannot be reused to exchange the next offer/answer.
   */
  createSignaling: () => SignalingClient;
  pairing: WebRtcPairing;
  /** 'offerer' (client/host) creates the offer; 'answerer' is the server side. */
  role?: "offerer" | "answerer";
  /** Optional cap on the maxMsg this end advertises in its hello. The advertised
   * value is `min(chunkSize, channel.maxMessageSize || 16 KiB)`; the effective
   * chunk is then `min(both ends' hello maxMsg, 256 KiB)` (§1.1). */
  chunkSize?: number;
  /** Advertised in the hello preamble (informational). */
  platform?: "desktop" | "mobile" | "server" | "headless";
  logPrefix?: string;
  /** Upper bound (ms) on the initial connect before it rejects (default 30s).
   * Reconnects are not bounded by this. */
  connectTimeoutMs?: number;
  /** Observability: selected ICE candidate type changed (host/srflx/**relay**);
   * fired with `null` on pipe-down. Same feed as `transport.onCandidateType`. */
  onCandidateType?: (type: RtcCandidateType | null) => void;
  /** Injectable diagnostics sink (defaults to `console`). */
  logger?: WebRtcTransportLogger;
  /** Reconnect progress feed — same events as `transport.onReconnectProgress`. */
  onReconnectProgress?: (progress: ReconnectProgress) => void;
}

export interface WebRtcTransport {
  /** Establish the pipe (idempotent); resolves once the DTLS pin verified, both
   * channels opened AND the hello exchange completed. */
  connect(): Promise<void>;
  ready(): Promise<void>;
  status(): RpcConnectionStatus;
  onStatusChange(handler: (status: RpcConnectionStatus) => void): () => void;
  /** Open a logical authenticated session — returns its `EnvelopeRpcTransport`.
   * A live session with the same sid is explicitly closed first. */
  openSession(options: WebRtcSessionOptions): WebRtcSession;
  /** Last selected ICE candidate-pair type — 'relay' means TURN engaged (alarm). */
  candidateType(): RtcCandidateType | null;
  /** Candidate-type feed for the relay alarm (§9.8): fired with the selected
   * type when the pipe comes up and `null` when it goes down. */
  onCandidateType(handler: (type: RtcCandidateType | null) => void): () => void;
  /** Reconnect progress feed: fires as a reconnect is scheduled, attempted, and
   * when an attempt fails/stalls — so the UX can show "reconnecting, attempt N"
   * instead of a silent spinner. Not fired for the initial connect. */
  onReconnectProgress(handler: (progress: ReconnectProgress) => void): () => void;
  /**
   * Send one logical bulk frame for `streamId`: mux-encoded (§1.2) and chunked
   * under the negotiated size (DATA payloads split into independent DATA
   * messages; oversized HEAD/ERROR JSON continues via MORE), scheduled
   * round-robin per stream against the bulk channel's 256 KiB high-water.
   * Resolves once accepted under the queue caps AND sent; settles (never
   * rejects) on pipe-down — the transport's recovery path is the failure
   * signal. This is the upload seam (§1.6): the `bodyStreamId` request-body
   * path streams DATA frames through here. Throws synchronously when the bulk
   * channel is not open.
   */
  sendBulkFrame(streamId: number, type: StreamFrameType, payload: Uint8Array): Promise<void>;
  /**
   * Out-of-band liveness probe (§3.1): ping now + arm a 5 s pong deadline that
   * declares the pipe down if unanswered, so recovery reestablishes immediately
   * instead of after the keepalive timeout. No-op while not connected or while
   * recovery is in flight. Event-driven reconnect trigger (mobile foreground /
   * network change); cleared by any pong.
   */
  nudge(): void;
  close(): Promise<void>;
}

export function createWebRtcTransport(options: WebRtcTransportOptions): WebRtcTransport {
  const { provider, pairing } = options;
  // The CURRENT signaling client — (re)created per establishPeer via
  // options.createSignaling and closed on teardown. Held so close() can release it.
  let signaling: SignalingClient | null = null;
  const role = options.role ?? "offerer";
  const log = options.logPrefix ?? "[webrtc]";
  const logWarn = options.logger?.warn ?? console.warn.bind(console);
  const logError = options.logger?.error ?? console.error.bind(console);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let peer: RtcPeerConnectionLike | null = null;
  let control: RtcDataChannelLike | null = null;
  let bulk: RtcDataChannelLike | null = null;
  let controlScheduler: FrameScheduler | null = null;
  let bulkScheduler: FrameScheduler | null = null;
  let generation = 0;
  let status: RpcConnectionStatus = "disconnected";
  let connectPromise: Promise<void> | null = null;
  let resolveConnect: (() => void) | null = null;
  let rejectConnect: ((error: unknown) => void) | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  // Whether connectPromise has resolved (the pipe came up). Gates re-arming it on
  // pipe-down: re-arm a SETTLED promise so recovery-time connect()/ready() awaits
  // the new pipe, but leave a still-pending initial connect alone (its caller awaits it).
  let connectResolved = false;
  let closed = false;

  // --- serialized establish (§3.2) -----------------------------------------
  /** True while an establish attempt is in flight — there is never a second. */
  let establishing = false;
  /** A down-event landed during the in-flight establish; recovery re-runs
   * after the attempt settles (never a concurrent teardown). */
  let dirty = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Per-attempt establish deadline for RECONNECTS (bug #2) — a stuck reconnect
   * whose answer never arrives fails loud here instead of hanging in
   * "connecting" forever. Armed at the start of a reconnect establish, cleared
   * on "connected" / teardown / close. */
  let establishDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  /** Layer that caused the most recent establish failure — distinguishes a
   * signaling-down failure from a peer-unreachable one in the connect timeout
   * message and the reconnect-progress feed (UX/DX). */
  let lastFailureLayer: "signaling" | "peer" | null = null;

  // --- hello negotiation (§1.1) ---------------------------------------------
  let pinVerified = false;
  let helloSent = false;
  let remoteHello: SessionHelloFrame | null = null;
  let helloTimer: ReturnType<typeof setTimeout> | null = null;
  /** What our hello advertised: min(chunkSize option, channel max, 16 KiB floor). */
  let advertisedMaxMsg = DEFAULT_CHUNK_SIZE;
  /** min(advertisedMaxMsg, remote hello maxMsg, 256 KiB) once negotiated. */
  let effectiveChunk = DEFAULT_CHUNK_SIZE;
  let keepaliveIntervalMs: number = LOCAL_KEEPALIVE.intervalMs;
  let keepaliveTimeoutMs: number = LOCAL_KEEPALIVE.timeoutMs;

  let lastPongAt = 0;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  /** One-shot deadline armed by nudge(); any pong clears it (§3.1). */
  let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  const unsubs: Array<() => void> = [];

  const statusListeners = new Set<(status: RpcConnectionStatus) => void>();
  const candidateTypeListeners = new Set<(type: RtcCandidateType | null) => void>();
  const reconnectProgressListeners = new Set<(progress: ReconnectProgress) => void>();
  /** Last value handed to the candidate-type feed — de-dupes re-emits so the
   * relay alarm only sees genuine transitions (bug #4). `undefined` = nothing
   * emitted yet. */
  let lastCandidateType: RtcCandidateType | null | undefined = undefined;
  const sessions = new Map<string, SessionImpl>();

  function emitReconnectProgress(phase: ReconnectProgress["phase"], reason: string): void {
    const progress: ReconnectProgress = {
      attempt: reconnectAttempt,
      phase,
      reason,
      layer: lastFailureLayer,
    };
    try {
      options.onReconnectProgress?.(progress);
    } catch (error) {
      logWarn(`${log} onReconnectProgress option threw`, error);
    }
    for (const listener of [...reconnectProgressListeners]) {
      try {
        listener(progress);
      } catch (error) {
        logWarn(`${log} reconnect-progress listener threw`, error);
      }
    }
  }

  /** Classify a pipe-down reason as a signaling-layer vs peer/ICE-layer failure
   * (UX/DX: distinguish "can't reach rendezvous" from "can't reach your machine"). */
  function classifyFailureLayer(reason: string): "signaling" | "peer" {
    return /signal|sendDescription|setRemoteDescription|ice-servers/i.test(reason)
      ? "signaling"
      : "peer";
  }

  /**
   * §3.4 delivery-gap closure: outbound ROUTED REQUEST and RESPONSE frames
   * whose enqueue has not (yet) been confirmed flushed, keyed by requestId
   * (UUIDs — a request we issue and a response we owe can never collide). The
   * client layer's pending-call policy keeps routed pendings alive across a
   * clean reconnect (the server inbox replays their RESPONSES) — but a frame
   * that was queued and never hit the wire at pipe-down has nothing
   * server-side to replay: a lost REQUEST strands OUR pending; a lost RESPONSE
   * strands the REMOTE caller's (the server keeps its `routedRequestOrigins`
   * entry and nothing ever settles the origin — the caller's pipe never went
   * down, so no rejection fires on their side either). The transport therefore
   * re-drives these frames after a `resubscribe` recovery (`finishOpen`).
   * Bounded naturally: each entry corresponds to a live pending call (ours or
   * the remote caller's); removed on confirmed flush, on the settling
   * response / routed-response-error arriving, on cold-recover / terminal
   * session close (the client layer rejects those pendings), and on hard
   * close. Direct-server (`rpc`) frames are NOT tracked — their pendings are
   * rejected the moment the transport reports `disconnected` (client.ts §3.4),
   * so a re-drive would only risk duplicate execution. Re-driving is
   * duplicate-safe twice over: a partially-sent fragment set is discarded by
   * the peer's defragmenter reset on reconnect (a `'dropped'` frame was
   * definitionally never delivered), and the server's origin bookkeeping is
   * consumed on first response delivery (a duplicate response bounces back as
   * `routed-response-error`, which no-ops at the responder).
   */
  const unflushedRouted = new Map<string, SessionRouteFrame>();

  /** Drop tracked unflushed routed frames belonging to one session. */
  function dropUnflushedRouted(sid: string): void {
    for (const [requestId, tracked] of unflushedRouted) {
      if (tracked.sid === sid) unflushedRouted.delete(requestId);
    }
  }

  /** Track a routed request/response frame until its enqueue confirms
   * `'flushed'` — a `'dropped'` settle KEEPS the entry (that is what
   * re-drives). Routed events are best-effort by contract: not tracked. */
  function trackRoutedFrame(frame: SessionControlFrame, enqueued: Promise<EnqueueOutcome>): void {
    if (frame.t !== SESSION_ROUTE) return;
    const message = frame.envelope.message as { type?: string; requestId?: string };
    if (message.type !== "request" && message.type !== "response") return;
    if (typeof message.requestId !== "string") return;
    const requestId = message.requestId;
    unflushedRouted.set(requestId, frame);
    void enqueued.then((outcome) => {
      // Identity-checked: a stale settle from a previous generation must not
      // delete an entry that was re-driven meanwhile (same frame object, so a
      // genuine flush on ANY generation clears it).
      if (outcome === "flushed" && unflushedRouted.get(requestId) === frame) {
        unflushedRouted.delete(requestId);
      }
    });
  }

  /** Streams awaiting frames: sid (for the cancel frame) + abort-listener
   * removal, reaped on END/ERROR/abort/pipe-down (no accumulation on shared
   * AbortSignals — §3.5). `abortUpload` (set only for streams with a request
   * body, §1.6) stops the body pump whenever the stream settles — abort,
   * response END/ERROR, pipe-down — so no upload outlives its request. */
  const activeStreams = new Map<
    number,
    { sid: string; offAbort: () => void; abortUpload?: (error: Error) => void }
  >();

  const inboundMux: InboundStreamMux = createInboundStreamMux({
    maxBufferedBytesPerStream: STREAM_RECEIVE_CAP_BYTES,
    onStreamOverflow: (streamId, bufferedBytes) => {
      const error = errorWithCode(
        `stream ${streamId} exceeded the ${STREAM_RECEIVE_CAP_BYTES}-byte receive buffer (${bufferedBytes} buffered)`,
        STREAM_RECEIVE_OVERFLOW_CODE
      );
      logWarn(`${log} ${error.message}`);
      const active = activeStreams.get(streamId);
      inboundMux.fail(streamId, error);
      if (active) {
        try {
          writeControlFrame({ t: SESSION_STREAM_CANCEL, sid: active.sid, streamId });
        } catch {
          /* pipe gone — inboundMux.closeAll on pipe-down reaps the rest */
        }
      }
      settleStream(streamId);
    },
  });

  // Bulk channel → self-describing mux messages → per-stream bodies (§1.2).
  // Reset on reconnect (a fresh pipe's continuations never concatenate onto a
  // dead pipe's partial HEAD/ERROR accumulations).
  const bulkDemux = createBulkDemux((streamId, type, payload) => {
    inboundMux.push(streamId, type, payload);
    if (type === FRAME_END || type === FRAME_ERROR) settleStream(streamId);
  });

  // Control-channel framing: fragment large frames on send + reassemble on receive,
  // plus the frame-id counter — bundled in one codec, reset on reconnect. RN corrupts
  // >16 KiB messages, so the fragmentation is what keeps large RPC envelopes intact.
  const controlCodec = createControlCodec();
  let nextStreamId = 1;

  function setStatus(next: RpcConnectionStatus): void {
    if (status === next) return;
    status = next;
    for (const listener of statusListeners) {
      try {
        listener(next);
      } catch (error) {
        logWarn(`${log} status listener threw`, error);
      }
    }
  }

  function emitCandidateType(type: RtcCandidateType | null): void {
    if (type === lastCandidateType) return; // de-dupe: only genuine transitions (bug #4)
    lastCandidateType = type;
    try {
      options.onCandidateType?.(type);
    } catch (error) {
      logWarn(`${log} onCandidateType option threw`, error);
    }
    for (const listener of candidateTypeListeners) {
      try {
        listener(type);
      } catch (error) {
        logWarn(`${log} candidate-type listener threw`, error);
      }
    }
  }

  // -- channel writes ---------------------------------------------------------

  /**
   * Session-addressed control write: fragments under the negotiated chunk and
   * enqueues on the per-session lane (pipe-level frames use `__pipe`). Throws
   * synchronously when the channel is not open (callers rely on it); the
   * enqueue itself settles-never-rejects (pipe-down is the failure signal).
   */
  function writeControlFrame(frame: SessionControlFrame): void {
    const scheduler = controlScheduler;
    if (!control || control.readyState !== "open" || !scheduler) {
      throw errorWithCode("WebRTC control channel not open", PIPE_CLOSED_CODE);
    }
    const bytes = encoder.encode(encodeControlFrame(frame));
    const parts = controlCodec.frame(bytes, effectiveChunk);
    const lane = (frame as { sid?: string }).sid ?? PIPE_LANE;
    // The enqueue settles-never-rejects; its outcome ('flushed' | 'dropped')
    // feeds the §3.4 unflushed-routed-request tracking above.
    trackRoutedFrame(frame, scheduler.enqueue(lane, parts));
  }

  /**
   * Direct control write for `hello`/`ping`/`pong` — bypasses the scheduler
   * entirely (§1.4: keepalive is out-of-band; the hello precedes the pipe being
   * up). These frames are tiny, so this is one whole-tagged codec message,
   * protocol-safe between fragment sets.
   */
  function writeControlDirect(frame: SessionControlFrame): void {
    const channel = control;
    if (!channel || channel.readyState !== "open") {
      throw errorWithCode("WebRTC control channel not open", PIPE_CLOSED_CODE);
    }
    const bytes = encoder.encode(encodeControlFrame(frame));
    for (const part of controlCodec.frame(bytes, Math.max(advertisedMaxMsg, DEFAULT_CHUNK_SIZE))) {
      channel.send(part);
    }
  }

  /** Encode one logical bulk frame into ≤effectiveChunk mux messages (§1.2) —
   * byte-identical policy to the answerer's `encodeBulkFrameParts`. */
  function encodeBulkFrameParts(
    streamId: number,
    type: StreamFrameType,
    payload: Uint8Array
  ): Uint8Array[] {
    const budget = Math.max(1, effectiveChunk - BULK_MUX_HEADER_BYTES);
    if (payload.byteLength <= budget) {
      return [encodeBulkMessage(streamId, type, payload)];
    }
    if (type === FRAME_DATA) {
      // DATA has no wire-level frame: each message's bytes simply append to
      // the stream, so an oversized payload becomes independent DATA messages.
      const parts: Uint8Array[] = [];
      for (let offset = 0; offset < payload.byteLength; offset += budget) {
        parts.push(
          encodeBulkMessage(
            streamId,
            type,
            payload.subarray(offset, Math.min(offset + budget, payload.byteLength))
          )
        );
      }
      return parts;
    }
    if (type === FRAME_END) {
      // END carries a tiny JSON payload and cannot continue (MORE is invalid
      // on END) — an oversized one is a programming error, not a wire state.
      throw new Error(
        `END payload (${payload.byteLength}B) exceeds the negotiated chunk (${budget}B)`
      );
    }
    // Oversized HEAD/ERROR JSON continues via MORE messages (§1.2).
    const parts: Uint8Array[] = [];
    for (let offset = 0; offset < payload.byteLength; offset += budget) {
      const end = Math.min(offset + budget, payload.byteLength);
      parts.push(
        encodeBulkMessage(streamId, type, payload.subarray(offset, end), end < payload.byteLength)
      );
    }
    return parts;
  }

  function sendBulkFrame(
    streamId: number,
    type: StreamFrameType,
    payload: Uint8Array
  ): Promise<void> {
    const scheduler = bulkScheduler;
    if (!bulk || bulk.readyState !== "open" || !scheduler) {
      throw errorWithCode("WebRTC bulk channel not open", PIPE_CLOSED_CODE);
    }
    // Outcome discarded: bulk-stream failure is signalled by pipe-down/stream
    // teardown, not per-write results (settle-never-rejects).
    return scheduler
      .enqueue(streamId, encodeBulkFrameParts(streamId, type, payload))
      .then(() => undefined);
  }

  // -- inbound control demux ----------------------------------------------------

  /**
   * FAIL-CLOSED DTLS pin check (bug #3, §6.1). Returns true once the observed
   * remote fingerprint matches the pinned `fp`. Returns false while the
   * fingerprint is not yet observable (DTLS not settled) — the caller must NOT
   * process the frame in that window. A mismatch hard-closes the pipe and
   * returns false. Shared by `tryComplete` and the inbound dispatch gate so no
   * non-hello frame is ever processed over an unpinned pipe.
   */
  function tryVerifyPin(): boolean {
    if (pinVerified) return true;
    if (!peer) return false;
    const observed = peer.remoteFingerprint();
    if (!observed) return false; // DTLS not settled yet — a later trigger retries
    if (normalizeFingerprint(observed) !== normalizeFingerprint(pairing.fingerprint)) {
      // FAIL CLOSED — a signaling box that swapped the fingerprint is rejected;
      // no RPC ever flows over an unpinned pipe (plan §6.1, proven §11).
      const error = errorWithCode(
        `DTLS fingerprint mismatch: observed ${observed} != pinned ${pairing.fingerprint}`,
        FINGERPRINT_MISMATCH_CODE
      );
      logError(`${log} ${error.message}`);
      rejectConnect?.(error);
      void hardClose();
      return false;
    }
    pinVerified = true;
    return true;
  }

  function handleControlMessage(data: Uint8Array, forGeneration: number): void {
    if (forGeneration !== generation || closed) return;
    let full: Uint8Array | null;
    try {
      full = controlCodec.accept(data);
    } catch (error) {
      // ControlProtocolViolation (defrag budget breach) — fail loud (§2.5).
      onPipeDown(
        `control protocol violation: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
    if (!full) return; // incomplete fragment set
    let frame: SessionControlFrame;
    try {
      frame = decodeControlFrame(decoder.decode(full));
    } catch (error) {
      // Control frames are whole JSON documents from a conforming peer; a
      // malformed one is a protocol violation, not something to tolerate.
      onPipeDown(
        `malformed control frame: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
    if (!remoteHello) {
      // §1.1: the FIRST control frame in each direction must be the hello. The
      // hello is deliberately NOT pin-gated: pin verification needs DTLS up
      // (the fingerprint can be briefly null exactly when the hello lands), and
      // handleRemoteHello → tryComplete verifies the pin the moment it settles.
      if (frame.t !== SESSION_HELLO) {
        onPipeDown(`protocol violation: '${frame.t}' frame before hello`);
        return;
      }
      handleRemoteHello(frame, forGeneration);
      return;
    }
    // FAIL-CLOSED pin gate before dispatch (bug #3): no non-hello frame
    // (open-result/routed/event/…) is ever actioned over an UNPINNED pipe. In
    // the correct protocol these only arrive after we've sent `open` — i.e.
    // after status went "connected", which requires pinVerified — so this drops
    // only a frame from the theoretical fingerprint-null race the code
    // anticipates (line ~717). A genuine mismatch has already hard-closed via
    // tryComplete/tryVerifyPin, so a dropped frame can never leak plaintext RPC.
    if (!pinVerified) return;
    switch (frame.t) {
      case SESSION_HELLO:
        onPipeDown("protocol violation: duplicate hello");
        return;
      case "pong":
        lastPongAt = Date.now();
        clearNudgeTimer(); // any pong clears an armed nudge deadline (§3.1)
        return;
      case "ping":
        try {
          writeControlDirect({ t: SESSION_PONG, ts: frame.ts });
        } catch {
          /* pipe gone */
        }
        return;
      case "open-result":
        sessions.get(frame.sid)?.onOpenResult(frame);
        return;
      case "closed":
        sessions.get(frame.sid)?.onServerClosed(frame.code, frame.reason, frame.terminal ?? false);
        return;
      case "rpc":
      case "routed": {
        const envelope = (frame as SessionRpcFrame | SessionRoutedFrame).envelope;
        const message = envelope.message as { type?: string; requestId?: string };
        // A response proves its request WAS delivered — clear any (racing)
        // unflushed-tracking entry so it can never be spuriously re-driven.
        // (requestIds are UUIDs: an inbound response can only ever match OUR
        // request entry, never a response entry we owe someone else.)
        if (message.type === "response" && typeof message.requestId === "string") {
          unflushedRouted.delete(message.requestId);
        }
        sessions.get(frame.sid)?.deliverEnvelope(envelope);
        return;
      }
      case "event":
        sessions.get(frame.sid)?.deliverServerEvent(frame as SessionEventFrame);
        return;
      case "routed-response-error":
        // The server saw the routed message and failed to deliver it — the
        // pending settles here (request direction), or our RESPONSE reached
        // the server but bounced (response direction, incl. the duplicate
        // bounce after a re-drive race): either way the tracked entry is
        // done and must never re-drive.
        unflushedRouted.delete((frame as SessionRoutedResponseErrorFrame).requestId);
        sessions
          .get(frame.sid)
          ?.deliverRoutedResponseError(frame as SessionRoutedResponseErrorFrame);
        return;
      case "routed-event-error":
        // Best-effort events: warn only (parity with wsClient.ts:204-212).
        logWarn(`${log} routed event undeliverable`, frame);
        return;
      default:
        // open/close/route/stream-* are answerer-handled; offerer ignores.
        return;
    }
  }

  function handleBulkMessage(data: Uint8Array, forGeneration: number): void {
    if (forGeneration !== generation || closed) return;
    // FAIL-CLOSED pin gate (bug #3): bulk (stream-body) frames only flow after a
    // stream-open, i.e. well after pinVerified — drop anything arriving over an
    // unpinned pipe rather than demuxing it. A mismatch has already hard-closed.
    if (!pinVerified) return;
    if (!remoteHello) {
      onPipeDown("protocol violation: bulk message before hello");
      return;
    }
    try {
      bulkDemux.push(data);
    } catch (error) {
      // BulkProtocolViolation — a peer speaking a different dialect fails loud
      // instead of corrupting streams silently (§1.2).
      onPipeDown(
        `bulk protocol violation: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // -- hello negotiation (§1.1) ------------------------------------------------

  function handleRemoteHello(frame: SessionHelloFrame, forGeneration: number): void {
    if (frame.proto !== SESSION_PROTOCOL_VERSION) {
      onPipeDown(
        `protocol violation: hello proto ${frame.proto} (want ${SESSION_PROTOCOL_VERSION})`
      );
      return;
    }
    if (!Number.isFinite(frame.maxMsg) || frame.maxMsg <= 0) {
      onPipeDown(`protocol violation: hello maxMsg ${frame.maxMsg}`);
      return;
    }
    remoteHello = frame;
    clearHelloTimer();
    tryComplete(forGeneration);
  }

  function armHelloTimer(): void {
    clearHelloTimer();
    helloTimer = setTimeout(() => {
      helloTimer = null;
      if (!remoteHello) {
        onPipeDown(`hello timeout (no remote hello within ${HELLO_TIMEOUT_MS}ms)`);
      }
    }, HELLO_TIMEOUT_MS);
    unrefTimer(helloTimer);
  }

  function clearHelloTimer(): void {
    if (helloTimer !== null) {
      clearTimeout(helloTimer);
      helloTimer = null;
    }
  }

  function reopenSession(session: SessionImpl): void {
    // Fire-and-forget reopen drives the session handshake. Callers that care await
    // ready(), which observes the same openPromise rejection; this catch only
    // prevents the background reopen() promise from becoming an unhandled
    // rejection on expected terminal auth failures.
    void session.reopen().catch(() => undefined);
  }

  /**
   * Idempotently complete the connection. Triggered by ICE 'connected', each
   * channel's onOpen and the remote hello (whichever lands last). Order:
   *  1. pin verified (FAIL-CLOSED on mismatch),
   *  2. both channels open → our hello goes out DIRECTLY (first control frame),
   *  3. remote hello received → negotiate chunk/keepalive → "connected".
   */
  function tryComplete(forGeneration: number): void {
    if (forGeneration !== generation || closed || status === "connected") return;
    if (!peer || !control || !bulk) return;
    if (!tryVerifyPin()) return; // DTLS not settled or FAIL-CLOSED mismatch (bug #3)
    if (control.readyState !== "open" || bulk.readyState !== "open") return; // wait for channel-open
    if (!helloSent) {
      // Advertise min(chunkSize option, the channel's REAL maxMessageSize with a
      // 16 KiB floor-default — RN adapters may report 0/undefined, and 16 KiB is
      // the RN corruption cap exactly as DEFAULT_CHUNK_SIZE encodes).
      advertisedMaxMsg = control.maxMessageSize || DEFAULT_CHUNK_SIZE;
      if (options.chunkSize) advertisedMaxMsg = Math.min(options.chunkSize, advertisedMaxMsg);
      const hello: SessionHelloFrame = {
        t: SESSION_HELLO,
        proto: SESSION_PROTOCOL_VERSION,
        maxMsg: advertisedMaxMsg,
        ...(options.platform ? { platform: options.platform } : {}),
        keepalive: { ...LOCAL_KEEPALIVE },
      };
      try {
        writeControlDirect(hello);
      } catch (error) {
        onPipeDown(`hello send failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      helloSent = true;
      armHelloTimer();
    }
    if (!remoteHello) return; // §1.1: connected only after the hello exchange
    clearHelloTimer();
    effectiveChunk = Math.min(advertisedMaxMsg, remoteHello.maxMsg, MAX_CHUNK_SIZE);
    keepaliveIntervalMs = Math.min(
      LOCAL_KEEPALIVE.intervalMs,
      remoteHello.keepalive?.intervalMs || Number.POSITIVE_INFINITY
    );
    keepaliveTimeoutMs = Math.min(
      LOCAL_KEEPALIVE.timeoutMs,
      remoteHello.keepalive?.timeoutMs || Number.POSITIVE_INFINITY
    );
    lastPongAt = Date.now();
    reconnectAttempt = 0;
    lastFailureLayer = null;
    clearEstablishDeadline(); // the attempt succeeded — no stuck-reconnect backstop needed
    startKeepalive();
    emitCandidateType(peer.selectedCandidateType());
    // (Re)open every live session over the (re)established pipe. Runs BEFORE the
    // status flip so a status-driven send observes a pending openPromise.
    for (const session of [...sessions.values()]) reopenSession(session);
    resolveConnect?.();
    connectResolved = true;
    setStatus("connected");
  }

  // -- pipe-down + serialized recovery (§3.2) -----------------------------------

  /** Fail everything riding the pipe; status flips to "disconnected" BEFORE any
   * recovery starts (the status contract the shared bootstrap depends on). */
  function failPipe(reason: string): void {
    setStatus("disconnected");
    stopKeepalive();
    clearHelloTimer();
    // The connect promise resolved when this (now-dead) pipe first came up, so
    // re-arm it to a fresh pending one — otherwise ready()/connect() during recovery
    // would return the stale resolved promise and proceed over a down pipe. Only
    // re-arm a promise that HAD resolved (don't disturb a pending initial connect).
    if (connectResolved) {
      connectResolved = false;
      connectPromise = new Promise<void>((resolve, reject) => {
        resolveConnect = resolve;
        rejectConnect = (error) => {
          connectPromise = null;
          reject(error);
        };
      });
      // Mark handled: nobody may ever await this re-armed promise (recovery is
      // background); a close() that rejects it must not surface an unhandled
      // rejection. A caller that DOES connect()/ready() still observes it.
      void connectPromise.catch(() => undefined);
    }
    emitCandidateType(null);
    // Fail loud: reject in-flight streams + server→client bridge calls now; the
    // sessions re-open after recovery (callers retry against a live pipe).
    inboundMux.closeAll(errorWithCode(`WebRTC pipe down: ${reason}`, PIPE_CLOSED_CODE));
    for (const [, stream] of activeStreams) {
      stream.offAbort();
      stream.abortUpload?.(errorWithCode(`WebRTC pipe down: ${reason}`, PIPE_CLOSED_CODE));
    }
    activeStreams.clear();
    for (const session of sessions.values()) session.onPipeDown(reason);
  }

  function clearEstablishDeadline(): void {
    if (establishDeadlineTimer !== null) {
      clearTimeout(establishDeadlineTimer);
      establishDeadlineTimer = null;
    }
  }

  function onPipeDown(reason: string): void {
    if (closed) return;
    lastFailureLayer = classifyFailureLayer(reason);
    if (establishing) {
      // §3.2: never a concurrent teardown — flag it; recovery re-runs after the
      // in-flight establish settles.
      if (!dirty) {
        dirty = true;
        logWarn(`${log} pipe down during establish: ${reason}`);
        failPipe(reason);
      }
      return;
    }
    if (reconnectTimer !== null) return; // already down; recovery scheduled
    logWarn(`${log} pipe down: ${reason}`);
    failPipe(reason);
    scheduleReestablish(reason);
  }

  /** Backoff+jitter mirroring the WS transport (capped 30 s). The timer is
   * tracked (cancelled by close()) and unref'd. */
  function scheduleReestablish(reason: string): void {
    if (closed || establishing || reconnectTimer !== null) return;
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt + Math.random() * RECONNECT_JITTER_MS,
      RECONNECT_MAX_DELAY_MS
    );
    reconnectAttempt++;
    emitReconnectProgress("scheduled", reason);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      logWarn(`${log} re-establishing pipe (attempt ${reconnectAttempt}, after: ${reason})`);
      void runEstablish(reason, /* isReconnect */ true);
    }, delay);
    unrefTimer(reconnectTimer);
  }

  /**
   * The ONE establish runner — every path (initial connect, reestablish) funnels
   * here, so there is exactly one in-flight establishPeer, always. A down-event
   * during the attempt sets `dirty`, consumed after the attempt settles.
   */
  async function runEstablish(reason: string, isReconnect = false): Promise<void> {
    if (closed || establishing) return;
    establishing = true;
    dirty = false;
    setStatus("connecting");
    if (isReconnect) {
      emitReconnectProgress("connecting", reason);
      // Arm the per-attempt establish deadline (bug #2). The initial connect is
      // bounded by connectTimer + the caller closing on rejection; a reconnect
      // has no such owner, so a stuck attempt (answer never arrives, room WS
      // healthy) would otherwise hang in "connecting" forever. GENEROUS
      // backstop — see RECONNECT_ESTABLISH_DEADLINE_MS.
      armEstablishDeadline(reason);
    }
    try {
      await establishPeer();
    } catch (error) {
      logWarn(`${log} establish failed: ${error instanceof Error ? error.message : String(error)}`);
      dirty = true;
    } finally {
      establishing = false;
    }
    if (closed) return;
    if (dirty) {
      dirty = false;
      clearEstablishDeadline();
      setStatus("disconnected");
      if (isReconnect) emitReconnectProgress("failed", `${reason} (attempt failed)`);
      scheduleReestablish(`${reason} (attempt failed)`);
    }
    // NOTE: when establishPeer() resolves cleanly but the pipe is not yet
    // "connected" (offer sent, awaiting answer/ICE/hello), the establish
    // deadline armed above stays live and is the ONLY thing that can rescue a
    // stalled attempt — it fires onPipeDown → backoff. Cleared on "connected".
  }

  /** Arm the reconnect establish deadline: on expiry, if still not connected,
   * declare the pipe down so the backoff loop retries (bug #2). */
  function armEstablishDeadline(reason: string): void {
    clearEstablishDeadline();
    establishDeadlineTimer = setTimeout(() => {
      establishDeadlineTimer = null;
      if (closed || status === "connected") return;
      logWarn(
        `${log} reconnect establish stalled (no pipe within ${RECONNECT_ESTABLISH_DEADLINE_MS}ms) — retrying`
      );
      emitReconnectProgress("failed", `establish stalled: ${reason}`);
      onPipeDown("reconnect establish deadline exceeded");
    }, RECONNECT_ESTABLISH_DEADLINE_MS);
    unrefTimer(establishDeadlineTimer);
  }

  /** Tear down the current peer/channels/schedulers and reset per-pipe codec
   * state. Runs at the START of every establish (the previous peer is closed
   * BEFORE the new one is assigned) and on hardClose. */
  function teardownPipe(): void {
    clearHelloTimer();
    stopKeepalive();
    for (const off of unsubs.splice(0)) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    controlScheduler?.close();
    bulkScheduler?.close();
    controlScheduler = null;
    bulkScheduler = null;
    try {
      control?.close();
    } catch {
      /* ignore */
    }
    try {
      bulk?.close();
    } catch {
      /* ignore */
    }
    try {
      peer?.close();
    } catch {
      /* ignore */
    }
    control = null;
    bulk = null;
    peer = null;
    pinVerified = false;
    helloSent = false;
    remoteHello = null;
    advertisedMaxMsg = DEFAULT_CHUNK_SIZE;
    effectiveChunk = DEFAULT_CHUNK_SIZE;
    // A fresh pipe must not reassemble against the dead pipe's leftovers: drop any
    // half-demuxed bulk continuations and half-reassembled control fragments.
    bulkDemux.reset();
    controlCodec.reset();
  }

  // -- signaling + peer lifecycle ------------------------------------------

  async function establishPeer(): Promise<void> {
    // Close the previous pipe BEFORE standing up (or assigning) the new one.
    teardownPipe();
    // Fresh signaling per (re)establish — see createSignaling. The local `sig`
    // binds this establish's handlers to ITS signaling so a later re-establish
    // (which reassigns the outer `signaling`) cannot make an in-flight handler
    // send into the wrong socket.
    try {
      signaling?.close();
    } catch {
      /* already closed */
    }
    const thisGeneration = ++generation;
    const sig = options.createSignaling();
    signaling = sig;
    // The offer we last sent — re-sent on `peer-joined` (bug #2) so a
    // late-arriving server recovers without waiting out the establish deadline.
    let lastLocalOffer: { type: "offer" | "answer"; sdp: string } | null = null;
    // Signaling is CRITICAL only until the descriptions have been exchanged.
    // Before that, a room-WS drop means we can never complete → tear down.
    // AFTER the remote description is applied, ICE/DTLS can finish on its own
    // (the candidates already exchanged nominate a pair, DTLS handshakes
    // in-band), so an idle-close of the room WS must NOT abort a viable
    // in-flight connect (bug #6). The reconnect establish deadline (bug #2) is
    // the backstop if that lenient window never actually completes.
    let signalingCritical = true;
    // Registered BEFORE any await: a signaling drop during setup must count as
    // a down-event (previously it fell through the cracks until the offer send
    // failed). Once the pipe is connected it is independent of signaling, and
    // once descriptions are exchanged ICE/DTLS no longer needs it either.
    unsubs.push(
      sig.onClosed((reason) => {
        if (thisGeneration !== generation || closed) return;
        if (status === "connected") return; // healthy pipe outlives signaling
        if (!signalingCritical) {
          // Descriptions exchanged — let ICE/DTLS finish; the establish
          // deadline backstops a window that never completes.
          logWarn(
            `${log} signaling closed after description exchange (${reason ?? ""}) — letting ICE/DTLS finish`
          );
          return;
        }
        onPipeDown(`signaling closed: ${reason ?? ""}`);
      })
    );
    if (role === "offerer" && sig.onPeerJoined) {
      unsubs.push(
        sig.onPeerJoined(() => {
          if (thisGeneration !== generation || closed || status === "connected") return;
          if (!lastLocalOffer) return; // offer not created yet — the normal send covers it
          void sig
            .sendDescription(lastLocalOffer)
            .catch((error) => logWarn(`${log} re-send offer on peer-joined`, error));
        })
      );
    }
    const iceServers = sig.fetchIceServers
      ? await sig.fetchIceServers()
      : (pairing.iceServers ?? []);
    if (thisGeneration !== generation || closed || dirty) return; // aborted under us

    const pc = await provider.create({
      iceServers,
      iceTransportPolicy: pairing.iceTransportPolicy,
    });
    if (thisGeneration !== generation || closed || dirty) {
      try {
        pc.close();
      } catch {
        /* ignore */
      }
      return;
    }
    peer = pc;

    // Pre-negotiated channels: both peers open matching ids.
    const controlChannel = pc.createDataChannel(CONTROL_LABEL, {
      ordered: true,
      negotiated: true,
      id: CONTROL_CHANNEL_ID,
    });
    const bulkChannel = pc.createDataChannel(BULK_LABEL, {
      ordered: true,
      negotiated: true,
      id: BULK_CHANNEL_ID,
    });
    control = controlChannel;
    bulk = bulkChannel;
    controlChannel.bufferedAmountLowThreshold = BUFFER_HIGH_WATER;
    bulkChannel.bufferedAmountLowThreshold = BUFFER_HIGH_WATER;
    // One scheduler pair per pipe generation, bound to THESE channels: queued
    // bytes can never leak into the next generation (teardown settles them).
    controlScheduler = createFrameScheduler({ getChannel: () => controlChannel });
    bulkScheduler = createFrameScheduler({ getChannel: () => bulkChannel });

    unsubs.push(
      controlChannel.onMessage((d) => handleControlMessage(d, thisGeneration)),
      // Channels open just AFTER ICE 'connected'; completion waits for both
      // (writing a frame to a still-'connecting' channel would throw).
      controlChannel.onOpen(() => tryComplete(thisGeneration)),
      bulkChannel.onOpen(() => tryComplete(thisGeneration)),
      bulkChannel.onMessage((d) => handleBulkMessage(d, thisGeneration)),
      controlChannel.onClose(() => {
        if (thisGeneration !== generation) return;
        onPipeDown("control channel closed");
      }),
      bulkChannel.onClose(() => {
        if (thisGeneration !== generation) return;
        onPipeDown("bulk channel closed");
      }),
      controlChannel.onError((error) => {
        if (thisGeneration !== generation) return;
        onPipeDown(`control channel error: ${error.message}`);
      }),
      bulkChannel.onError((error) => {
        if (thisGeneration !== generation) return;
        onPipeDown(`bulk channel error: ${error.message}`);
      })
    );

    // Candidate buffering (§3.2): queue inbound remote candidates until a remote
    // description has been applied to the CURRENT peer, then flush. RN's
    // setRemoteDescription is genuinely async — candidates racing it were dropped.
    let remoteDescApplied = false;
    const pendingCandidates: RtcIceCandidate[] = [];
    const applyRemoteDescription = async (desc: {
      type: "offer" | "answer";
      sdp: string;
    }): Promise<void> => {
      await pc.setRemoteDescription(desc);
      if (thisGeneration !== generation || closed) return;
      if (desc.type === "offer" && role === "answerer") {
        const answer = await pc.createAnswer();
        if (thisGeneration !== generation || closed) return;
        await pc.setLocalDescription(answer);
        if (thisGeneration !== generation || closed) return;
      }
      remoteDescApplied = true;
      // Descriptions exchanged — a signaling drop from here can no longer abort
      // this attempt (bug #6); ICE/DTLS complete in-band.
      signalingCritical = false;
      for (const cand of pendingCandidates.splice(0)) {
        try {
          await pc.addRemoteCandidate(cand);
        } catch (error) {
          logWarn(`${log} addRemoteCandidate (buffered)`, error);
        }
      }
    };

    // Signaling glue. Every void'd async handler carries a .catch — a failure
    // that makes the pipe unusable (description exchange) is a down-event, never
    // an unhandled rejection crash (§3.2).
    unsubs.push(
      pc.onLocalDescription((desc) => {
        if (desc.type === "offer") lastLocalOffer = desc; // remembered for peer-joined re-send (bug #2)
        void sig.sendDescription(desc).catch((error) => {
          logWarn(`${log} sendDescription`, error);
          if (thisGeneration === generation) onPipeDown("signaling sendDescription failed");
        });
      }),
      pc.onLocalCandidate(
        (cand) =>
          void sig.sendCandidate(cand).catch((error) => logWarn(`${log} sendCandidate`, error))
      ),
      sig.onDescription((desc) => {
        if (thisGeneration !== generation || closed) return;
        void applyRemoteDescription(desc).catch((error) => {
          logWarn(`${log} setRemoteDescription`, error);
          if (thisGeneration === generation) onPipeDown("setRemoteDescription failed");
        });
      }),
      sig.onCandidate((cand) => {
        if (thisGeneration !== generation || closed) return;
        if (!remoteDescApplied) {
          pendingCandidates.push(cand);
          return;
        }
        void pc
          .addRemoteCandidate(cand)
          .catch((error) => logWarn(`${log} addRemoteCandidate`, error));
      }),
      pc.onConnectionStateChange((state) => onConnectionState(state, thisGeneration))
    );
    // Re-emit the candidate type on every selected-pair change (bug #4): the
    // one-shot read at hello-complete misses a still-null nomination and a
    // mid-connection switch to relay. De-duped by emitCandidateType; gated on
    // the live pipe so a change during teardown doesn't resurface.
    if (pc.onSelectedCandidateChange) {
      unsubs.push(
        pc.onSelectedCandidateChange((type) => {
          if (thisGeneration !== generation || closed || status !== "connected") return;
          emitCandidateType(type);
        })
      );
    }

    if (role === "offerer") {
      const offer = await pc.createOffer();
      if (thisGeneration !== generation || closed) return;
      await pc.setLocalDescription(offer);
    }
  }

  function onConnectionState(state: RtcConnectionState, forGeneration: number): void {
    if (forGeneration !== generation || closed) return;
    if (state === "connected") {
      tryComplete(forGeneration);
    } else if (state === "failed") {
      onPipeDown(`ICE ${state}`);
    }
    // ICE "disconnected" is TRANSIENT — the agent keeps probing and usually
    // recovers to "connected" (common on relay paths / flaky links). Tearing the
    // pipe down here would abort a recoverable connection mid-transfer; the
    // keepalive timeout is the backstop if it never comes back.
  }

  // -- keepalive (§1.4: out-of-band, parameters from the hello) -----------------

  function startKeepalive(): void {
    stopKeepalive();
    const timeout = keepaliveTimeoutMs;
    keepaliveTimer = setInterval(() => {
      if (!control || control.readyState !== "open") return;
      if (Date.now() - lastPongAt > timeout) {
        onPipeDown("keepalive timeout");
        return;
      }
      try {
        writeControlDirect({ t: SESSION_PING, ts: Date.now() });
      } catch {
        /* pipe gone */
      }
    }, keepaliveIntervalMs);
    unrefTimer(keepaliveTimer);
  }

  function stopKeepalive(): void {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    // A nudge deadline belongs to a live pipe; every stopKeepalive() path is a
    // pipe-down/teardown/close, so drop it here too (no leaked timer fires
    // onPipeDown against a already-dead or reconnecting pipe).
    clearNudgeTimer();
  }

  function clearNudgeTimer(): void {
    if (nudgeTimer !== null) {
      clearTimeout(nudgeTimer);
      nudgeTimer = null;
    }
  }

  /**
   * Liveness probe (§3.1): send an immediate out-of-band ping and arm a one-shot
   * 5 s pong deadline; if no pong lands, declare the pipe down so the recovery
   * loop reestablishes NOW rather than after the ~45 s keepalive timeout. Any
   * pong clears the deadline. No-op unless the pipe is fully up and no recovery
   * is in flight (there is nothing to probe, and the reconnect loop already
   * owns the reestablish). Mobile calls this on foreground / network-type change.
   */
  function nudge(): void {
    if (closed || status !== "connected" || establishing || reconnectTimer !== null) return;
    if (!control || control.readyState !== "open") return;
    try {
      writeControlDirect({ t: SESSION_PING, ts: Date.now() });
    } catch {
      return; // pipe gone under us — the channel handlers drive recovery
    }
    clearNudgeTimer();
    nudgeTimer = setTimeout(() => {
      nudgeTimer = null;
      if (closed || status !== "connected") return;
      onPipeDown("nudge timeout");
    }, NUDGE_PONG_DEADLINE_MS);
    unrefTimer(nudgeTimer);
  }

  async function hardClose(): Promise<void> {
    if (closed) return;
    closed = true;
    // Settle any pending connect promise (initial OR re-armed during recovery) so
    // an awaiting connect()/ready() rejects rather than hanging on a closed pipe.
    rejectConnect?.(errorWithCode("Transport closed", PIPE_CLOSED_CODE));
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    clearEstablishDeadline();
    teardownPipe();
    try {
      signaling?.close();
    } catch {
      /* ignore */
    }
    // Fail every session and CLEAR the map — nothing awaiting ready()/openPromise
    // may hang, and closed sessions must not leak (§3.2).
    const all = [...sessions.values()];
    sessions.clear();
    // Hard close settles every pending at the client layer — a re-drive after
    // this would be wrong, and there is no next pipe anyway (§3.4).
    unflushedRouted.clear();
    for (const session of all) session.onPipeDown("transport closed");
    inboundMux.closeAll(errorWithCode("WebRTC transport closed", PIPE_CLOSED_CODE));
    for (const [, stream] of activeStreams) {
      stream.offAbort();
      stream.abortUpload?.(errorWithCode("WebRTC transport closed", PIPE_CLOSED_CODE));
    }
    activeStreams.clear();
    setStatus("disconnected");
  }

  // -- stream multiplex ----------------------------------------------------

  function allocateStream(): number {
    const id = nextStreamId;
    nextStreamId = (nextStreamId % 0x7fffffff) + 1;
    return id;
  }

  function settleStream(streamId: number): void {
    const stream = activeStreams.get(streamId);
    if (!stream) return;
    activeStreams.delete(streamId);
    stream.offAbort();
    // The request settled (END/ERROR/abort/cancel): a still-running upload has
    // nothing left to feed — stop it. Completed pumps ignore this (no-op).
    stream.abortUpload?.(errorWithCode("stream settled before upload completed", PIPE_CLOSED_CODE));
  }

  /**
   * Pump a streaming REQUEST body onto the bulk channel as DATA frames keyed by
   * `bodyStreamId` (plan §1.6). Each `sendBulkFrame` is AWAITED — the pipe's
   * bounded scheduler queue IS the upload backpressure. Clean EOF sends END;
   * abort / reader failure / send failure sends `{message, code:"UPLOAD_ABORTED"}`
   * as an ERROR frame AND fails the stream() result loudly (mux fail +
   * stream-cancel), unless the failure came from the stream's own settlement.
   */
  function pumpRequestBody(
    sid: string,
    streamId: number,
    bodyStreamId: number,
    body: ReadableStream<Uint8Array>
  ): { abort: (error: Error) => void } {
    const reader = body.getReader();
    let abortError: Error | null = null;
    const abort = (error: Error): void => {
      if (abortError) return;
      abortError = error;
      // Wake a parked read() (cancel resolves it done) and discard the queued
      // unsent backlog so the ERROR frame is not stuck behind megabytes of DATA.
      void reader.cancel(error).catch(() => undefined);
      bulkScheduler?.dropKey(bodyStreamId);
    };
    void (async () => {
      let bytesOut = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (abortError) throw abortError;
          if (done) break;
          if (value && value.byteLength > 0) {
            bytesOut += value.byteLength;
            // Await = upload backpressure (bounded scheduler). It settles (never
            // rejects) on pipe-down; the abortError check after it catches that.
            await sendBulkFrame(bodyStreamId, FRAME_DATA, value);
            if (abortError) throw abortError;
          }
        }
        await sendBulkFrame(
          bodyStreamId,
          FRAME_END,
          encoder.encode(JSON.stringify({ bytesIn: bytesOut }))
        );
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        // Settle the server's inbound body loudly (it must never hang half-fed).
        try {
          await sendBulkFrame(
            bodyStreamId,
            FRAME_ERROR,
            encoder.encode(JSON.stringify({ message: err.message, code: "UPLOAD_ABORTED" }))
          );
        } catch {
          /* pipe gone — the server reaps the body via session/pipe teardown */
        }
        if (abortError !== err) {
          // A pump-originated failure (reader threw / send failed), not a
          // settlement-driven stop: fail the caller's stream() result loudly
          // and tell the server to stop serving the request.
          inboundMux.fail(streamId, err);
          try {
            writeControlFrame({ t: SESSION_STREAM_CANCEL, sid, streamId });
          } catch {
            /* pipe gone */
          }
          settleStream(streamId);
        }
      }
    })();
    return { abort };
  }

  function beginStream(
    sid: string,
    envelope: RpcEnvelope,
    signal?: AbortSignal | null,
    requestBody?: ReadableStream<Uint8Array> | null
  ): {
    body: ReadableStream<Uint8Array>;
    onBodyCancel: (reason?: unknown) => void;
  } {
    const streamId = allocateStream();
    const body = inboundMux.acquire(streamId);
    const noopCancel = (): void => undefined;
    if (signal?.aborted) {
      // Pre-aborted: never opens on the wire; the body settles immediately.
      inboundMux.fail(streamId, errorWithCode("Streaming RPC aborted by caller", PIPE_CLOSED_CODE));
      if (requestBody) void requestBody.cancel().catch(() => undefined);
      return { body, onBodyCancel: noopCancel };
    }
    let offAbort = (): void => undefined;
    if (signal) {
      const onAbort = (): void => {
        // Abort settles LOCALLY too (§3.5): fail the mux entry so a pre-HEAD
        // await rejects now, and tell the server to stop producing. settleStream
        // also aborts an in-flight upload pump (§1.6), whose ERROR frame settles
        // the server's inbound body.
        inboundMux.fail(
          streamId,
          errorWithCode("Streaming RPC aborted by caller", PIPE_CLOSED_CODE)
        );
        try {
          writeControlFrame({ t: SESSION_STREAM_CANCEL, sid, streamId });
        } catch {
          /* pipe gone */
        }
        settleStream(streamId);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      // Removed when the stream settles (END/ERROR/abort/pipe-down) — no
      // listener accumulation on shared signals.
      offAbort = () => signal.removeEventListener("abort", onAbort);
    }
    const entry: { sid: string; offAbort: () => void; abortUpload?: (error: Error) => void } = {
      sid,
      offAbort,
    };
    activeStreams.set(streamId, entry);
    // The request body rides the bulk channel too, keyed by its OWN stream id,
    // declared on the stream-open (plan §1.6). The open frame is SENT before
    // the first DATA frame, but control and bulk are independent SCTP streams,
    // so cross-channel ARRIVAL order is not guaranteed — the server holds
    // early DATA in a bounded pre-open buffer and flushes it when the open
    // lands (rpcServer.attachWebRtcPipe), so the pump can start immediately
    // with no open-ack round trip.
    const bodyStreamId = requestBody ? allocateStream() : undefined;
    try {
      // The response body rides the bulk channel keyed by streamId.
      writeControlFrame({
        t: SESSION_STREAM_OPEN,
        sid,
        streamId,
        ...(bodyStreamId !== undefined ? { bodyStreamId } : {}),
        envelope,
      });
    } catch (error) {
      inboundMux.fail(streamId, error instanceof Error ? error : new Error(String(error)));
      settleStream(streamId);
      if (requestBody) void requestBody.cancel().catch(() => undefined);
      return { body, onBodyCancel: noopCancel };
    }
    if (requestBody && bodyStreamId !== undefined) {
      entry.abortUpload = pumpRequestBody(sid, streamId, bodyStreamId, requestBody).abort;
    }
    return {
      body,
      onBodyCancel: () => {
        if (!activeStreams.has(streamId)) return;
        try {
          writeControlFrame({ t: SESSION_STREAM_CANCEL, sid, streamId });
        } catch {
          /* pipe gone */
        }
        settleStream(streamId);
      },
    };
  }

  function openStream(
    sid: string,
    envelope: RpcEnvelope,
    signal?: AbortSignal | null,
    requestBody?: ReadableStream<Uint8Array> | null
  ): Promise<Response> {
    const started = beginStream(sid, envelope, signal, requestBody);
    return decodeFramedResponseToStreaming(started.body, "", signal, {
      onBodyCancel: started.onBodyCancel,
    });
  }

  function openStreamReadable(
    sid: string,
    envelope: RpcEnvelope,
    signal?: AbortSignal | null,
    requestBody?: ReadableStream<Uint8Array> | null
  ): Promise<DecodedFramedStream> {
    const started = beginStream(sid, envelope, signal, requestBody);
    return decodeFramedStream(started.body, "", signal, {
      onBodyCancel: started.onBodyCancel,
    });
  }

  // -- session implementation ----------------------------------------------

  class SessionImpl implements WebRtcSession {
    readonly sid: string;
    private readonly messageListeners = new Set<(envelope: RpcEnvelope) => void>();
    private resolvedCallerId: string | undefined;
    private lastServerBootId: string | undefined;
    /** Reopen generation (§3.3): a getToken continuation whose generation went
     * stale is discarded un-sent (never burns a fresh one-shot grant). */
    private openGen = 0;
    private retryAttempt = 0;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    private openResolve: (() => void) | null = null;
    private openReject: ((error: unknown) => void) | null = null;
    private openPromise: Promise<void> | null = null;
    /** The current openPromise has settled (resolved or rejected). */
    private openSettled = false;
    private sessionClosed = false;

    constructor(private readonly opts: WebRtcSessionOptions) {
      // Fallback sid MUST be unique per instance: the old hash was over
      // clientLabel only, so two label-only sessions collided and the second
      // silently closed the first (bug #9). A random nonce guarantees
      // uniqueness while an explicit sid/connectionId still wins for stability.
      this.sid = opts.sid ?? opts.connectionId ?? `s-${randomToken()}`;
    }

    callerId(): string | undefined {
      return this.resolvedCallerId;
    }

    /** True only while this instance owns its sid in the transport's map —
     * a superseded instance must never announce/close for its replacement. */
    private isCurrent(): boolean {
      return sessions.get(this.sid) === this;
    }

    private ensureOpenPromise(): void {
      if (this.openPromise && !this.openSettled) return; // pending — keep it
      this.openSettled = false;
      this.openPromise = new Promise<void>((resolve, reject) => {
        this.openResolve = () => {
          this.openSettled = true;
          resolve();
        };
        this.openReject = (error) => {
          this.openSettled = true;
          reject(error);
        };
      });
      // Mark handled: a background reopen with no ready() caller must not
      // surface an unhandled rejection; real awaiters still observe it.
      void this.openPromise.catch(() => undefined);
    }

    async reopen(): Promise<void> {
      if (this.sessionClosed || closed) return;
      this.cancelRetry(); // a direct reopen supersedes a scheduled one
      const gen = ++this.openGen;
      // Assign openPromise SYNCHRONOUSLY — before the (possibly async) getToken —
      // so a caller's ready() actually waits for the session to authenticate.
      this.ensureOpenPromise();
      this.armDeadline(gen);
      const result = this.openPromise!;
      void (async () => {
        let token: string;
        try {
          token = await this.opts.getToken();
        } catch (error) {
          if (gen !== this.openGen || this.sessionClosed || closed) return;
          logWarn(`${log} session ${this.sid} getToken failed`, error);
          // Non-terminal open failure → per-session backoff retry (§3.3).
          this.clearDeadline();
          this.scheduleRetry("getToken failed");
          return;
        }
        if (gen !== this.openGen || this.sessionClosed || closed) return; // STALE — discard the grant un-sent
        try {
          writeControlFrame({
            t: SESSION_OPEN,
            sid: this.sid,
            token,
            connectionId: this.opts.connectionId,
            clientSessionId: this.opts.clientSessionId,
            clientLabel: this.opts.clientLabel,
            clientPlatform: this.opts.clientPlatform,
          });
        } catch {
          // Pipe dropped between checks — recovery reopens every session on the
          // next pipe-up; the deadline is cleared by onPipeDown.
        }
      })();
      return result;
    }

    private armDeadline(gen: number): void {
      this.clearDeadline();
      this.deadlineTimer = setTimeout(() => {
        this.deadlineTimer = null;
        if (gen !== this.openGen || this.sessionClosed || closed || this.openSettled) return;
        logWarn(
          `${log} session ${this.sid} open attempt timed out after ${SESSION_OPEN_DEADLINE_MS}ms`
        );
        this.scheduleRetry("open deadline");
      }, SESSION_OPEN_DEADLINE_MS);
      unrefTimer(this.deadlineTimer);
    }

    private clearDeadline(): void {
      if (this.deadlineTimer !== null) {
        clearTimeout(this.deadlineTimer);
        this.deadlineTimer = null;
      }
    }

    /** Per-session reopen backoff (cap ~15 s); stops on terminal close, session
     * close, transport close, or when this instance was superseded. */
    private scheduleRetry(reason: string): void {
      if (this.sessionClosed || closed || this.retryTimer !== null || !this.isCurrent()) return;
      const delay = Math.min(
        SESSION_RETRY_BASE_DELAY_MS * 2 ** this.retryAttempt +
          Math.random() * SESSION_RETRY_JITTER_MS,
        SESSION_RETRY_MAX_DELAY_MS
      );
      this.retryAttempt++;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (this.sessionClosed || closed || !this.isCurrent()) return;
        if (status !== "connected") return; // pipe recovery reopens on completion
        logWarn(
          `${log} session ${this.sid} reopening (attempt ${this.retryAttempt}, after: ${reason})`
        );
        void this.reopen().catch(() => undefined);
      }, delay);
      unrefTimer(this.retryTimer);
    }

    private cancelRetry(): void {
      if (this.retryTimer !== null) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
    }

    onOpenResult(frame: SessionOpenResultFrame): void {
      if (this.sessionClosed) return;
      if (!frame.success) {
        const error = errorWithCode(frame.error ?? "Session auth failed", "SESSION_AUTH_FAILED");
        if (frame.terminal) {
          this.terminate(error);
          return;
        }
        logWarn(`${log} session ${this.sid} open rejected (non-terminal): ${error.message}`);
        this.clearDeadline();
        this.scheduleRetry("open rejected");
        return;
      }
      void this.finishOpen(frame).catch((error) => {
        if (this.sessionClosed) return;
        const err = error instanceof Error ? error : new Error(String(error));
        this.terminate(err);
      });
    }

    private async finishOpen(frame: SessionOpenResultFrame): Promise<void> {
      if (this.sessionClosed) return;
      this.clearDeadline();
      this.retryAttempt = 0;
      this.resolvedCallerId = frame.callerId;
      // A freshly paired device's credential rides back on the first open-result
      // (the server keeps only its hash). Hand it to the client to persist before
      // resolving ready(), so a reconnect can authenticate with the refresh secret.
      if (frame.deviceCredential) await this.opts.onPaired?.(frame.deviceCredential);
      if (this.sessionClosed) return;
      // cold-recover vs resubscribe (WS parity, wsClient.ts:136-155): server
      // restart (bootId change) OR a dirty session ⇒ cold-recover. Fires on the
      // FIRST open too — consumers bootstrap their subscriptions off it.
      const bootChanged =
        this.lastServerBootId !== undefined &&
        frame.serverBootId !== undefined &&
        this.lastServerBootId !== frame.serverBootId;
      const kind: RecoveryKind = frame.sessionDirty || bootChanged ? "cold-recover" : "resubscribe";
      try {
        this.opts.onRecovery?.(kind);
      } catch (error) {
        logWarn(`${log} session ${this.sid} onRecovery threw`, error);
      }
      this.lastServerBootId = frame.serverBootId;
      // §3.4 delivery gap: a routed REQUEST or RESPONSE that was queued but
      // never flushed at pipe-down has no server-side trace, so the inbox
      // replay that keeps routed pendings alive across `resubscribe` can never
      // settle it (a lost request strands OUR pending; a lost response strands
      // the REMOTE caller's) — re-drive those frames now that the session is
      // open on the new pipe. Duplicate-safe (never delivered — see
      // unflushedRouted) and reorder-safe (RPC responses are requestId-keyed).
      // On `cold-recover` the client layer rejects the routed pendings
      // instead; re-driving would resurrect calls whose callers already saw
      // the failure.
      if (kind === "resubscribe") {
        for (const tracked of [...unflushedRouted.values()]) {
          if (tracked.sid !== this.sid) continue;
          try {
            writeControlFrame(tracked); // re-tracks under the new generation's scheduler
          } catch {
            // Pipe dropped again under us — entries stay tracked; the next
            // resubscribe re-drives them (cold-recover / close clears them).
          }
        }
      } else {
        dropUnflushedRouted(this.sid);
      }
      this.openResolve?.();
    }

    onServerClosed(code: number | undefined, reason: string | undefined, terminal: boolean): void {
      if (this.sessionClosed) return;
      if (terminal) {
        // Terminal close (lease revoke, panel retired, …): the session leaves
        // the map — it must never auto-reopen or leak (§1.5).
        this.terminate(errorWithCode(`Session closed: ${reason ?? code ?? ""}`, PIPE_CLOSED_CODE));
        return;
      }
      // Non-terminal (e.g. 4008 session-not-open after a server-side desync):
      // sends must wait for the reopen, so re-arm the open promise and schedule
      // a backoff reopen — the desync self-heals within one round-trip (§1.5).
      logWarn(
        `${log} session ${this.sid} closed non-terminally (${code ?? "?"}: ${reason ?? ""}) — reopening`
      );
      this.clearDeadline();
      this.ensureOpenPromise();
      this.scheduleRetry(`server closed (${code ?? "?"})`);
    }

    /** Terminal end of this logical session: settle everything, leave the map. */
    private terminate(error: Error): void {
      this.sessionClosed = true;
      this.clearDeadline();
      this.cancelRetry();
      if (this.openPromise && !this.openSettled) this.openReject?.(error);
      this.openResolve = null;
      this.openReject = null;
      if (this.isCurrent()) {
        sessions.delete(this.sid);
        // A dead session can never re-drive: drop its tracked requests (§3.4).
        dropUnflushedRouted(this.sid);
      }
      try {
        this.opts.onTerminalClose?.(error);
      } catch (callbackError) {
        logWarn(`${log} session ${this.sid} onTerminalClose threw`, callbackError);
      }
    }

    onPipeDown(reason: string): void {
      this.clearDeadline();
      this.cancelRetry();
      if (this.openPromise && !this.openSettled) {
        this.openReject?.(errorWithCode(`WebRTC pipe down: ${reason}`, PIPE_CLOSED_CODE));
      }
      this.openResolve = null;
      this.openReject = null;
      this.openPromise = null; // the next pipe-up reopens with a fresh promise
      this.openSettled = false;
    }

    deliverEnvelope(envelope: RpcEnvelope): void {
      for (const listener of this.messageListeners) {
        try {
          listener(envelope);
        } catch (error) {
          logWarn(`${log} session ${this.sid} message listener threw`, error);
        }
      }
    }

    deliverServerEvent(frame: SessionEventFrame): void {
      // Synthesize a server-originated event envelope (parity with wsClient.ts:163-179).
      const serverCaller: AuthenticatedCaller = { callerId: "main", callerKind: "server" };
      const envelope: RpcEnvelope = {
        from: "main",
        target: this.resolvedCallerId ?? this.sid,
        delivery: { caller: serverCaller },
        provenance: [serverCaller],
        message: { type: "event", event: frame.event, payload: frame.payload, fromId: "main" },
      };
      this.deliverEnvelope(envelope);
    }

    deliverRoutedResponseError(frame: SessionRoutedResponseErrorFrame): void {
      // Turn an undeliverable routed request into a REJECTING response so the
      // pending call settles (fail-loud, parity with wsClient.ts:180-203).
      const serverCaller: AuthenticatedCaller = { callerId: "main", callerKind: "server" };
      const envelope: RpcEnvelope = {
        from: "main",
        target: this.resolvedCallerId ?? this.sid,
        delivery: { caller: serverCaller },
        provenance: [serverCaller],
        message: {
          type: "response",
          requestId: frame.requestId,
          error: frame.error,
          errorCode: frame.errorCode,
        },
      };
      this.deliverEnvelope(envelope);
    }

    private async ensureReadyForOutbound(): Promise<void> {
      // A closed session is a TERMINAL/revocation condition, not an auth failure
      // (bug #10): callers must not misdiagnose a lease revoke as a bad credential.
      if (this.sessionClosed) throw errorWithCode("Session is closed", SESSION_CLOSED_CODE);
      if (status !== "connected") throw errorWithCode("Not connected to server", PIPE_CLOSED_CODE);
      if (this.openPromise) await this.openPromise;
      if (this.sessionClosed) throw errorWithCode("Session is closed", SESSION_CLOSED_CODE);
      if (status !== "connected") throw errorWithCode("Not connected to server", PIPE_CLOSED_CODE);
    }

    // -- EnvelopeRpcTransport surface --------------------------------------

    async send(envelope: RpcEnvelope): Promise<void> {
      await this.ensureReadyForOutbound();
      // target 'main'/'server' → rpc frame; otherwise caller-to-caller route.
      const frame: SessionControlFrame =
        envelope.target === "main" || envelope.target === "server"
          ? { t: SESSION_RPC, sid: this.sid, envelope }
          : { t: SESSION_ROUTE, sid: this.sid, envelope };
      writeControlFrame(frame);
    }

    onMessage(handler: (envelope: RpcEnvelope) => void): () => void {
      this.messageListeners.add(handler);
      return () => this.messageListeners.delete(handler);
    }

    status(): RpcConnectionStatus {
      return status;
    }

    isClosed(): boolean {
      return this.sessionClosed === true;
    }

    async ready(): Promise<void> {
      await transport.connect();
      if (this.openPromise) await this.openPromise;
    }

    onStatusChange(handler: (status: RpcConnectionStatus) => void): () => void {
      return transport.onStatusChange(handler);
    }

    async stream(
      envelope: RpcEnvelope,
      signal?: AbortSignal | null,
      body?: ReadableStream<Uint8Array> | null
    ): Promise<Response> {
      await this.ensureReadyForOutbound();
      const message = envelope.message as RpcStreamRequest;
      if (message.type !== "stream-request") {
        throw new Error(`stream() requires a stream-request envelope, got ${message.type}`);
      }
      return openStream(this.sid, envelope, signal, body);
    }

    async streamReadable(
      envelope: RpcEnvelope,
      signal?: AbortSignal | null,
      body?: ReadableStream<Uint8Array> | null
    ): Promise<DecodedFramedStream> {
      await this.ensureReadyForOutbound();
      const message = envelope.message as RpcStreamRequest;
      if (message.type !== "stream-request") {
        throw new Error(`streamReadable() requires a stream-request envelope, got ${message.type}`);
      }
      return openStreamReadable(this.sid, envelope, signal, body);
    }

    close(): void {
      const current = this.isCurrent();
      this.sessionClosed = true;
      this.clearDeadline();
      this.cancelRetry();
      if (this.openPromise && !this.openSettled) {
        this.openReject?.(errorWithCode("Session closed", PIPE_CLOSED_CODE));
      }
      this.openResolve = null;
      this.openReject = null;
      // Identity-checked (§3.3): a superseded instance must neither evict its
      // replacement from the map nor announce a close for the shared sid.
      if (!current) return;
      sessions.delete(this.sid);
      dropUnflushedRouted(this.sid); // no session ⇒ nothing to re-drive
      try {
        writeControlFrame({ t: SESSION_CLOSE, sid: this.sid });
      } catch {
        /* pipe gone */
      }
    }
  }

  const transport: WebRtcTransport = {
    async connect(): Promise<void> {
      if (closed) throw errorWithCode("Transport closed", PIPE_CLOSED_CODE);
      if (status === "connected") return;
      if (connectPromise) return connectPromise;
      connectPromise = new Promise<void>((resolve, reject) => {
        resolveConnect = () => {
          if (connectTimer) clearTimeout(connectTimer);
          connectTimer = null;
          resolve();
        };
        rejectConnect = (error) => {
          if (connectTimer) clearTimeout(connectTimer);
          connectTimer = null;
          connectPromise = null;
          reject(error);
        };
      });
      // Bound the initial connect: an unreachable peer never reaches "connected",
      // so neither resolveConnect nor rejectConnect fires (the reestablish loop
      // retries forever without settling this promise) and connect() would hang.
      // The caller closes the transport on rejection, stopping the retry loop.
      const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
      connectTimer = setTimeout(() => {
        // Name the layer that actually failed instead of always blaming the peer
        // (UX/DX): a signaling-down or hung ICE-server fetch is a different fix
        // for the user than an unreachable machine.
        const cause =
          lastFailureLayer === "signaling"
            ? "signaling/rendezvous unreachable"
            : lastFailureLayer === "peer"
              ? "peer unreachable"
              : "peer unreachable (no signal observed)";
        rejectConnect?.(
          errorWithCode(
            `WebRTC connect timed out after ${connectTimeoutMs}ms (${cause})`,
            PIPE_CLOSED_CODE
          )
        );
      }, connectTimeoutMs);
      unrefTimer(connectTimer);
      // Kick the serialized establish runner unless recovery is already driving
      // it (an in-flight attempt or a scheduled backoff retry — both settle or
      // re-arm this same connectPromise).
      if (!establishing && reconnectTimer === null) void runEstablish("initial connect");
      return connectPromise;
    },
    ready(): Promise<void> {
      return transport.connect();
    },
    status(): RpcConnectionStatus {
      return status;
    },
    onStatusChange(handler: (status: RpcConnectionStatus) => void): () => void {
      statusListeners.add(handler);
      return () => statusListeners.delete(handler);
    },
    openSession(opts: WebRtcSessionOptions): WebRtcSession {
      // Fail loud on a closed transport (bug #8): silently registering a session
      // that can never open leaks it and hangs any ready() awaiter forever.
      if (closed) throw errorWithCode("Transport closed", PIPE_CLOSED_CODE);
      const session = new SessionImpl(opts);
      // A live duplicate sid is explicitly closed first (§3.3) — the old
      // instance announces its own close while it still owns the map slot.
      const existing = sessions.get(session.sid);
      if (existing) existing.close();
      sessions.set(session.sid, session);
      // If the pipe is already up, open immediately; otherwise reopen() runs on connect.
      if (status === "connected") reopenSession(session);
      return session;
    },
    candidateType(): RtcCandidateType | null {
      return peer?.selectedCandidateType() ?? null;
    },
    onCandidateType(handler: (type: RtcCandidateType | null) => void): () => void {
      candidateTypeListeners.add(handler);
      return () => candidateTypeListeners.delete(handler);
    },
    onReconnectProgress(handler: (progress: ReconnectProgress) => void): () => void {
      reconnectProgressListeners.add(handler);
      return () => reconnectProgressListeners.delete(handler);
    },
    sendBulkFrame,
    nudge,
    close(): Promise<void> {
      return hardClose();
    },
  };

  return transport;
}

/** Unguessable, collision-free token for a fallback session id (bug #9). Prefers
 * the platform crypto UUID; falls back to time + randomness where unavailable. */
function randomToken(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
