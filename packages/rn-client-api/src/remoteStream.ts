/**
 * The client half of a streamed RPC over the host broker.
 *
 * It speaks the panel shell bridge's stream protocol (`@vibestudio/rpc`
 * `bridgeStream`): the host half is that module's `createBridgeStreamRelay`,
 * unchanged. Only this half differs. `openBridgeStream` builds a browser
 * `Response`, and a React Native `Response` cannot carry a `ReadableStream`
 * body, so a React Native client reads the decoded head and body directly,
 * which is what `EnvelopeRpcTransport.streamReadable` is for.
 *
 * Flow control is the protocol's: the request body is pumped as awaited chunks
 * (the host resolves each only while its reassembly buffer has room); the host
 * sends one response chunk per ack, and this side defers the ack while its own
 * buffer is over the watermark.
 */
import {
  BRIDGE_STREAM_BUFFER_CAP_BYTES,
  BRIDGE_STREAM_CHUNK_BYTES,
  bytesToBase64,
  decodeBridgeChunk,
  deserializeRpcFailure,
  rpcCallerAbortedError,
  secureRandomUuid,
  serializeRpcFailure,
  type BridgeBodyChunk,
  type BridgeStreamMessage,
  type BridgeStreamOpen,
  type DecodedFramedStream,
  type RpcEnvelope,
} from "@vibestudio/rpc";

/** The five operations a host connection must provide for one session's streams. */
export interface RemoteStreamSurface {
  streamOpen(msg: BridgeStreamOpen): Promise<void>;
  /** Awaited by the pump: the host's resolution is the request-body backpressure. */
  streamBodyChunk(msg: BridgeBodyChunk): Promise<void>;
  streamAbort(opId: string): void;
  streamAck(opId: string, seq: number): void;
  onStreamMessage(handler: (msg: BridgeStreamMessage) => void): () => void;
}

export async function openRemoteStream(
  surface: RemoteStreamSurface,
  envelope: RpcEnvelope,
  signal: AbortSignal | null | undefined,
  body: ReadableStream<Uint8Array> | null
): Promise<DecodedFramedStream> {
  if (signal?.aborted) throw rpcCallerAbortedError(signal.reason);

  const opId = `op-${secureRandomUuid()}`;
  const bodyId = body ? `${opId}#body` : undefined;

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
  // The head is awaited only after the open round trip and the body pump are
  // set up; a failure reported before then must not surface as unhandled.
  headPromise.catch(() => {});

  let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let requestBodyReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let requestBodyPump: Promise<void> | null = null;
  let teardownCompletion: Promise<void> | null = null;
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
        flushAcks();
      },
      cancel(reason) {
        return teardown(rpcCallerAbortedError(reason), { notifyHost: true });
      },
    },
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
      /* already errored or closed */
    }
  };
  const errorBody = (error: Error): void => {
    if (bodyClosed) return;
    bodyClosed = true;
    try {
      bodyController?.error(error);
    } catch {
      /* already errored or closed */
    }
  };

  let pumpAborted = false;
  function teardown(error: Error, options: { notifyHost: boolean }): Promise<void> {
    if (settled) return teardownCompletion ?? Promise.resolve();
    settled = true;
    pumpAborted = true;
    const requestBodyCancellation = requestBodyReader
      ? requestBodyReader.cancel(error)
      : Promise.resolve();
    if (options.notifyHost) {
      try {
        surface.streamAbort(opId);
      } catch {
        /* the broker is gone; the host retires the op with the client */
      }
    }
    unsubscribe?.();
    unsubscribe = null;
    signal?.removeEventListener("abort", onAbort);
    teardownCompletion = Promise.all([
      requestBodyCancellation,
      ...(requestBodyPump ? [requestBodyPump] : []),
    ])
      .then(
        () => error,
        (cleanupError: unknown) =>
          new AggregateError([error, cleanupError], "Remote stream failed during upload cleanup", {
            cause: error,
          })
      )
      .then((failure) => {
        rejectHead(failure);
        errorBody(failure);
      });
    return teardownCompletion;
  }
  const onAbort = (): void => {
    void teardown(rpcCallerAbortedError(signal?.reason), { notifyHost: true });
  };

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
          void teardown(error instanceof Error ? error : new Error(String(error)), {
            notifyHost: true,
          });
          return;
        }
        controller.enqueue(bytes);
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
      case "error":
        void teardown(deserializeRpcFailure(msg.error), { notifyHost: false });
        return;
    }
  });
  signal?.addEventListener("abort", onAbort);
  if (signal?.aborted) onAbort();

  try {
    await surface.streamOpen({ opId, envelope, ...(bodyId ? { bodyId } : {}) });
  } catch (error) {
    await teardown(error instanceof Error ? error : new Error(String(error)), {
      notifyHost: false,
    });
    throw error;
  }

  if (body && bodyId) {
    requestBodyPump = (async () => {
      const reader = body.getReader();
      requestBodyReader = reader;
      let seq = 0;
      try {
        for (;;) {
          if (pumpAborted) {
            await reader.cancel(rpcCallerAbortedError(signal?.reason));
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
            await surface.streamBodyChunk({ bodyId, seq, chunk: bytesToBase64(slice) });
          }
        }
        if (!pumpAborted) await surface.streamBodyChunk({ bodyId, seq: seq + 1, done: true });
      } catch (error) {
        // The caller's stream failed (tell the host so the server settles
        // loudly) or a send was rejected (the host already failed the op).
        if (!pumpAborted) {
          try {
            await surface.streamBodyChunk({
              bodyId,
              seq: seq + 1,
              error: serializeRpcFailure(error),
            });
          } catch {
            /* the op is already gone on the host */
          }
        }
      } finally {
        requestBodyReader = null;
        reader.releaseLock();
      }
    })();
  }

  let head: Extract<BridgeStreamMessage, { kind: "head" }>;
  try {
    head = await headPromise;
  } catch (error) {
    if (requestBodyPump) await requestBodyPump;
    if (teardownCompletion) await teardownCompletion;
    throw error;
  }
  return {
    status: head.status,
    statusText: head.statusText,
    headers: head.headers,
    finalUrl: "",
    body: responseBody,
  };
}
