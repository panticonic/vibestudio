import { encodeRpcJson, decodeRpcJson } from "../wireJson.js";
import { RpcBoundaryError, serializeRpcFailure } from "../errors.js";

import { deserializeRpcFailure } from "../errors.js";
import type { RpcFailure } from "../types.js";

export const FRAME_HEAD = 0x01 as const;
export const FRAME_DATA = 0x02 as const;
export const FRAME_END = 0x03 as const;
export const FRAME_ERROR = 0x04 as const;

export type FrameType =
  | typeof FRAME_HEAD
  | typeof FRAME_DATA
  | typeof FRAME_END
  | typeof FRAME_ERROR;

export interface HeadFramePayload {
  status: number;
  statusText: string;
  headerPairs: Array<[string, string]>;
  finalUrl: string;
}

export interface EndFramePayload {
  bytesIn: number;
}

export interface ErrorFramePayload {
  status: number;
  error: RpcFailure;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeFrame(type: FrameType, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.byteLength);
  frame[0] = type;
  const len = payload.byteLength;
  frame[1] = (len >>> 24) & 0xff;
  frame[2] = (len >>> 16) & 0xff;
  frame[3] = (len >>> 8) & 0xff;
  frame[4] = len & 0xff;
  frame.set(payload, 5);
  return frame;
}

export function encodeHeadFrame(payload: HeadFramePayload): Uint8Array {
  return encodeFrame(FRAME_HEAD, textEncoder.encode(JSON.stringify(payload)));
}

export function encodeDataFrame(bytes: Uint8Array): Uint8Array {
  return encodeFrame(FRAME_DATA, bytes);
}

export function encodeEndFrame(payload: EndFramePayload): Uint8Array {
  return encodeFrame(FRAME_END, textEncoder.encode(JSON.stringify(payload)));
}

export function encodeErrorFrame(payload: ErrorFramePayload): Uint8Array {
  return encodeFrame(FRAME_ERROR, textEncoder.encode(encodeRpcJson(payload)));
}

/**
 * Incremental frame parser. Unread bytes live in `buf[offset..length)`. The
 * buffer grows geometrically and the unread tail moves only when space runs out,
 * so chunked frames and many small frames per chunk both decode in linear time.
 * A fully drained decoder releases its buffer. Each payload handed to `onFrame`
 * is a fresh copy the callback may retain.
 */
export class FrameDecoder {
  private buf = new Uint8Array(0);
  private offset = 0;
  private length = 0;

  constructor(
    private readonly onFrame: (type: FrameType, payload: Uint8Array) => void | Promise<void>
  ) {}

  async push(chunk: Uint8Array): Promise<void> {
    if (chunk.byteLength === 0) return;
    this.append(chunk);
    await this.drain();
  }

  finished(): boolean {
    return this.length === this.offset;
  }

  private append(chunk: Uint8Array): void {
    if (this.length + chunk.byteLength > this.buf.byteLength) {
      const unread = this.length - this.offset;
      const required = unread + chunk.byteLength;
      if (required > this.buf.byteLength) {
        const grown = new Uint8Array(Math.max(required, this.buf.byteLength * 2));
        grown.set(this.buf.subarray(this.offset, this.length));
        this.buf = grown;
      } else {
        this.buf.copyWithin(0, this.offset, this.length);
      }
      this.offset = 0;
      this.length = unread;
    }
    this.buf.set(chunk, this.length);
    this.length += chunk.byteLength;
  }

  private async drain(): Promise<void> {
    while (this.length - this.offset >= 5) {
      const at = this.offset;
      const type = this.buf[at] as FrameType;
      if (
        type !== FRAME_HEAD &&
        type !== FRAME_DATA &&
        type !== FRAME_END &&
        type !== FRAME_ERROR
      ) {
        throw new Error(`Unknown streaming RPC frame type: ${type}`);
      }
      // `>>> 0` keeps lengths >= 2^31 unsigned, matching the encoder.
      const len =
        (((this.buf[at + 1] ?? 0) << 24) |
          ((this.buf[at + 2] ?? 0) << 16) |
          ((this.buf[at + 3] ?? 0) << 8) |
          (this.buf[at + 4] ?? 0)) >>>
        0;
      const total = 5 + len;
      if (this.length - at < total) return;
      const payload = this.buf.slice(at + 5, at + total);
      this.offset = at + total;
      if (this.offset === this.length) {
        this.buf = new Uint8Array(0);
        this.offset = 0;
        this.length = 0;
      }
      await this.onFrame(type, payload);
    }
  }
}

export function parseHeadFrame(payload: Uint8Array): HeadFramePayload {
  return JSON.parse(textDecoder.decode(payload)) as HeadFramePayload;
}

export function parseEndFrame(payload: Uint8Array): EndFramePayload {
  if (payload.byteLength === 0) return { bytesIn: 0 };
  return JSON.parse(textDecoder.decode(payload)) as EndFramePayload;
}

export function parseErrorFrame(payload: Uint8Array): ErrorFramePayload {
  return decodeRpcJson(textDecoder.decode(payload)) as ErrorFramePayload;
}

/**
 * Receive-side demultiplexer for framed loopback streaming. The transport feeds decoded
 * bulk mux frames (`protocol/bulkMux.ts`) in via `push`; each `acquire(streamId)`
 * returns a framed `ReadableStream<Uint8Array>` that the caller hands straight to
 * `decodeFramedResponseToStreaming`. Reusing the one Response builder means the
 * RTC binary `stream()` path is identical to the HTTP one above it — only the
 * byte source differs.
 */
export interface InboundStreamMux {
  /** Register a stream id and obtain its v1-framed body stream. */
  acquire(streamId: number): ReadableStream<Uint8Array>;
  /** Route a decoded v2 frame to its stream; END/ERROR close/error the body. */
  push(streamId: number, type: FrameType, payload: Uint8Array): void;
  /** Error ONE stream (caller abort / receive-cap breach) — its body rejects
   * with `error` and the id is retired exactly like END/ERROR would. */
  fail(streamId: number, error: Error): void;
  /** Error every open stream on transport loss — fail loud, never hang. */
  closeAll(error: Error): void;
  /** Number of streams still open (for keepalive/idle accounting). */
  readonly size: number;
}

export interface InboundStreamMuxOptions {
  /**
   * Bound (bytes) on one stream's frames buffered in its body queue awaiting the
   * consumer. Enforced via a byte-length queuing strategy on the acquired
   * stream, so bytes the consumer has read no longer count. Unset = unbounded
   * (previous behavior).
   */
  maxBufferedBytesPerStream?: number;
  /**
   * Fired when a stream breaches `maxBufferedBytesPerStream`. The mux does NOT
   * fail the stream itself — the owner decides (typically `fail(streamId)` +
   * a wire-level cancel), keeping exactly one failure path per transport.
   */
  onStreamOverflow?: (streamId: number, bufferedBytes: number) => void;
  /**
   * Fired when a frame names a stream this mux has no controller for. Normally
   * benign (the caller cancelled), but it is also the exact place a desynced
   * demux disappears into: garbage bytes decode to wild stream ids and every
   * one of them lands here. Silence at this site is indistinguishable from a
   * dead receive path, so the owner gets told rather than guessing.
   */
  onUnknownStream?: (streamId: number, type: FrameType, byteLength: number) => void;
}

export function createInboundStreamMux(options?: InboundStreamMuxOptions): InboundStreamMux {
  const controllers = new Map<number, ReadableStreamDefaultController<Uint8Array>>();
  // Closed stream ids, to reject re-acquiring one. Stream ids are monotonic per
  // connection (never reused), so this only ever grows — bound it (FIFO-evict the
  // oldest) so a long-lived pipe with many streams doesn't leak memory.
  const closed = new Set<number>();
  const CLOSED_MAX = 1024;
  const markClosed = (id: number): void => {
    closed.add(id);
    if (closed.size > CLOSED_MAX) {
      const oldest = closed.values().next().value;
      if (oldest !== undefined) closed.delete(oldest);
    }
  };

  const close = (streamId: number): void => {
    const controller = controllers.get(streamId);
    if (!controller) return;
    controllers.delete(streamId);
    markClosed(streamId);
    try {
      controller.close();
    } catch {
      // already closed
    }
  };

  const fail = (streamId: number, error: Error): void => {
    const controller = controllers.get(streamId);
    if (!controller) return;
    controllers.delete(streamId);
    markClosed(streamId);
    try {
      controller.error(error);
    } catch {
      // already closed
    }
  };

  const receiveCap = options?.maxBufferedBytesPerStream;

  return {
    acquire(streamId: number): ReadableStream<Uint8Array> {
      if (controllers.has(streamId) || closed.has(streamId)) {
        throw new Error(`Stream id ${streamId} already in use`);
      }
      const source = {
        start(controller: ReadableStreamDefaultController<Uint8Array>) {
          controllers.set(streamId, controller);
        },
        cancel() {
          controllers.delete(streamId);
          markClosed(streamId);
        },
      };
      if (receiveCap === undefined) return new ReadableStream<Uint8Array>(source);
      // Byte-length strategy sized to the cap: `desiredSize` then reads
      // `cap - bufferedBytes`, giving push() an exact buffered-bytes gauge.
      return new ReadableStream<Uint8Array>(source, {
        highWaterMark: receiveCap,
        size: (chunk) => chunk?.byteLength ?? 0,
      });
    },
    push(streamId: number, type: FrameType, payload: Uint8Array): void {
      const controller = controllers.get(streamId);
      if (!controller) {
        options?.onUnknownStream?.(streamId, type, payload.byteLength);
        return; // unknown/closed stream — drop (caller cancelled)
      }
      // Re-emit the inner v1 frame so decodeFramedResponseToStreaming sees the
      // exact bytes it expects. HEAD/DATA flow through; END/ERROR also terminate.
      controller.enqueue(encodeFrame(type, payload));
      if (type === FRAME_END) close(streamId);
      else if (type === FRAME_ERROR) {
        // Surface the error on the body too, then close: decodeFramedResponse
        // turns the ERROR frame into a rejected/errored Response itself, but we
        // must stop feeding this stream.
        close(streamId);
      } else if (receiveCap !== undefined && options?.onStreamOverflow) {
        // desiredSize = cap - buffered bytes; negative means the consumer is
        // more than a full cap behind — fail loud, no silent unbounded buffering.
        const desired = controller.desiredSize;
        if (desired !== null && desired < 0) {
          options.onStreamOverflow(streamId, receiveCap - desired);
        }
      }
    },
    fail,
    closeAll(error: Error): void {
      for (const streamId of [...controllers.keys()]) fail(streamId, error);
    },
    get size(): number {
      return controllers.size;
    },
  };
}

export interface DecodedFramedStream {
  status: number;
  statusText: string;
  headers: [string, string][];
  finalUrl: string;
  body: ReadableStream<Uint8Array>;
}

export interface DecodeFramedStreamOptions {
  /** Called when the decoded response body consumer cancels before END/ERROR. */
  onBodyCancel?: (reason?: unknown) => void;
  /**
   * Explicit caller deadline (ms) for the first HEAD frame. There is no implicit
   * deadline: a slow HEAD (cold service, pending approval) is a valid state, and
   * a dead wire settles through the body stream's own error/close or the
   * caller's AbortSignal. Omitted, `0` or `Infinity` waits for those events.
   */
  headTimeoutMs?: number;
}

/**
 * Decode a framed wire body (HEAD + DATA + END/ERROR frames) into head metadata +
 * a `ReadableStream<Uint8Array>` body — the platform-neutral streaming primitive.
 * Node callers wrap it in a `Response` (`decodeFramedResponseToStreaming`); React
 * Native callers, whose `Response` (whatwg-fetch) cannot consume a ReadableStream
 * body, read `body` directly via `getReader()`.
 */
export async function decodeFramedStream(
  wireBody: ReadableStream<Uint8Array>,
  requestedUrl: string,
  callerSignal?: AbortSignal | null,
  options?: DecodeFramedStreamOptions
): Promise<DecodedFramedStream> {
  let resolveHead!: (head: HeadFramePayload | null) => void;
  let rejectHead!: (error: unknown) => void;
  const headPromise = new Promise<HeadFramePayload | null>((resolve, reject) => {
    resolveHead = resolve;
    rejectHead = reject;
  });
  // HEAD deadline (fail loud, never hang): any settle of headPromise clears it.
  let headTimer: ReturnType<typeof setTimeout> | null = null;
  const clearHeadTimer = (): void => {
    if (headTimer !== null) {
      clearTimeout(headTimer);
      headTimer = null;
    }
  };
  {
    const rawResolveHead = resolveHead;
    const rawRejectHead = rejectHead;
    resolveHead = (head) => {
      clearHeadTimer();
      rawResolveHead(head);
    };
    rejectHead = (error) => {
      clearHeadTimer();
      rawRejectHead(error);
    };
  }
  const headTimeoutMs = options?.headTimeoutMs;
  if (headTimeoutMs !== undefined && Number.isFinite(headTimeoutMs) && headTimeoutMs > 0) {
    headTimer = setTimeout(() => {
      headTimer = null;
      if (!headSeen) {
        rejectHead(new Error(`Streaming RPC HEAD not received within ${headTimeoutMs}ms`));
      }
    }, headTimeoutMs);
    (headTimer as unknown as { unref?: () => void }).unref?.();
  }
  let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let bodyClosed = false;
  let headSeen = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let bodyCancelNotified = false;
  let bodyBytesReceived = 0;
  const notifyBodyCancel = (reason?: unknown): void => {
    if (bodyCancelNotified || bodyClosed) return;
    bodyCancelNotified = true;
    try {
      options?.onBodyCancel?.(reason);
    } catch {
      // Cancellation is best-effort; the local body is already being torn down.
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      bodyController = controller;
    },
    cancel(reason) {
      notifyBodyCancel(reason);
      bodyClosed = true;
      void reader?.cancel(reason).catch(() => undefined);
    },
  });
  const closeBody = (): void => {
    if (bodyClosed) return;
    bodyClosed = true;
    bodyController?.close();
  };
  const errorBody = (error: unknown): void => {
    if (bodyClosed) return;
    bodyClosed = true;
    bodyController?.error(error);
  };
  const abortError = (): Error => {
    const reason = callerSignal?.reason;
    return reason instanceof Error ? reason : new Error("Streaming RPC aborted by caller");
  };
  const onAbort = (): void => {
    const error = abortError();
    if (!headSeen) rejectHead(error);
    errorBody(error);
    void reader?.cancel(error).catch(() => undefined);
  };
  if (callerSignal?.aborted) onAbort();
  else callerSignal?.addEventListener("abort", onAbort, { once: true });
  const decoder = new FrameDecoder((type, payload) => {
    if (type === FRAME_HEAD) {
      try {
        headSeen = true;
        resolveHead(parseHeadFrame(payload));
      } catch (error) {
        rejectHead(error);
      }
      return;
    }
    if (type === FRAME_DATA) {
      const copy = new Uint8Array(payload.byteLength);
      copy.set(payload);
      bodyBytesReceived += copy.byteLength;
      bodyController?.enqueue(copy);
      return;
    }
    if (type === FRAME_END) {
      const end = parseEndFrame(payload);
      if (
        !Number.isSafeInteger(end.bytesIn) ||
        end.bytesIn < 0 ||
        end.bytesIn !== bodyBytesReceived
      ) {
        errorBody(
          new Error(
            `Streaming RPC body length mismatch: expected ${String(end.bytesIn)} bytes, received ${bodyBytesReceived}`
          )
        );
        return;
      }
      closeBody();
      return;
    }
    if (type === FRAME_ERROR) {
      let parsed: ErrorFramePayload;
      try {
        parsed = parseErrorFrame(payload);
      } catch (cause) {
        parsed = {
          status: 502,
          error: serializeRpcFailure(
            new RpcBoundaryError("Malformed streaming RPC error", "protocol", "EPROTOCOL", cause)
          ),
        };
      }
      const error = deserializeRpcFailure(parsed.error);
      if (headSeen) errorBody(error);
      else rejectHead(error);
    }
  });
  reader = wireBody.getReader();
  if (callerSignal?.aborted) onAbort();
  void (async () => {
    try {
      while (true) {
        if (callerSignal?.aborted) throw new Error("Streaming RPC aborted by caller");
        const { value, done } = await reader.read();
        if (done) break;
        if (value) await decoder.push(value);
      }
      if (!headSeen) resolveHead(null);
      closeBody();
    } catch (error) {
      if (!headSeen) rejectHead(error);
      else errorBody(error);
    } finally {
      callerSignal?.removeEventListener("abort", onAbort);
      reader?.releaseLock();
    }
  })();
  const head = await headPromise;
  return {
    status: head?.status ?? 502,
    statusText: head?.statusText ?? "Bad Gateway",
    headers: head?.headerPairs ?? [],
    finalUrl: head?.finalUrl || requestedUrl,
    body: stream,
  };
}

// Statuses whose Response MUST have a null body. `new Response(body, {status})`
// THROWS for these if body is non-null, so a 204/304 from the gateway would crash
// the decode instead of returning the (empty) response. (101 is intentionally NOT
// here: it isn't a constructible Response status — see the clamp below.)
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

export async function decodeFramedResponseToStreaming(
  wireBody: ReadableStream<Uint8Array>,
  requestedUrl: string,
  callerSignal?: AbortSignal | null,
  options?: DecodeFramedStreamOptions
): Promise<Response> {
  const decoded = await decodeFramedStream(wireBody, requestedUrl, callerSignal, options);
  const response = responseFromDecodedStream(decoded);
  // A null-body response has no reader to cancel the unused decoder. Iroh's
  // onBodyCancel sends a remote cancellation, so let that decoder reach END.
  if (!response.body && !options?.onBodyCancel) void decoded.body.cancel().catch(() => {});
  return response;
}

/** One Response construction path for native and duplex framed RPC streams. */
export function responseFromDecodedStream(decoded: DecodedFramedStream): Response {
  // Response only accepts statuses 200-599; preserve the decoder's existing
  // handling of malformed or informational-only headers.
  const status = decoded.status >= 200 && decoded.status <= 599 ? decoded.status : 502;
  const nullBody = NULL_BODY_STATUSES.has(status);
  const response = new Response(
    nullBody ? null : (decoded.body as unknown as ConstructorParameters<typeof Response>[0]),
    {
      status,
      statusText: decoded.statusText,
      headers: new Headers(decoded.headers),
    }
  );
  if (decoded.finalUrl) {
    try {
      Object.defineProperty(response, "url", {
        value: decoded.finalUrl,
        writable: false,
        configurable: true,
      });
    } catch {
      // ignore
    }
  }
  return response;
}
