/**
 * `SessionWebSocketShim` — the adapter that lets the WebRTC pipe reuse the
 * ENTIRE battle-tested per-connection server machinery (rpcServer's
 * `handleConnection`/`handleAuth`/`handleMessage`/`handleClose` + the
 * `createWsServerTransport` bridge with its close-time `CONNECTION_LOST`
 * synthesis) per **logical session**, with zero changes to that machinery.
 *
 * Each logical panel/shell session over the pipe gets one shim that quacks like
 * the `ws` object rpcServer expects. Inbound `SessionControlFrame`s are
 * translated into the `ws:*` client messages rpcServer parses; the `ws:*` server
 * messages rpcServer emits via `ws.send()` are translated back into
 * `SessionControlFrame`s on the control channel. Stream frames never ride
 * `ws.send()`: rpcServer duck-types the shim's `sendStreamFrame` (plan §2.3),
 * hands it RAW payload bytes for the BULK channel, and awaits the write, so the
 * pipe's bounded bulk queue is the end-to-end backpressure signal and the
 * base64→JSON→parse→base64 quadruple copy is gone.
 * One shim per session ⇒ per-session bridge ⇒ independent close-time failure
 * synthesis for free.
 *
 * This keeps exactly one server RPC implementation (the fail-loud rule): the
 * WebRTC answerer is a translation layer, not a parallel server.
 */

import { FRAME_END, FRAME_ERROR } from "@vibestudio/rpc/protocol/streamCodec";
import type { StreamFrameType } from "@vibestudio/rpc/protocol/bulkMux";
import { isTerminalCloseCode } from "@vibestudio/rpc/protocol/closeCodes";
import {
  encodeControlFrame,
  SESSION_CLOSED,
  SESSION_EVENT,
  SESSION_OPEN_RESULT,
  SESSION_ROUTED,
  SESSION_ROUTED_EVENT_ERROR,
  SESSION_ROUTED_RESPONSE_ERROR,
  SESSION_RPC,
  type SessionControlFrame,
} from "@vibestudio/rpc/protocol/sessionNegotiation";
import type { CallerKind } from "@vibestudio/shared/serviceDispatcher";
import type { WsClientMessage, WsServerMessage } from "@vibestudio/shared/ws/protocol";

/** Lane key for pipe-level control frames (no owning session). */
export const PIPE_LANE = "__pipe";

/**
 * Write surface of one WebRTC pipe (answerer side) — the contract the answerer
 * transport implements and `attachWebRtcPipe`/the shims write against.
 */
export interface PipeChannels {
  /**
   * Write a serialized control frame. `lane` keys the pipe's fragment
   * scheduler (round-robin fairness across sessions): the owning session's sid
   * for session frames, `PIPE_LANE` for pipe-level frames. Resolves when this
   * frame's fragments have been sent — the per-session backpressure signal.
   */
  writeControl(data: Uint8Array, lane?: string): Promise<void>;
  /**
   * Enqueue one bulk mux frame. Resolves when the frame has been accepted and
   * sent — the pipe's queue is bounded, so this promise IS the backpressure
   * signal a stream producer must await.
   */
  writeBulkFrame(streamId: number, type: StreamFrameType, payload: Uint8Array): Promise<void>;
  /** Discard any queued-but-unsent bulk frames for one stream (cancellation). */
  dropBulkStream(streamId: number): void;
  /** Bulk bytes accepted but not yet sent (whole pipe, or one stream). */
  bulkPendingBytes(streamId?: number): number;
  /** Whole-pipe control-channel buffered amount (shared across sessions). */
  controlBufferedAmount?(): number;
}

/** Shared stream-id ⇄ requestId maps so server stream-frames hit the right bulk id. */
export interface StreamIdMaps {
  idByRequest: Map<string, number>;
  requestByStream: Map<number, string>;
}

const WS_OPEN = 1;
const WS_CLOSED = 3;
const encoder = new TextEncoder();

type WsHandler = (...args: unknown[]) => void;

/**
 * Implements just the subset of the `ws` WebSocket surface that rpcServer uses:
 * on/off/once("message"|"close"), send, close, terminate, readyState,
 * bufferedAmount — plus the binary stream surface (`sendStreamFrame`) rpcServer
 * duck-types on the streaming hot path. Cast to `WebSocket` at the call site.
 */
export class SessionWebSocketShim {
  // WebSocket readyState constants as INSTANCE properties. `wsServerTransport`
  // guards on `ws.readyState !== ws.OPEN`; without `ws.OPEN` defined here it is
  // `undefined`, so a live session always compares unequal and reads as closed —
  // server→panel and panel↔panel RPC then reject CONNECTION_LOST over a healthy
  // pipe. Mirror the standard WebSocket constant values.
  readonly CONNECTING = 0;
  readonly OPEN = WS_OPEN;
  readonly CLOSING = 2;
  readonly CLOSED = WS_CLOSED;
  private state = WS_OPEN;
  private readonly messageHandlers = new Set<WsHandler>();
  private readonly closeHandlers = new Set<WsHandler>();
  // Per-shim stream id maps: a stream belongs to its session, so dropping the shim
  // (session close / re-open) GC's its entries with it — no leak even if a panel
  // navigates away mid-stream before END/ERROR. A pipe-shared map would instead
  // grow unbounded over a long-lived pipe with churny panels.
  private readonly streams: StreamIdMaps = {
    idByRequest: new Map(),
    requestByStream: new Map(),
  };
  /**
   * Inbound request bodies (plan §1.6), keyed by requestId. `body` is handed out
   * exactly once (`takeInboundBody`); `drop` errors the feeding pipe-level
   * registration and runs on stream reap/cancel and on session close, so a
   * half-fed upload never outlives its request or leaks across sessions.
   */
  private readonly inboundBodies = new Map<
    string,
    { body: ReadableStream<Uint8Array> | null; drop: () => void }
  >();
  /** Control bytes this session has enqueued that have not yet drained. */
  private pendingControlBytes = 0;
  /** Bulk bytes this session has enqueued whose write has not yet settled. */
  private pendingBulkBytes = 0;

  constructor(
    private readonly sid: string,
    private readonly pipe: PipeChannels,
    private readonly onClosed: (sid: string) => void
  ) {}

  get readyState(): number {
    return this.state;
  }

  /**
   * This session's OWN un-drained bytes — control AND bulk — not the shared
   * pipe buffer, so `sendToWs`'s soft/hard backpressure limits see stream
   * traffic and throttle/terminate the flooding session, never a healthy
   * co-tenant.
   */
  get bufferedAmount(): number {
    return this.pendingControlBytes + this.pendingBulkBytes;
  }

  on(event: string, handler: WsHandler): this {
    if (event === "message") this.messageHandlers.add(handler);
    else if (event === "close") this.closeHandlers.add(handler);
    return this;
  }

  once(event: string, handler: WsHandler): this {
    return this.on(event, handler);
  }

  off(event: string, handler: WsHandler): this {
    if (event === "message") this.messageHandlers.delete(handler);
    else if (event === "close") this.closeHandlers.delete(handler);
    return this;
  }

  removeListener(event: string, handler: WsHandler): this {
    return this.off(event, handler);
  }

  /** rpcServer → client: translate the ws:* message to control/bulk frames. */
  send(data: string): void {
    if (this.state !== WS_OPEN) return;
    let msg: WsServerMessage;
    try {
      msg = JSON.parse(data) as WsServerMessage;
    } catch {
      return;
    }
    this.translateOutbound(msg);
  }

  /**
   * Binary stream hot path (plan §2.3): write one stream frame's RAW payload
   * bytes straight onto the bulk channel, keyed by the streamId the client
   * allocated in its `stream-open`. Returns `false` when the requestId has no
   * registered streamId (client cancelled / unknown / session closed) so the
   * caller drops the frame; otherwise returns the metered write promise — the
   * caller MUST await it (bounded bulk queue = end-to-end backpressure).
   */
  sendStreamFrame(
    requestId: string,
    frameType: StreamFrameType,
    payload: Uint8Array
  ): Promise<void> | false {
    if (this.state !== WS_OPEN) return false;
    const streamId = this.streams.idByRequest.get(requestId);
    if (streamId === undefined) return false;
    const written = this.writeBulkMetered(streamId, frameType, payload);
    if (frameType === FRAME_END || frameType === FRAME_ERROR) {
      this.reapStream(requestId, streamId);
    }
    return written;
  }

  close(code?: number, reason?: string): void {
    if (this.state === WS_CLOSED) return;
    // Server-initiated close (lease revoke/retire, auth fail) → terminate the
    // session on the client. Terminal codes mean "do not auto-reopen" — the set
    // is shared with the WS transport (see closeCodes.ts) so both classify alike.
    const terminal = code !== undefined && isTerminalCloseCode(code);
    this.writeFrame({ t: SESSION_CLOSED, sid: this.sid, code, reason, terminal });
    this.fireClosed(code, reason);
  }

  terminate(): void {
    this.close(1006, "terminated");
  }

  // --- driven by the pipe demux (rpcServer.attachWebRtcPipe) ---------------

  /** Feed an inbound ws:* client message (built from a SessionControlFrame). */
  deliverInbound(msg: WsClientMessage): void {
    if (this.state !== WS_OPEN) return;
    const buf = Buffer.from(JSON.stringify(msg));
    for (const handler of [...this.messageHandlers]) handler(buf);
  }

  /** The client closed this session (or the pipe dropped) — run handleClose. */
  remoteClosed(code?: number, reason?: string): void {
    this.fireClosed(code, reason);
  }

  /** Record a client-allocated stream id (from stream-open) so outbound stream
   * frames can be re-keyed onto the bulk channel. */
  registerStream(requestId: string, streamId: number): void {
    this.streams.idByRequest.set(requestId, streamId);
    this.streams.requestByStream.set(streamId, requestId);
  }

  /**
   * Register the assembled inbound request body for a stream-open that declared
   * a `bodyStreamId` (plan §1.6). `drop` is the pipe-level teardown hook: it
   * errors the body's feeding controller and unregisters the bulk route.
   */
  registerInboundBody(requestId: string, body: ReadableStream<Uint8Array>, drop: () => void): void {
    // A duplicate requestId means the client re-used an id — tear the old body
    // down (fail loud on its consumer) rather than silently cross-feeding.
    this.inboundBodies.get(requestId)?.drop();
    this.inboundBodies.set(requestId, { body, drop });
  }

  /**
   * Hand the inbound request body to the dispatch path (handleWsStreamRequest
   * duck-types this, like `sendStreamFrame`). Single consumption: a second take
   * returns undefined. The teardown hook stays armed until the stream reaps.
   */
  takeInboundBody(requestId: string): ReadableStream<Uint8Array> | undefined {
    const entry = this.inboundBodies.get(requestId);
    if (!entry || entry.body === null) return undefined;
    const body = entry.body;
    entry.body = null;
    return body;
  }

  private dropInboundBody(requestId: string): void {
    const entry = this.inboundBodies.get(requestId);
    if (!entry) return;
    this.inboundBodies.delete(requestId);
    entry.drop();
  }

  /**
   * Client cancelled a stream (stream-cancel). Ordering contract (plan §2.4):
   *  1. `dropBulkStream` — discard the queued backlog for this stream;
   *  2. reap the id maps — late producer frames find no streamId and drop;
   *  3. inward `stream-cancel` — fires the server-side abort (wsStreamAborts)
   *     so the producer stops reading/encoding.
   *
   * Deliberately NO settle-ERROR frame back to the client: the client settles
   * its local stream on abort BEFORE sending stream-cancel (webrtcClient
   * beginStream fails the mux entry and reaps the id), so an ERROR here would
   * land as unknown-streamId and be dropped. It would also be self-defeating:
   * the ERROR would enqueue under this streamId's scheduler key, and the very
   * next `dropBulkStream` (frameScheduler.dropKey) would discard it unsent.
   */
  cancelStream(streamId: number): void {
    const requestId = this.streams.requestByStream.get(streamId);
    if (requestId === undefined) return;
    this.pipe.dropBulkStream(streamId);
    this.reapStream(requestId, streamId);
    this.deliverInbound({
      type: "ws:rpc",
      envelope: {
        from: "",
        target: "main",
        delivery: { caller: { callerId: "", callerKind: "unknown" } },
        provenance: [],
        message: { type: "stream-cancel", requestId, fromId: "" },
      },
    });
  }

  private reapStream(requestId: string, streamId: number): void {
    this.streams.idByRequest.delete(requestId);
    this.streams.requestByStream.delete(streamId);
    // The request settled (END/ERROR/cancel): an unfinished inbound body has no
    // consumer left — drop it so late DATA frames route nowhere and the feeding
    // controller errors instead of buffering forever.
    this.dropInboundBody(requestId);
  }

  private fireClosed(code?: number, reason?: string): void {
    if (this.state === WS_CLOSED) return;
    this.state = WS_CLOSED;
    // Session gone (client close / pipe down / supersede): every inbound body
    // errors — a handler mid-consume fails loudly, nothing hangs (plan §1.6).
    for (const requestId of [...this.inboundBodies.keys()]) this.dropInboundBody(requestId);
    const reasonBuf = Buffer.from(reason ?? "");
    for (const handler of [...this.closeHandlers]) handler(code ?? 1006, reasonBuf);
    this.onClosed(this.sid);
  }

  private writeFrame(frame: SessionControlFrame): void {
    const bytes = encoder.encode(encodeControlFrame(frame));
    // Meter this session's un-drained control bytes: writeControl resolves once
    // these have drained off the control channel, so bufferedAmount reflects THIS
    // session's backlog (not the shared pipe buffer). Lane = this session's sid,
    // so the pipe's fragment scheduler round-robins fairly across sessions.
    this.pendingControlBytes += bytes.byteLength;
    const settle = (): void => {
      this.pendingControlBytes -= bytes.byteLength;
    };
    void Promise.resolve(this.pipe.writeControl(bytes, this.sid)).then(settle, settle);
  }

  /**
   * Write one bulk frame, metering its payload bytes into `pendingBulkBytes`
   * until the pipe's write promise settles (success OR failure). Returns the
   * ORIGINAL write promise so awaiting callers observe rejections (pipe down
   * mid-stream must fail the producer loudly, not truncate silently).
   */
  private writeBulkMetered(
    streamId: number,
    type: StreamFrameType,
    payload: Uint8Array
  ): Promise<void> {
    const size = payload.byteLength;
    this.pendingBulkBytes += size;
    const written = this.pipe.writeBulkFrame(streamId, type, payload);
    const settle = (): void => {
      this.pendingBulkBytes -= size;
    };
    written.then(settle, settle);
    return written;
  }

  private translateOutbound(msg: WsServerMessage): void {
    switch (msg.type) {
      case "ws:auth-result": {
        if (msg.success) {
          this.writeFrame({
            t: SESSION_OPEN_RESULT,
            sid: this.sid,
            success: true,
            callerId: msg.callerId,
            callerKind: msg.callerKind as CallerKind | undefined,
            connectionId: msg.connectionId,
            serverBootId: msg.serverBootId,
            sessionDirty: msg.sessionDirty,
            deviceCredential: msg.deviceCredential,
          });
        } else {
          // An auth failure is terminal for this session (invalid grant / lease
          // denied); the host re-mints a grant and opens a fresh session if needed.
          this.writeFrame({
            t: SESSION_OPEN_RESULT,
            sid: this.sid,
            success: false,
            error: msg.error,
            terminal: true,
          });
        }
        return;
      }
      case "ws:routed":
        this.writeFrame({ t: SESSION_ROUTED, sid: this.sid, envelope: msg.envelope });
        return;
      case "ws:event":
        this.writeFrame({
          t: SESSION_EVENT,
          sid: this.sid,
          event: msg.event,
          payload: msg.payload,
        });
        return;
      case "ws:rpc":
        // Always a plain RPC frame (request/response/event from the server→client
        // bridge, or a response from the server dispatcher). A `stream-frame`
        // can never arrive here: rpcServer's only JSON stream-frame producer is
        // handleWsStreamRequest's plain-WS fallback, which is unreachable for a
        // shim (it duck-types `sendStreamFrame`, which every shim has), and the
        // per-client bridge never emits stream-frames (rpcServer delivers only
        // response/event/stream-frame INTO a bridge, so its serving path never
        // runs). Routed caller↔caller stream frames travel as `ws:routed`.
        this.writeFrame({ t: SESSION_RPC, sid: this.sid, envelope: msg.envelope as never });
        return;
      case "ws:routed-response-error":
        this.writeFrame({
          t: SESSION_ROUTED_RESPONSE_ERROR,
          sid: this.sid,
          targetId: msg.targetId,
          requestId: msg.requestId,
          error: msg.error,
          errorCode: msg.errorCode,
        });
        return;
      case "ws:routed-event-error":
        this.writeFrame({
          t: SESSION_ROUTED_EVENT_ERROR,
          sid: this.sid,
          targetId: msg.targetId,
          event: msg.event,
          error: msg.error,
          errorCode: msg.errorCode,
        });
        return;
      default:
        return;
    }
  }
}
