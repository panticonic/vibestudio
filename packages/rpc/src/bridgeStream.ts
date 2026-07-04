/**
 * §1.6 upload hop for PANEL SHELL BRIDGES.
 *
 * A panel lives in a webview and reaches its server through the shell bridge
 * (`__vibez1Shell` — Electron `contextBridge` on desktop, the React-Native
 * `postMessage` bridge on mobile). Plain RPC envelopes relay transparently, but
 * a streaming REQUEST body (an upload) cannot ride an envelope and the bridge
 * has no native stream type — so the body crosses the bridge as explicit,
 * sequenced chunk messages and the HOST reassembles it into the
 * `ReadableStream<Uint8Array>` it hands to the panel session's first-class
 * `streamReadable(envelope, signal, body)` (the WebRTC bulk-channel path).
 *
 * Wire shape (both platforms; chunks are `Uint8Array` where the bridge passes
 * binary — Electron structured clone — and base64 strings where it is
 * string-only — RN `postMessage` / `injectJavaScript`):
 *
 *   panel → host  streamOpen       { opId, envelope, bodyId }
 *   panel → host  streamBodyChunk  { bodyId, seq, chunk } | { bodyId, seq, done } | { bodyId, seq, error }
 *   panel → host  streamAbort      (opId)                — caller abort / response-body cancel
 *   panel → host  streamAck        (opId, seq)           — response chunk consumed
 *   host → panel  { kind: "head",  opId, status, statusText, headers }
 *   host → panel  { kind: "chunk", opId, seq, chunk }
 *   host → panel  { kind: "end",   opId }
 *   host → panel  { kind: "error", opId, message }
 *
 * Flow control, both directions, no unbounded buffering:
 *  - request body: every `streamBodyChunk` is AWAITED by the panel pump; the
 *    host resolves it only while its reassembly buffer is under the watermark.
 *    A producer that ignores the await hits the hard cap and fails LOUDLY.
 *  - response body: the host sends one chunk at a time and awaits the panel's
 *    `streamAck`; the panel defers the ack while its own buffer is over the
 *    watermark. Caps mirror the WebRTC transport's (8 MiB receive cap,
 *    256 KiB max chunk).
 *
 * This hop is UPLOAD-ONLY: body-less panel streams keep the duplex
 * stream-request/stream-frame envelope path byte-identical (the host's panel
 * session may be a plain loopback WS with no first-class stream at all). A
 * bridge/session that cannot carry a body throws loudly — never a silent
 * fallback (plan §1.6).
 */

import type { RpcEnvelope } from "./types.js";
import type { DecodedFramedStream } from "./protocol/streamCodec.js";
import { base64ToBytes, bytesToBase64 } from "./base64.js";

/** Max bytes per bridge chunk — mirrors the WebRTC transport's MAX_CHUNK_SIZE. */
export const BRIDGE_STREAM_CHUNK_BYTES = 256 * 1024;
/** Hard buffering cap per stream — mirrors STREAM_RECEIVE_CAP_BYTES (8 MiB). */
export const BRIDGE_STREAM_BUFFER_CAP_BYTES = 8 * 1024 * 1024;

export type BridgeChunkEncoding = "binary" | "base64";
/** Binary where the bridge passes it (Electron); base64 where it is string-only (RN). */
export type BridgeChunkPayload = Uint8Array | string;

/** Panel → host: open one upload stream (the bridge's stream-request message). */
export interface BridgeStreamOpen {
  opId: string;
  /** The `stream-request` envelope, relayed raw onto the panel's session. */
  envelope: RpcEnvelope;
  /** Key the request-body chunks arrive under. REQUIRED — this hop is upload-only. */
  bodyId: string;
}

/** Panel → host: one sequenced request-body message. Exactly one of
 * `chunk` / `done` / `error` is set. */
export interface BridgeBodyChunk {
  bodyId: string;
  seq: number;
  chunk?: BridgeChunkPayload;
  done?: boolean;
  error?: string;
}

/** Host → panel: response head / body chunk / terminal. */
export type BridgeStreamMessage =
  | {
      kind: "head";
      opId: string;
      status: number;
      statusText: string;
      headers: [string, string][];
    }
  | { kind: "chunk"; opId: string; seq: number; chunk: BridgeChunkPayload }
  | { kind: "end"; opId: string }
  | { kind: "error"; opId: string; message: string };

export function decodeBridgeChunk(chunk: unknown): Uint8Array {
  if (typeof chunk === "string") return base64ToBytes(chunk);
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  throw new Error("bridge stream chunk must be a Uint8Array or a base64 string");
}

function encodeBridgeChunk(bytes: Uint8Array, encoding: BridgeChunkEncoding): BridgeChunkPayload {
  // Copy the binary slice: it may be a subarray view over a reused buffer.
  return encoding === "base64" ? bytesToBase64(bytes) : bytes.slice();
}

function generateOpId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

// ---------------------------------------------------------------------------
// Host side — bounded request-body reassembly
// ---------------------------------------------------------------------------

export interface BridgeBodyReassembler {
  /** The reassembled request body — hand to the session's `streamReadable`. */
  stream: ReadableStream<Uint8Array>;
  /**
   * Push one decoded chunk. Resolves once the buffer is back under the
   * watermark (this IS the bridge's backpressure: the panel pump awaits it).
   * Rejects loudly — and fails the whole body — if the hard cap is exceeded
   * (a producer that does not await its pushes).
   */
  push(chunk: Uint8Array): Promise<void>;
  end(): void;
  fail(error: Error): void;
}

export function createBridgeBodyReassembler(
  options: { maxBufferedBytes?: number } = {}
): BridgeBodyReassembler {
  const maxBuffered = options.maxBufferedBytes ?? BRIDGE_STREAM_BUFFER_CAP_BYTES;
  // Resume awaited pushes once the consumer drains below half the cap.
  const watermark = Math.max(1, Math.floor(maxBuffered / 2));
  const queue: Uint8Array[] = [];
  let buffered = 0;
  let ended = false;
  let failure: Error | null = null;
  let wakeReader: (() => void) | null = null;
  let drainWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  const notifyReader = (): void => {
    wakeReader?.();
    wakeReader = null;
  };
  const settleDrainWaiters = (err?: Error): void => {
    const waiters = drainWaiters;
    drainWaiters = [];
    for (const waiter of waiters) {
      if (err) waiter.reject(err);
      else waiter.resolve();
    }
  };

  const fail = (error: Error): void => {
    if (failure || ended) {
      // Terminal already — keep the FIRST failure, but still unblock waiters.
      failure = failure ?? error;
    } else {
      failure = error;
    }
    queue.length = 0;
    buffered = 0;
    notifyReader();
    settleDrainWaiters(failure);
  };

  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        for (;;) {
          const chunk = queue.shift();
          if (chunk) {
            buffered -= chunk.byteLength;
            if (buffered <= watermark) settleDrainWaiters();
            controller.enqueue(chunk);
            return;
          }
          if (failure) {
            controller.error(failure);
            return;
          }
          if (ended) {
            controller.close();
            return;
          }
          await new Promise<void>((resolve) => {
            wakeReader = resolve;
          });
        }
      },
      cancel(reason) {
        // The consumer (the pipe pump) gave up — fail the bridge side loudly so
        // the panel's pump stops instead of buffering into the void.
        fail(
          reason instanceof Error
            ? reason
            : new Error(`request body consumer cancelled${reason ? `: ${String(reason)}` : ""}`)
        );
      },
    },
    // highWaterMark 0: pull only when the consumer actually reads, so `buffered`
    // is the real bridge-side backlog. (A plain strategy object — the RN host
    // has the web-streams ponyfill's ReadableStream but not the strategy classes.)
    { highWaterMark: 0 }
  );

  return {
    stream,
    push(chunk: Uint8Array): Promise<void> {
      if (failure) return Promise.reject(failure);
      if (ended) return Promise.reject(new Error("bridge request body already ended"));
      if (buffered + chunk.byteLength > maxBuffered) {
        const error = new Error(
          `bridge request-body buffer overflow: ${buffered + chunk.byteLength} bytes ` +
            `exceeds the ${maxBuffered}-byte cap (body chunks must be awaited)`
        );
        fail(error);
        return Promise.reject(error);
      }
      queue.push(chunk);
      buffered += chunk.byteLength;
      notifyReader();
      if (buffered <= watermark) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        drainWaiters.push({ resolve, reject });
      });
    },
    end(): void {
      if (failure || ended) return;
      ended = true;
      notifyReader();
      settleDrainWaiters();
    },
    fail,
  };
}

// ---------------------------------------------------------------------------
// Host side — the relay (one per panel)
// ---------------------------------------------------------------------------

export interface BridgeStreamRelayDeps {
  /**
   * Open the panel session's first-class stream (the WebRTC session's
   * `streamReadable`). MUST throw when the session has no body-capable stream
   * path (plain loopback WS) — uploads then fail loudly, never silently.
   */
  openStream: (
    envelope: RpcEnvelope,
    signal: AbortSignal,
    body: ReadableStream<Uint8Array>
  ) => Promise<DecodedFramedStream>;
  /** Deliver one host→panel stream message over the bridge. */
  sendToPanel: (msg: BridgeStreamMessage) => void;
  /** Chunk payload encoding the bridge carries (binary on Electron, base64 on RN). */
  chunkFormat: BridgeChunkEncoding;
  maxBufferedBytes?: number;
  chunkBytes?: number;
}

export interface BridgeStreamRelay {
  /** Register + fire one upload stream. Throws on a malformed/duplicate open. */
  open(msg: BridgeStreamOpen): void;
  /** Push one request-body message; the returned promise is the backpressure ack. */
  pushBodyChunk(msg: BridgeBodyChunk): Promise<void>;
  /** Panel-initiated abort (caller signal / response-body cancel). */
  abort(opId: string): void;
  /** Response chunk `seq` was consumed by the panel — release the next one. */
  ack(opId: string, seq: number): void;
  /** Abort every op (panel webview destroyed). */
  destroy(reason?: string): void;
  /** Open op count (observability/tests). */
  size(): number;
}

interface RelayOp {
  opId: string;
  bodyId: string;
  nextBodySeq: number;
  controller: AbortController;
  body: BridgeBodyReassembler;
  acks: Map<number, { resolve: () => void; reject: (err: Error) => void }>;
}

export function createBridgeStreamRelay(deps: BridgeStreamRelayDeps): BridgeStreamRelay {
  const chunkBytes = deps.chunkBytes ?? BRIDGE_STREAM_CHUNK_BYTES;
  const maxBuffered = deps.maxBufferedBytes ?? BRIDGE_STREAM_BUFFER_CAP_BYTES;
  const ops = new Map<string, RelayOp>();
  const opsByBodyId = new Map<string, RelayOp>();

  function cleanup(op: RelayOp): void {
    if (ops.get(op.opId) === op) ops.delete(op.opId);
    if (opsByBodyId.get(op.bodyId) === op) opsByBodyId.delete(op.bodyId);
    const error = new Error(`bridge stream ${op.opId} closed`);
    op.body.fail(error);
    for (const waiter of op.acks.values()) waiter.reject(error);
    op.acks.clear();
  }

  async function run(op: RelayOp, envelope: RpcEnvelope): Promise<void> {
    try {
      const decoded = await deps.openStream(envelope, op.controller.signal, op.body.stream);
      if (op.controller.signal.aborted) return;
      deps.sendToPanel({
        kind: "head",
        opId: op.opId,
        status: decoded.status,
        statusText: decoded.statusText,
        headers: decoded.headers,
      });
      const reader = decoded.body.getReader();
      let seq = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (op.controller.signal.aborted) return;
          if (!value || value.byteLength === 0) continue;
          for (let offset = 0; offset < value.byteLength; offset += chunkBytes) {
            const slice = value.subarray(offset, Math.min(offset + chunkBytes, value.byteLength));
            seq += 1;
            // ONE chunk in flight: the next send waits for the panel's ack, so
            // the panel-side response buffer stays bounded.
            const acked = new Promise<void>((resolve, reject) => {
              op.acks.set(seq, { resolve, reject });
            });
            deps.sendToPanel({
              kind: "chunk",
              opId: op.opId,
              seq,
              chunk: encodeBridgeChunk(slice, deps.chunkFormat),
            });
            await acked;
          }
        }
      } finally {
        reader.releaseLock();
      }
      deps.sendToPanel({ kind: "end", opId: op.opId });
    } catch (error) {
      // Always tell the panel (fail-loud). After a panel-initiated abort this
      // is a harmless no-op — the panel already unsubscribed its opId.
      deps.sendToPanel({
        kind: "error",
        opId: op.opId,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      cleanup(op);
    }
  }

  function abortOp(op: RelayOp, reason: string): void {
    const error = new Error(reason);
    op.body.fail(error);
    for (const waiter of op.acks.values()) waiter.reject(error);
    op.acks.clear();
    // No abort reason: React Native's AbortController types take none.
    op.controller.abort();
    // Drop the op immediately so late body chunks fail as "unknown bodyId"
    // (the panel pump stops on the first rejected send).
    cleanup(op);
  }

  function consumeBodySeq(op: RelayOp, msg: BridgeBodyChunk): void {
    if (!Number.isInteger(msg.seq) || msg.seq <= 0) {
      throw new Error(`bridge body chunk for ${op.bodyId} has invalid seq ${String(msg.seq)}`);
    }
    if (msg.seq !== op.nextBodySeq) {
      throw new Error(
        `bridge body chunk for ${op.bodyId} arrived out of order: expected seq ` +
          `${op.nextBodySeq}, got ${msg.seq}`
      );
    }
    op.nextBodySeq += 1;
  }

  return {
    open(msg: BridgeStreamOpen): void {
      if (!msg || typeof msg.opId !== "string" || msg.opId.length === 0) {
        throw new Error("bridge stream-open: missing opId");
      }
      const envelope = msg.envelope;
      const messageType = (envelope?.message as { type?: unknown } | undefined)?.type;
      if (!envelope || typeof envelope !== "object" || messageType !== "stream-request") {
        throw new Error("bridge stream-open requires a stream-request envelope");
      }
      if (typeof msg.bodyId !== "string" || msg.bodyId.length === 0) {
        // Upload-only hop: body-less streams ride the duplex envelope path.
        throw new Error(
          "bridge stream-open: missing bodyId — body-less streams ride the duplex envelope path"
        );
      }
      if (ops.has(msg.opId)) throw new Error(`bridge stream-open: duplicate opId ${msg.opId}`);
      if (opsByBodyId.has(msg.bodyId)) {
        throw new Error(`bridge stream-open: duplicate bodyId ${msg.bodyId}`);
      }
      const op: RelayOp = {
        opId: msg.opId,
        bodyId: msg.bodyId,
        nextBodySeq: 1,
        controller: new AbortController(),
        body: createBridgeBodyReassembler({ maxBufferedBytes: maxBuffered }),
        acks: new Map(),
      };
      ops.set(op.opId, op);
      opsByBodyId.set(op.bodyId, op);
      void run(op, envelope);
    },

    pushBodyChunk(msg: BridgeBodyChunk): Promise<void> {
      const op = msg ? opsByBodyId.get(msg.bodyId) : undefined;
      if (!op) {
        return Promise.reject(
          new Error(`bridge body chunk for unknown bodyId ${String(msg?.bodyId)}`)
        );
      }
      try {
        consumeBodySeq(op, msg);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        abortOp(op, error.message);
        return Promise.reject(error);
      }
      if (typeof msg.error === "string") {
        op.body.fail(new Error(`panel request body failed: ${msg.error}`));
        return Promise.resolve();
      }
      if (msg.done === true) {
        op.body.end();
        return Promise.resolve();
      }
      return op.body.push(decodeBridgeChunk(msg.chunk));
    },

    abort(opId: string): void {
      const op = ops.get(opId);
      if (op) abortOp(op, `bridge stream ${opId} aborted by the panel`);
    },

    ack(opId: string, seq: number): void {
      const waiter = ops.get(opId)?.acks.get(seq);
      if (!waiter) return;
      ops.get(opId)?.acks.delete(seq);
      waiter.resolve();
    },

    destroy(reason = "bridge stream relay destroyed"): void {
      for (const op of [...ops.values()]) abortOp(op, reason);
    },

    size(): number {
      return ops.size;
    },
  };
}

// ---------------------------------------------------------------------------
// Panel side — the shell-bridge surface + the upload caller
// ---------------------------------------------------------------------------

/**
 * The stream surface a body-capable shell bridge exposes on `__vibez1Shell`.
 * Desktop wires these to `ipcRenderer` channels (binary chunks); mobile's
 * injected bootstrap wires them to the `postMessage` bridge (base64 chunks).
 */
export interface BridgeStreamShellSurface {
  streamOpen(msg: BridgeStreamOpen): Promise<void> | void;
  /** MUST be awaited by the pump — the host's resolution is the backpressure. */
  streamBodyChunk(msg: BridgeBodyChunk): Promise<void> | void;
  streamAbort(opId: string): void;
  streamAck(opId: string, seq: number): void;
  onStreamMessage(handler: (msg: BridgeStreamMessage) => void): () => void;
  /** Chunk payload encoding this bridge carries. Defaults to base64. */
  streamChunkFormat?: BridgeChunkEncoding;
}

/** Feature-detect the upload surface on a shell bridge (null = bridge cannot
 * carry a body; the RPC core then throws the §1.6 error). */
export function bridgeStreamSurfaceOf(shell: unknown): BridgeStreamShellSurface | null {
  const s = shell as Partial<BridgeStreamShellSurface> | null | undefined;
  if (
    !s ||
    typeof s.streamOpen !== "function" ||
    typeof s.streamBodyChunk !== "function" ||
    typeof s.streamAbort !== "function" ||
    typeof s.streamAck !== "function" ||
    typeof s.onStreamMessage !== "function"
  ) {
    return null;
  }
  return s as BridgeStreamShellSurface;
}

/** Statuses whose `Response` must have a null body. */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function constructibleResponseStatus(status: number): number {
  return status >= 200 && status <= 599 ? status : 502;
}

/**
 * Open one upload stream over the shell bridge: pump `body` across as awaited
 * chunk messages and assemble the host's head/chunk/end messages into a
 * `Response`. This is the panel transport's `streamBody` implementation.
 */
export async function openBridgeUploadStream(
  surface: BridgeStreamShellSurface,
  envelope: RpcEnvelope,
  signal: AbortSignal | null | undefined,
  body: ReadableStream<Uint8Array>
): Promise<Response> {
  const abortReason = (): Error => new Error("bridge upload stream aborted");
  if (signal?.aborted) throw abortReason();

  const opId = generateOpId();
  const bodyId = `${opId}#body`;
  const encoding: BridgeChunkEncoding =
    surface.streamChunkFormat === "binary" ? "binary" : "base64";

  let settled = false;
  let unsubscribe: (() => void) | null = null;
  let resolveHead!: (msg: Extract<BridgeStreamMessage, { kind: "head" }>) => void;
  let rejectHead!: (error: Error) => void;
  const headPromise = new Promise<Extract<BridgeStreamMessage, { kind: "head" }>>(
    (resolve, reject) => {
      resolveHead = resolve;
      rejectHead = reject;
    }
  );

  let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let bodyClosed = false;
  const pendingAcks: number[] = [];
  const flushAcks = (): void => {
    for (;;) {
      const seq = pendingAcks.shift();
      if (seq === undefined) return;
      surface.streamAck(opId, seq);
    }
  };
  const responseBody = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        bodyController = controller;
      },
      pull() {
        // The consumer drained below the watermark — release the host's pump.
        flushAcks();
      },
      cancel() {
        // Response-body cancel = caller abandoned the stream: abort the op.
        teardown(abortReason(), { notifyHost: true });
      },
    },
    // Byte-length strategy as a plain object (no strategy-class dependency):
    // desiredSize > 0 ⇔ buffered under the watermark ⇒ ack immediately.
    {
      highWaterMark: BRIDGE_STREAM_BUFFER_CAP_BYTES / 2,
      size: (chunk?: Uint8Array) => chunk?.byteLength ?? 0,
    }
  );

  const closeBody = (): void => {
    if (bodyClosed) return;
    bodyClosed = true;
    try {
      bodyController?.close();
    } catch {
      /* already errored/closed */
    }
  };
  const errorBody = (error: Error): void => {
    if (bodyClosed) return;
    bodyClosed = true;
    try {
      bodyController?.error(error);
    } catch {
      /* already errored/closed */
    }
  };

  let pumpAborted = false;
  function teardown(error: Error, opts: { notifyHost: boolean }): void {
    if (settled) return;
    settled = true;
    pumpAborted = true;
    if (opts.notifyHost) {
      try {
        surface.streamAbort(opId);
      } catch {
        /* bridge gone */
      }
    }
    rejectHead(error);
    errorBody(error);
    unsubscribe?.();
    unsubscribe = null;
    signal?.removeEventListener("abort", onAbort);
  }
  const onAbort = (): void => teardown(abortReason(), { notifyHost: true });

  unsubscribe = surface.onStreamMessage((msg) => {
    if (!msg || (msg as { opId?: string }).opId !== opId) return;
    switch (msg.kind) {
      case "head":
        resolveHead(msg);
        return;
      case "chunk": {
        const controller = bodyController;
        if (bodyClosed || !controller) return;
        let bytes: Uint8Array;
        try {
          bytes = decodeBridgeChunk(msg.chunk);
        } catch (error) {
          teardown(error instanceof Error ? error : new Error(String(error)), {
            notifyHost: true,
          });
          return;
        }
        controller.enqueue(bytes);
        // Ack now while under the watermark; defer to the next pull otherwise
        // so the panel-side buffer stays bounded (the host sends one chunk per
        // ack).
        if ((controller.desiredSize ?? 1) > 0) surface.streamAck(opId, msg.seq);
        else pendingAcks.push(msg.seq);
        return;
      }
      case "end":
        settled = true;
        closeBody();
        unsubscribe?.();
        unsubscribe = null;
        signal?.removeEventListener("abort", onAbort);
        return;
      case "error": {
        const error = new Error(msg.message);
        settled = true;
        pumpAborted = true;
        rejectHead(error);
        errorBody(error);
        unsubscribe?.();
        unsubscribe = null;
        signal?.removeEventListener("abort", onAbort);
        return;
      }
    }
  });
  signal?.addEventListener("abort", onAbort);

  try {
    await surface.streamOpen({ opId, envelope, bodyId });
  } catch (error) {
    teardown(error instanceof Error ? error : new Error(String(error)), { notifyHost: false });
    throw error;
  }

  // Pump the caller's body across the bridge. Every send is awaited: the host
  // resolves it only while its reassembly buffer has room.
  void (async () => {
    const reader = body.getReader();
    let seq = 0;
    try {
      for (;;) {
        if (pumpAborted) {
          await reader.cancel(abortReason());
          return;
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        for (
          let offset = 0;
          offset < value.byteLength && !pumpAborted;
          offset += BRIDGE_STREAM_CHUNK_BYTES
        ) {
          const slice = value.subarray(
            offset,
            Math.min(offset + BRIDGE_STREAM_CHUNK_BYTES, value.byteLength)
          );
          seq += 1;
          await surface.streamBodyChunk({ bodyId, seq, chunk: encodeBridgeChunk(slice, encoding) });
        }
      }
      if (!pumpAborted) await surface.streamBodyChunk({ bodyId, seq: seq + 1, done: true });
    } catch (error) {
      // Either the caller's stream failed (tell the host so the server settles
      // loudly) or a send was rejected (the host already failed the op — the
      // extra error send below rejects too and is swallowed).
      if (!pumpAborted) {
        try {
          await surface.streamBodyChunk({
            bodyId,
            seq: seq + 1,
            error: error instanceof Error ? error.message : String(error),
          });
        } catch {
          /* op already gone host-side */
        }
      }
    } finally {
      reader.releaseLock();
    }
  })();

  const head = await headPromise;
  const status = constructibleResponseStatus(head.status);
  if (NULL_BODY_STATUSES.has(status)) {
    // These statuses forbid a Response body; the wire sends no chunks for them.
    return new Response(null, {
      status,
      statusText: head.statusText,
      headers: head.headers,
    });
  }
  // `as never`: this function only ever runs inside a panel WEBVIEW (a real
  // browser), whose Response consumes a ReadableStream body. React Native's
  // whatwg-fetch typings (checked when the mobile host compiles this module
  // graph) disagree — but RN hosts use the relay side of this file, never this.
  return new Response(responseBody as never, {
    status,
    statusText: head.statusText,
    headers: head.headers,
  });
}
