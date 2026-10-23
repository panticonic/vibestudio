import {
  IROH_WIRE_VERSION,
  IROH_CATASTROPHIC_ACTIVE_REQUEST_CEILING,
  MAX_ENVELOPE_FRAME_BYTES,
  MAX_STREAM_CHUNK_BYTES,
  irohStreamStopCode,
  readToEnd,
  writeChunked,
  writeIrohStreamPreamble,
  type IrohPhysicalBiStream,
  type IrohPhysicalConnection,
} from "@vibestudio/iroh-transport";
import {
  decodeRpcJson,
  encodeRpcJson,
  responseEnvelopeFor,
  formatRpcFailure,
  isRpcConnectionLost,
  type RpcEnvelope,
  type RpcMessage,
  type RpcRequest,
  type RpcStreamRequest,
} from "@vibestudio/rpc";
import {
  encodeHeadFrame,
  encodeDataFrame,
  encodeEndFrame,
  encodeErrorFrame,
} from "@vibestudio/rpc/protocol/streamCodec";
import {
  IROH_SESSION_CLOSED,
  IROH_SESSION_OPEN_RESULT,
  type IrohSessionControlFrame,
} from "@vibestudio/rpc/protocol/irohSession";
import type { WsClientMessage, WsServerMessage } from "@vibestudio/shared/ws/protocol";
import type { RpcSessionChannel, RpcSessionTransportBinding } from "./rpcServer/sessionChannel.js";
import type { StreamFrame } from "./services/egressProxy.js";

const OPEN = 1;
const CLOSED = 3;
const STREAM_CANCEL_CODE = 0x202n;
/** The codes this protocol stops or resets a stream with on purpose. */
const PEER_STOP_CODES: ReadonlySet<bigint> = new Set([0x201n, STREAM_CANCEL_CODE]);

/**
 * A write failed because the peer stopped that stream with a code of the
 * protocol's own: it cancelled the request, or closed its session. Delivering
 * to a peer that no longer wants the stream is the cancellation working, so
 * it is neither an outbound failure nor a failure of the session's retirement.
 */
function peerStoppedStream(error: unknown): boolean {
  const code = irohStreamStopCode(error);
  return code !== null && PEER_STOP_CODES.has(code);
}

interface RequestRoute {
  stream: IrohPhysicalBiStream;
  envelope: RpcEnvelope & { message: RpcRequest | RpcStreamRequest };
  streaming: boolean;
  method: string;
  settled: boolean;
  headSent: boolean;
}

function envelopeOperation(envelope: RpcEnvelope): string {
  switch (envelope.message.type) {
    case "request":
    case "stream-request":
      return envelope.message.method;
    case "event":
      return `event:${envelope.message.event}`;
    case "response":
      return `response:${envelope.message.requestId}`;
    default:
      return envelope.message.type;
  }
}

export interface IrohRpcSessionChannelOptions {
  sid: string;
  connection: IrohPhysicalConnection;
  /** Device key the connection's endpoint delegation proved. */
  deviceKey: string;
  writeControl(frame: IrohSessionControlFrame): Promise<void>;
  onClosed(sid: string): void;
  log?(message: string): void;
}

/**
 * One authenticated Iroh logical session exposed through RpcServer's small
 * transport-neutral session-socket contract. Lifecycle alone uses the
 * connection control stream; every RPC envelope and response stays on its own
 * QUIC stream.
 */
export class IrohRpcSessionChannel implements RpcSessionChannel {
  readonly CONNECTING = 0;
  readonly OPEN = OPEN;
  readonly CLOSING = 2;
  readonly CLOSED = CLOSED;
  private state = OPEN;
  private readonly messageHandlers = new Set<
    (message: WsClientMessage, encodedBytes: number) => void
  >();
  private readonly closeHandlers = new Set<(code: number, reason: string) => void>();
  private readonly errorHandlers = new Set<(error: unknown) => void>();
  private readonly requests = new Map<string, RequestRoute>();
  private readonly inboundBodies = new Map<string, ReadableStream<Uint8Array>>();
  private readonly ownedWork = new Set<Promise<void>>();
  private readonly ownedFailures: unknown[] = [];
  private readonly lifetimePromise: Promise<void>;
  private resolveLifetime!: () => void;
  private rejectLifetime!: (error: unknown) => void;
  private pendingBytes = 0;

  readonly transportBinding: RpcSessionTransportBinding;

  constructor(private readonly options: IrohRpcSessionChannelOptions) {
    this.transportBinding = { kind: "iroh", deviceKey: options.deviceKey };
    this.lifetimePromise = new Promise<void>((resolve, reject) => {
      this.resolveLifetime = resolve;
      this.rejectLifetime = reject;
    });
  }

  get peerEndpointId(): string {
    return this.options.connection.peerEndpointId;
  }

  get readyState(): number {
    return this.state;
  }

  get bufferedAmount(): number {
    return this.pendingBytes;
  }

  onMessage(handler: (message: WsClientMessage, encodedBytes: number) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onClose(handler: (code: number, reason: string) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  onError(handler: (error: unknown) => void): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  sendMessage(message: WsServerMessage): void {
    if (this.state !== OPEN) return;
    this.own(this.translateOutbound(message), (error) => {
      this.options.log?.(
        `Iroh session ${this.options.sid} outbound failure: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
  }

  close(code?: number, reason?: string): Promise<void> {
    if (this.state !== OPEN) return this.lifetime();
    const notification = this.options.writeControl({
      t: IROH_SESSION_CLOSED,
      sid: this.options.sid,
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
      terminal: code !== undefined && code >= 4000,
    });
    const joinedNotification = notification.catch((error) => {
      this.logControlFailure("close notification", error);
      if (!isRpcConnectionLost(error)) throw error;
    });
    return this.fireClosed(code, reason, [joinedNotification]);
  }

  terminate(): Promise<void> {
    if (this.state !== OPEN) return this.lifetime();
    const notification = this.options.writeControl({
      t: IROH_SESSION_CLOSED,
      sid: this.options.sid,
      code: 1006,
      reason: "terminated",
      terminal: true,
    });
    const joinedNotification = notification.catch((error) => {
      this.logControlFailure("termination notification", error);
      if (!isRpcConnectionLost(error)) throw error;
    });
    return this.fireClosed(1006, "terminated", [joinedNotification]);
  }

  deliverAuth(message: WsClientMessage): void {
    this.deliver(message);
  }

  deliverEnvelope(
    envelope: RpcEnvelope,
    stream: IrohPhysicalBiStream,
    body?: ReadableStream<Uint8Array>
  ): void {
    if (this.state !== OPEN) return;
    const requestId = "requestId" in envelope.message ? envelope.message.requestId : undefined;
    if (
      typeof requestId === "string" &&
      (envelope.message.type === "request" || envelope.message.type === "stream-request")
    ) {
      if (this.requests.has(requestId)) {
        throw new Error(`Duplicate Iroh inbound request id ${requestId}`);
      }
      if (this.requests.size >= IROH_CATASTROPHIC_ACTIVE_REQUEST_CEILING) {
        throw new Error("Catastrophic Iroh active-request ceiling exceeded");
      }
      this.requests.set(requestId, {
        stream,
        envelope: { ...envelope, message: envelope.message },
        streaming: envelope.message.type === "stream-request",
        method: envelope.message.method,
        settled: false,
        headSent: false,
      });
      if (body) this.inboundBodies.set(requestId, body);
      if (!body) {
        this.own(this.watchCancellation(requestId, envelope.message.type, stream), (error) => {
          this.logControlFailure(`request ${requestId} cancellation observation`, error);
          for (const handler of [...this.errorHandlers]) handler(error);
        });
      }
    } else {
      // A one-way envelope still owns both halves of a bidirectional QUIC
      // stream. The bounded envelope reader intentionally stops at the frame
      // boundary, so consume the sender's trailing FIN as well as closing the
      // unused response half. A stream is not retired (and its peer credit is
      // not replenished) until both halves reach a terminal state.
      this.own(
        Promise.all([readToEnd(stream.recv, MAX_STREAM_CHUNK_BYTES), stream.send.finish()]).then(
          () => undefined
        ),
        (error) => {
          this.options.log?.(
            `Iroh one-way ${envelopeOperation(envelope)} stream close failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      );
    }
    this.deliver(
      envelope.target === "main" || envelope.target === "server"
        ? { type: "ws:rpc", envelope }
        : { type: "ws:route", envelope }
    );
  }

  takeInboundBody(requestId: string): ReadableStream<Uint8Array> | undefined {
    const body = this.inboundBodies.get(requestId);
    this.inboundBodies.delete(requestId);
    return body;
  }

  sendStreamFrame(requestEnvelope: RpcEnvelope, frame: StreamFrame): Promise<void> {
    const request = requestEnvelope.message;
    if (request.type !== "stream-request") {
      throw new Error(`Streaming response requires a stream-request, received ${request.type}`);
    }
    const requestId = request.requestId;
    const route = this.requests.get(requestId);
    if (!route || !route.streaming || route.settled || this.state !== OPEN) {
      throw new Error(`Iroh response stream ${requestId} is not open`);
    }
    if (frame.kind === "head") {
      if (route.headSent) {
        this.own(route.stream.send.reset(STREAM_CANCEL_CODE), (error) =>
          this.logControlFailure(`response stream ${requestId} duplicate-head reset`, error)
        );
        throw new Error(`Iroh response stream ${requestId} already sent its head`);
      }
      route.headSent = true;
      const written = route.stream.send.writeAll(
        encodeHeadFrame({
          status: frame.status,
          statusText: frame.statusText,
          headerPairs: frame.headerPairs,
          finalUrl: frame.finalUrl,
        })
      );
      return this.own(written, (error) =>
        this.logControlFailure(`response stream ${requestId} head write`, error)
      );
    }
    if (frame.kind === "error") {
      const written = route.stream.send
        .writeAll(
          encodeErrorFrame({
            status: frame.status,
            error: frame.error,
          })
        )
        .then(() => route.stream.send.finish());
      route.settled = true;
      this.requests.delete(requestId);
      this.inboundBodies.delete(requestId);
      return this.own(written, (error) =>
        this.logControlFailure(`response stream ${requestId} error write`, error)
      );
    }
    if (frame.kind === "end") {
      route.settled = true;
      this.requests.delete(requestId);
      this.inboundBodies.delete(requestId);
      return this.own(
        route.stream.send
          .writeAll(encodeEndFrame({ bytesIn: frame.bytesIn }))
          .then(() => route.stream.send.finish()),
        (error) => this.logControlFailure(`response stream ${requestId} end write`, error)
      );
    }
    if (!route.headSent) {
      throw new Error(`Iroh response stream ${requestId} received body data before its head`);
    }
    return this.own(this.writeMetered(route.stream, encodeDataFrame(frame.bytes)), (error) =>
      this.logControlFailure(`response stream ${requestId} body write`, error)
    );
  }

  remoteClosed(code?: number, reason?: string): Promise<void> {
    return this.fireClosed(code, reason);
  }

  lifetime(): Promise<void> {
    return this.lifetimePromise;
  }

  private deliver(message: WsClientMessage): void {
    if (this.state !== OPEN) return;
    const encodedBytes = Buffer.byteLength(encodeRpcJson(message));
    for (const handler of [...this.messageHandlers]) handler(message, encodedBytes);
  }

  private async translateOutbound(message: WsServerMessage): Promise<void> {
    switch (message.type) {
      case "ws:auth-result":
        await this.options.writeControl(
          message.success
            ? {
                t: IROH_SESSION_OPEN_RESULT,
                sid: this.options.sid,
                success: true,
                ...(message.callerId ? { callerId: message.callerId } : {}),
                ...(message.callerKind ? { callerKind: message.callerKind as never } : {}),
                ...(message.connectionId ? { connectionId: message.connectionId } : {}),
                ...(message.serverBootId ? { serverBootId: message.serverBootId } : {}),
                ...(message.sessionDirty ? { sessionDirty: true } : {}),
                ...(message.deviceCredential ? { deviceCredential: message.deviceCredential } : {}),
              }
            : {
                t: IROH_SESSION_OPEN_RESULT,
                sid: this.options.sid,
                success: false,
                error: message.error,
                errorCode: message.errorCode,
                terminal: true,
              }
        );
        return;
      case "ws:rpc":
        await this.sendEnvelope(message.envelope, false);
        return;
      case "ws:routed":
        await this.sendEnvelope(message.envelope, true);
        return;
      case "ws:routed-response-error":
        await this.sendEnvelope({
          from: "main",
          target: message.targetId,
          delivery: { caller: { callerId: "main", callerKind: "unknown" } },
          provenance: [],
          message: { type: "response", requestId: message.requestId, error: message.error },
        });
        return;
      case "ws:routed-event-error":
        this.options.log?.(
          `Iroh routed event ${message.event} to ${message.targetId} failed: ${message.error}`
        );
        return;
      default:
        return;
    }
  }

  private async sendEnvelope(envelope: RpcEnvelope, routed = false): Promise<void> {
    const requestId = "requestId" in envelope.message ? envelope.message.requestId : undefined;
    if (typeof requestId === "string" && envelope.message.type === "response") {
      const route = this.requests.get(requestId);
      if (route && !route.settled) {
        const encoded = new TextEncoder().encode(encodeRpcJson(envelope));
        if (encoded.byteLength > MAX_ENVELOPE_FRAME_BYTES) {
          this.options.log?.(
            `Streaming large unary response for ${route.method}: ${encoded.byteLength} bytes`
          );
        }
        route.settled = true;
        this.requests.delete(requestId);
        this.inboundBodies.delete(requestId);
        await writeChunked(route.stream.send, encoded, MAX_STREAM_CHUNK_BYTES);
        await route.stream.send.finish();
        return;
      }
    }

    const encoded = new TextEncoder().encode(encodeRpcJson(envelope));
    if (encoded.byteLength > MAX_ENVELOPE_FRAME_BYTES) {
      this.options.log?.(
        `Streaming large ${envelope.message.type} message for ${envelopeOperation(envelope)}: ${encoded.byteLength} bytes`
      );
    }
    const stream = await this.options.connection.openBi();
    await writeIrohStreamPreamble(stream.send, {
      k: "message",
      sid: this.options.sid,
      v: IROH_WIRE_VERSION,
    });
    await writeChunked(stream.send, encoded, MAX_STREAM_CHUNK_BYTES);
    await stream.send.finish();

    const expectsResponse =
      typeof requestId === "string" &&
      (envelope.message.type === "request" || envelope.message.type === "stream-request");
    if (expectsResponse) {
      this.own(this.readOutboundResponse(stream, routed), (error) => {
        this.options.log?.(
          `Iroh server-originated request ${requestId} failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        const errorMessage = error instanceof Error ? error.message : String(error);
        const response =
          envelope.message.type === "stream-request"
            ? {
                type: "stream-frame" as const,
                requestId,
                fromId: envelope.target,
                frameType: 0x04,
                payload: JSON.stringify({
                  status: 502,
                  error: { message: errorMessage, code: "CONNECTION_LOST", errorKind: "transport" },
                }),
              }
            : {
                type: "response" as const,
                requestId,
                error: {
                  message: errorMessage,
                  errorKind: "transport" as const,
                  code: "CONNECTION_LOST",
                },
              };
        const failedEnvelope = responseEnvelopeFor(
          envelope,
          { callerId: envelope.target, callerKind: "unknown" },
          response
        );
        this.deliver(
          routed
            ? { type: "ws:route", envelope: failedEnvelope }
            : { type: "ws:rpc", envelope: failedEnvelope }
        );
      });
    } else {
      // The client closes its unused send half when it accepts this one-way
      // message. Consume that FIN so the native QUIC implementation can retire
      // the full bidirectional stream and replenish peer stream credit.
      this.own(
        readToEnd(stream.recv, MAX_STREAM_CHUNK_BYTES).then(() => undefined),
        (error) =>
          this.options.log?.(
            `Iroh one-way ${envelopeOperation(envelope)} request-half drain failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
      );
    }
  }

  private async readOutboundResponse(stream: IrohPhysicalBiStream, routed: boolean): Promise<void> {
    const envelope = decodeRpcJson(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await readToEnd(stream.recv, MAX_STREAM_CHUNK_BYTES)
      )
    ) as RpcEnvelope;
    this.deliver(routed ? { type: "ws:route", envelope } : { type: "ws:rpc", envelope });
  }

  private async watchCancellation(
    requestId: string,
    type: RpcMessage["type"],
    stream: IrohPhysicalBiStream
  ): Promise<void> {
    // The bounded envelope reader intentionally stops before the request FIN.
    // Consume to EOF so a successful call actually retires its receive half.
    // A RESET_STREAM rejects this drain and is the in-order cancellation signal
    // for the already-admitted request on this exact QUIC stream.
    try {
      await readToEnd(stream.recv, MAX_STREAM_CHUNK_BYTES);
      return;
    } catch (error) {
      let resetCode: number | null;
      try {
        resetCode = await stream.recv.receivedReset();
      } catch (resetError) {
        // Closing the physical connection can reject both the receive and its
        // reset observation. The session still owns this observer after the
        // request route has completed; retain both failures at that boundary.
        throw new AggregateError(
          [error, resetError],
          "Iroh request cancellation observation failed",
          {
            cause: error,
          }
        );
      }
      if (resetCode === null) {
        this.logControlFailure(`request ${requestId} receive-half drain`, error);
        return;
      }
      if (!this.requests.has(requestId)) return;
    }
    const route = this.requests.get(requestId);
    if (!route) return;
    if (type === "stream-request") {
      this.requests.delete(requestId);
      this.inboundBodies.delete(requestId);
    }
    const original = route.envelope;
    this.deliver({
      type: original.target === "main" || original.target === "server" ? "ws:rpc" : "ws:route",
      envelope: {
        from: original.from,
        target: original.target,
        ...(original.destination ? { destination: original.destination } : {}),
        delivery: original.delivery,
        provenance: original.provenance,
        message: {
          type: type === "stream-request" ? "stream-cancel" : "request-cancel",
          requestId,
          fromId: original.message.fromId,
        },
      },
    });
  }

  private writeMetered(stream: IrohPhysicalBiStream, bytes: Uint8Array): Promise<void> {
    this.pendingBytes += bytes.byteLength;
    const settle = (): void => {
      this.pendingBytes -= bytes.byteLength;
    };
    return stream.send.writeAll(bytes).then(settle, (error) => {
      settle();
      throw error;
    });
  }

  private logControlFailure(operation: string, error: unknown): void {
    this.options.log?.(
      `Iroh session ${this.options.sid} ${operation} failed: ${formatRpcFailure(error)}`
    );
  }

  private own(operation: Promise<void>, onFailure: (error: unknown) => void): Promise<void> {
    let owned!: Promise<void>;
    owned = operation
      .catch((error) => {
        if (peerStoppedStream(error)) return;
        const connectionRetirement = isRpcConnectionLost(error);
        if (!connectionRetirement) this.ownedFailures.push(error);
        // An operation that observes connection loss before the session's
        // terminal event still has to notify the live RPC owner. Once the
        // terminal fence is installed, the same observation is only the owned
        // native work acknowledging that fence; surfacing it as a new session
        // error would turn orderly retirement back into a product failure.
        if (!connectionRetirement || this.state !== CLOSED) onFailure(error);
      })
      .finally(() => this.ownedWork.delete(owned));
    this.ownedWork.add(owned);
    return operation;
  }

  private fireClosed(
    code?: number,
    reason?: string,
    initial: readonly Promise<void>[] = []
  ): Promise<void> {
    if (this.state === CLOSED) return this.lifetime();
    this.state = CLOSED;
    // Closing is a synchronous dispatch fence. No later envelope or outbound
    // response can enter this session after the predecessor is retired.
    const terminal: Promise<unknown>[] = [...initial];
    for (const route of this.requests.values()) {
      terminal.push(route.stream.send.reset(STREAM_CANCEL_CODE));
      terminal.push(route.stream.recv.stop(STREAM_CANCEL_CODE));
    }
    this.requests.clear();
    this.inboundBodies.clear();
    for (const handler of [...this.closeHandlers]) handler(code ?? 1006, reason ?? "");
    this.options.onClosed(this.options.sid);
    void (async () => {
      const terminalResults = await Promise.allSettled(terminal);
      while (this.ownedWork.size > 0) {
        await Promise.allSettled([...this.ownedWork]);
      }
      const failures = [
        ...this.ownedFailures,
        ...terminalResults.flatMap((result) =>
          result.status === "rejected" && !isRpcConnectionLost(result.reason) ? [result.reason] : []
        ),
      ];
      if (failures.length > 0) {
        this.rejectLifetime(
          new AggregateError(failures, `Iroh session ${this.options.sid} retirement failed`, {
            cause: failures[0],
          })
        );
        return;
      }
      this.resolveLifetime();
    })();
    return this.lifetimePromise;
  }
}
