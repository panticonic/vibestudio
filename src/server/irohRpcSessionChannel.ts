import {
  IROH_WIRE_VERSION,
  MAX_ENVELOPE_FRAME_BYTES,
  MAX_STREAM_CHUNK_BYTES,
  readToEnd,
  writeChunked,
  writeFrame,
  writeIrohStreamPreamble,
  type IrohPhysicalBiStream,
  type IrohPhysicalConnection,
} from "@vibestudio/iroh-transport";
import { type RpcEnvelope, type RpcMessage } from "@vibestudio/rpc";
import { encodeIrohStreamResponseHead } from "@vibestudio/rpc/protocol/irohStreamResponse";
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

interface RequestRoute {
  stream: IrohPhysicalBiStream;
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
  private readonly requests = new Map<string, RequestRoute>();
  private readonly inboundBodies = new Map<string, ReadableStream<Uint8Array>>();
  private pendingBytes = 0;

  readonly transportBinding: RpcSessionTransportBinding;

  constructor(private readonly options: IrohRpcSessionChannelOptions) {
    this.transportBinding = { kind: "iroh", endpointId: options.connection.peerEndpointId };
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

  onError(_handler: (error: unknown) => void): () => void {
    return () => undefined;
  }

  sendMessage(message: WsServerMessage): void {
    if (this.state !== OPEN) return;
    void this.translateOutbound(message).catch((error) => {
      this.options.log?.(
        `Iroh session ${this.options.sid} outbound failure: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
  }

  close(code?: number, reason?: string): void {
    if (this.state !== OPEN) return;
    void this.options
      .writeControl({
        t: IROH_SESSION_CLOSED,
        sid: this.options.sid,
        ...(code === undefined ? {} : { code }),
        ...(reason === undefined ? {} : { reason }),
        terminal: code !== undefined && code >= 4000,
      })
      .finally(() => this.fireClosed(code, reason));
  }

  terminate(): void {
    if (this.state !== OPEN) return;
    void this.options.writeControl({
      t: IROH_SESSION_CLOSED,
      sid: this.options.sid,
      code: 1006,
      reason: "terminated",
      terminal: true,
    });
    this.fireClosed(1006, "terminated");
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
      this.requests.set(requestId, {
        stream,
        streaming: envelope.message.type === "stream-request",
        method: envelope.message.method,
        settled: false,
        headSent: false,
      });
      if (body) this.inboundBodies.set(requestId, body);
      if (!body) void this.watchCancellation(requestId, envelope.message.type, stream);
    } else {
      // A one-way envelope still owns both halves of a bidirectional QUIC
      // stream. The bounded envelope reader intentionally stops at the frame
      // boundary, so consume the sender's trailing FIN as well as closing the
      // unused response half. A stream is not retired (and its peer credit is
      // not replenished) until both halves reach a terminal state.
      void Promise.all([
        readToEnd(stream.recv, MAX_STREAM_CHUNK_BYTES),
        stream.send.finish(),
      ]).catch((error) => {
        this.options.log?.(
          `Iroh one-way ${envelopeOperation(envelope)} stream close failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
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
        void route.stream.send.reset(STREAM_CANCEL_CODE).catch(() => undefined);
        throw new Error(`Iroh response stream ${requestId} already sent its head`);
      }
      route.headSent = true;
      const written = writeFrame(
        route.stream.send,
        encodeIrohStreamResponseHead({
          status: frame.status,
          statusText: frame.statusText,
          headerPairs: frame.headerPairs,
          finalUrl: frame.finalUrl,
        }),
        MAX_ENVELOPE_FRAME_BYTES
      );
      return written;
    }
    if (frame.kind === "error") {
      const written = route.headSent
        ? route.stream.send.reset(STREAM_CANCEL_CODE)
        : writeFrame(
            route.stream.send,
            encodeIrohStreamResponseHead({
              status: frame.status,
              statusText: "RPC Error",
              headerPairs: [],
              finalUrl: "",
              error: {
                message: frame.message,
                errorKind: frame.errorKind,
                ...(frame.code ? { code: frame.code } : {}),
                ...(frame.errorData !== undefined ? { errorData: frame.errorData } : {}),
              },
            }),
            MAX_ENVELOPE_FRAME_BYTES
          ).then(() => route.stream.send.finish());
      route.settled = true;
      this.requests.delete(requestId);
      this.inboundBodies.delete(requestId);
      return written;
    }
    if (frame.kind === "end") {
      route.settled = true;
      this.requests.delete(requestId);
      this.inboundBodies.delete(requestId);
      return route.stream.send.finish();
    }
    if (!route.headSent) {
      throw new Error(`Iroh response stream ${requestId} received body data before its head`);
    }
    return this.writeMetered(route.stream, frame.bytes);
  }

  remoteClosed(code?: number, reason?: string): void {
    this.fireClosed(code, reason);
  }

  private deliver(message: WsClientMessage): void {
    if (this.state !== OPEN) return;
    const encodedBytes = Buffer.byteLength(JSON.stringify(message));
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
                ...(message.pairingContext ? { pairingContext: message.pairingContext } : {}),
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
      case "ws:routed":
        await this.sendEnvelope(message.envelope);
        return;
      case "ws:routed-response-error":
        await this.sendEnvelope({
          from: "main",
          target: message.targetId,
          delivery: { caller: { callerId: "main", callerKind: "unknown" } },
          provenance: [],
          message: {
            type: "response",
            requestId: message.requestId,
            error: message.error,
            errorKind: message.errorKind,
            ...(message.errorCode ? { errorCode: message.errorCode } : {}),
            ...(message.errorData === undefined ? {} : { errorData: message.errorData }),
          },
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

  private async sendEnvelope(envelope: RpcEnvelope): Promise<void> {
    const requestId = "requestId" in envelope.message ? envelope.message.requestId : undefined;
    if (typeof requestId === "string" && envelope.message.type === "response") {
      const route = this.requests.get(requestId);
      if (route && !route.settled) {
        const encoded = new TextEncoder().encode(JSON.stringify(envelope));
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

    const encoded = new TextEncoder().encode(JSON.stringify(envelope));
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
      void this.readOutboundResponse(stream).catch((error) =>
        this.options.log?.(
          `Iroh server-originated request ${requestId} failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      );
    } else {
      // The client closes its unused send half when it accepts this one-way
      // message. Consume that FIN so the native QUIC implementation can retire
      // the full bidirectional stream and replenish peer stream credit.
      void readToEnd(stream.recv, MAX_STREAM_CHUNK_BYTES).catch((error) =>
        this.options.log?.(
          `Iroh one-way ${envelopeOperation(envelope)} request-half drain failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      );
    }
  }

  private async readOutboundResponse(stream: IrohPhysicalBiStream): Promise<void> {
    const envelope = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await readToEnd(stream.recv, MAX_STREAM_CHUNK_BYTES)
      )
    ) as RpcEnvelope;
    this.deliver({ type: "ws:rpc", envelope });
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
    } catch {
      if (!this.requests.has(requestId)) return;
    }
    this.requests.delete(requestId);
    this.inboundBodies.delete(requestId);
    this.deliver({
      type: "ws:rpc",
      envelope: {
        from: "",
        target: "main",
        delivery: { caller: { callerId: "", callerKind: "unknown" } },
        provenance: [],
        message: {
          type: type === "stream-request" ? "stream-cancel" : "request-cancel",
          requestId,
          fromId: "",
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

  private fireClosed(code?: number, reason?: string): void {
    if (this.state === CLOSED) return;
    this.state = CLOSED;
    for (const route of this.requests.values()) {
      void route.stream.send.reset(STREAM_CANCEL_CODE).catch(() => undefined);
      void route.stream.recv.stop(STREAM_CANCEL_CODE).catch(() => undefined);
    }
    this.requests.clear();
    this.inboundBodies.clear();
    for (const handler of [...this.closeHandlers]) handler(code ?? 1006, reason ?? "");
    this.options.onClosed(this.options.sid);
  }
}
