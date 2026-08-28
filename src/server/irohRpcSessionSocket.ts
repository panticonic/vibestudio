import {
  IROH_WIRE_VERSION,
  MAX_ENVELOPE_FRAME_BYTES,
  readFrame,
  writeFrame,
  writeIrohStreamPreamble,
  type IrohPhysicalBiStream,
  type IrohPhysicalConnection,
} from "@vibestudio/iroh-transport";
import {
  FRAME_END,
  FRAME_ERROR,
  FRAME_HEAD,
  parseErrorFrame,
  parseHeadFrame,
  type FrameType,
} from "@vibestudio/rpc/protocol/streamCodec";
import { encodeIrohStreamResponseHead } from "@vibestudio/rpc/protocol/irohStreamResponse";
import {
  IROH_SESSION_CLOSED,
  IROH_SESSION_OPEN_RESULT,
  type IrohSessionControlFrame,
} from "@vibestudio/rpc/protocol/irohSession";
import type { RpcEnvelope, RpcMessage } from "@vibestudio/rpc";
import type { WsClientMessage, WsServerMessage } from "@vibestudio/shared/ws/protocol";

const OPEN = 1;
const CLOSED = 3;
const STREAM_CANCEL_CODE = 0x202n;

type SessionHandler = (...args: any[]) => void;

interface RequestRoute {
  stream: IrohPhysicalBiStream;
  streaming: boolean;
  settled: boolean;
  headSent: boolean;
}

export interface IrohRpcSessionSocketOptions {
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
export class IrohRpcSessionSocket {
  readonly CONNECTING = 0;
  readonly OPEN = OPEN;
  readonly CLOSING = 2;
  readonly CLOSED = CLOSED;
  private state = OPEN;
  private readonly messageHandlers = new Set<SessionHandler>();
  private readonly closeHandlers = new Set<SessionHandler>();
  private readonly requests = new Map<string, RequestRoute>();
  private readonly inboundBodies = new Map<string, ReadableStream<Uint8Array>>();
  private pendingBytes = 0;

  constructor(private readonly options: IrohRpcSessionSocketOptions) {}

  get peerEndpointId(): string {
    return this.options.connection.peerEndpointId;
  }

  get readyState(): number {
    return this.state;
  }

  get bufferedAmount(): number {
    return this.pendingBytes;
  }

  on(event: string, handler: SessionHandler): this {
    if (event === "message") this.messageHandlers.add(handler);
    else if (event === "close") this.closeHandlers.add(handler);
    return this;
  }

  once(event: string, handler: SessionHandler): this {
    return this.on(event, handler);
  }

  off(event: string, handler: SessionHandler): this {
    if (event === "message") this.messageHandlers.delete(handler);
    else if (event === "close") this.closeHandlers.delete(handler);
    return this;
  }

  removeListener(event: string, handler: SessionHandler): this {
    return this.off(event, handler);
  }

  send(data: string): void {
    if (this.state !== OPEN) return;
    let message: WsServerMessage;
    try {
      message = JSON.parse(data) as WsServerMessage;
    } catch {
      return;
    }
    void this.translateOutbound(message).catch((error) => {
      this.options.log?.(
        `Iroh session ${this.options.sid} outbound failure: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      this.remoteClosed(1011, "Iroh outbound failure");
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
      this.requests.set(requestId, {
        stream,
        streaming: envelope.message.type === "stream-request",
        settled: false,
        headSent: false,
      });
      if (body) this.inboundBodies.set(requestId, body);
      if (!body) void this.watchCancellation(requestId, envelope.message.type, stream);
    }
    this.deliver(
      envelope.target === "main" || envelope.target === "server"
        ? { type: "ws:rpc", envelope, ...(body ? { streamBody: true as const } : {}) }
        : { type: "ws:route", envelope }
    );
  }

  takeInboundBody(requestId: string): ReadableStream<Uint8Array> | undefined {
    const body = this.inboundBodies.get(requestId);
    this.inboundBodies.delete(requestId);
    return body;
  }

  sendStreamFrame(
    requestId: string,
    frameType: FrameType,
    payload: Uint8Array
  ): Promise<void> | false {
    const route = this.requests.get(requestId);
    if (!route || !route.streaming || route.settled || this.state !== OPEN) return false;
    if (frameType === FRAME_HEAD) {
      if (route.headSent) {
        void route.stream.send.reset(STREAM_CANCEL_CODE).catch(() => undefined);
        return false;
      }
      route.headSent = true;
      const written = writeFrame(
        route.stream.send,
        encodeIrohStreamResponseHead(parseHeadFrame(payload)),
        MAX_ENVELOPE_FRAME_BYTES
      );
      return written;
    }
    if (frameType === FRAME_ERROR) {
      const error = parseErrorFrame(payload);
      const written = route.headSent
        ? route.stream.send.reset(STREAM_CANCEL_CODE)
        : writeFrame(
            route.stream.send,
            encodeIrohStreamResponseHead({
              status: error.status,
              statusText: "RPC Error",
              headerPairs: [],
              finalUrl: "",
              error: {
                message: error.message,
                errorKind: error.errorKind,
                ...(error.code ? { code: error.code } : {}),
                ...(error.errorData !== undefined ? { errorData: error.errorData } : {}),
              },
            }),
            MAX_ENVELOPE_FRAME_BYTES
          ).then(() => route.stream.send.finish());
      route.settled = true;
      this.requests.delete(requestId);
      this.inboundBodies.delete(requestId);
      return written;
    }
    if (frameType === FRAME_END) {
      route.settled = true;
      this.requests.delete(requestId);
      this.inboundBodies.delete(requestId);
      return route.stream.send.finish();
    }
    if (!route.headSent) return false;
    return this.writeMetered(route.stream, payload);
  }

  remoteClosed(code?: number, reason?: string): void {
    this.fireClosed(code, reason);
  }

  private deliver(message: WsClientMessage): void {
    if (this.state !== OPEN) return;
    const bytes = Buffer.from(JSON.stringify(message));
    for (const handler of [...this.messageHandlers]) handler(bytes);
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
        route.settled = true;
        this.requests.delete(requestId);
        this.inboundBodies.delete(requestId);
        await writeFrame(
          route.stream.send,
          new TextEncoder().encode(JSON.stringify(envelope)),
          MAX_ENVELOPE_FRAME_BYTES
        );
        await route.stream.send.finish();
        return;
      }
    }

    const stream = await this.options.connection.openBi();
    await writeIrohStreamPreamble(stream.send, {
      k: "envelope",
      sid: this.options.sid,
      v: IROH_WIRE_VERSION,
    });
    await writeFrame(
      stream.send,
      new TextEncoder().encode(JSON.stringify(envelope)),
      MAX_ENVELOPE_FRAME_BYTES
    );
    await stream.send.finish();

    if (
      typeof requestId === "string" &&
      (envelope.message.type === "request" || envelope.message.type === "stream-request")
    ) {
      void this.readOutboundResponse(stream).catch((error) =>
        this.options.log?.(
          `Iroh server-originated request ${requestId} failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      );
    }
  }

  private async readOutboundResponse(stream: IrohPhysicalBiStream): Promise<void> {
    const envelope = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await readFrame(stream.recv, MAX_ENVELOPE_FRAME_BYTES)
      )
    ) as RpcEnvelope;
    this.deliver({ type: "ws:rpc", envelope });
  }

  private async watchCancellation(
    requestId: string,
    type: RpcMessage["type"],
    stream: IrohPhysicalBiStream
  ): Promise<void> {
    const reset = await stream.recv.receivedReset().catch(() => null);
    if (reset === null || !this.requests.has(requestId)) return;
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
    return stream.send.writeAll([...bytes]).then(settle, (error) => {
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
    const reasonBytes = Buffer.from(reason ?? "");
    for (const handler of [...this.closeHandlers]) handler(code ?? 1006, reasonBytes);
    this.options.onClosed(this.options.sid);
  }
}
