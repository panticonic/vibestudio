import { responseEnvelopeFor, type RpcEnvelope } from "@vibestudio/rpc";
import {
  FRAME_DATA,
  FRAME_END,
  FRAME_ERROR,
  FRAME_HEAD,
} from "@vibestudio/rpc/protocol/streamCodec";
import type { WsClientMessage, WsServerMessage } from "@vibestudio/shared/ws/protocol";
import { WebSocket } from "ws";
import type { StreamFrame } from "../services/egressProxy.js";

const SESSION_SERVER_RESPONDER = { callerId: "main", callerKind: "server" as const };

export function encodeWebSocketStreamFrame(
  requestEnvelope: RpcEnvelope,
  frame: StreamFrame
): WsServerMessage {
  const request = requestEnvelope.message;
  if (request.type !== "stream-request") {
    throw new Error(`Streaming response requires a stream-request, received ${request.type}`);
  }
  let frameType: number;
  let payload: string;
  switch (frame.kind) {
    case "head":
      frameType = FRAME_HEAD;
      payload = JSON.stringify({
        status: frame.status,
        statusText: frame.statusText,
        headerPairs: frame.headerPairs,
        finalUrl: frame.finalUrl,
      });
      break;
    case "chunk":
      frameType = FRAME_DATA;
      payload = Buffer.from(frame.bytes).toString("base64");
      break;
    case "end":
      frameType = FRAME_END;
      payload = JSON.stringify({ bytesIn: frame.bytesIn });
      break;
    case "error":
      frameType = FRAME_ERROR;
      payload = JSON.stringify({
        status: frame.status,
        message: frame.message,
        code: frame.code,
        errorKind: frame.errorKind,
        ...(frame.errorData === undefined ? {} : { errorData: frame.errorData }),
      });
      break;
  }
  return {
    type: "ws:rpc",
    envelope: responseEnvelopeFor(requestEnvelope, SESSION_SERVER_RESPONDER, {
      type: "stream-frame",
      requestId: request.requestId,
      fromId: "main",
      frameType,
      payload,
    }),
  };
}

export type RpcSessionTransportBinding = { kind: "local" } | { kind: "iroh"; endpointId: string };

/**
 * One authenticated logical RPC session, independent of its physical carrier.
 *
 * JSON lifecycle/envelope delivery is the common semantic plane. Each carrier
 * also implements streaming directly: Iroh uses the request's QUIC stream,
 * while loopback WebSocket emits its bounded protocol messages.
 */
export interface RpcSessionChannel {
  readonly OPEN: number;
  readonly readyState: number;
  readonly bufferedAmount: number;
  readonly transportBinding: RpcSessionTransportBinding;
  onMessage(handler: (message: WsClientMessage, encodedBytes: number) => void): () => void;
  onClose(handler: (code: number, reason: string) => void): () => void;
  onError(handler: (error: unknown) => void): () => void;
  sendMessage(message: WsServerMessage): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  takeInboundBody(requestId: string): ReadableStream<Uint8Array> | undefined;
  /**
   * Deliver one semantic streaming response frame. The carrier owns its wire
   * encoding: loopback WebSocket serializes the legacy JSON frame envelope,
   * while Iroh writes the binary body directly to the request's QUIC stream.
   */
  sendStreamFrame(requestEnvelope: RpcEnvelope, frame: StreamFrame): Promise<void>;
}

/** Loopback WebSocket carrier for the transport-neutral session channel. */
export class WebSocketSessionChannel implements RpcSessionChannel {
  readonly OPEN = WebSocket.OPEN;
  readonly transportBinding = { kind: "local" } as const;

  constructor(readonly socket: WebSocket) {}

  get readyState(): number {
    return this.socket.readyState;
  }

  get bufferedAmount(): number {
    return this.socket.bufferedAmount;
  }

  onMessage(handler: (message: WsClientMessage, encodedBytes: number) => void): () => void {
    const listener = (data: Buffer | ArrayBuffer | Buffer[]) => {
      const encodedBytes = Array.isArray(data)
        ? data.reduce((total, chunk) => total + chunk.byteLength, 0)
        : data.byteLength;
      let message: WsClientMessage;
      try {
        message = JSON.parse(data.toString()) as WsClientMessage;
      } catch {
        this.close(4004, "Invalid message");
        return;
      }
      handler(message, encodedBytes);
    };
    this.socket.on("message", listener);
    return () => this.socket.off("message", listener);
  }

  onClose(handler: (code: number, reason: string) => void): () => void {
    const listener = (code: number, reason: Buffer) => handler(code, reason.toString());
    this.socket.on("close", listener);
    return () => this.socket.off("close", listener);
  }

  onError(handler: (error: unknown) => void): () => void {
    this.socket.on("error", handler);
    return () => this.socket.off("error", handler);
  }

  sendMessage(message: WsServerMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  takeInboundBody(_requestId: string): undefined {
    return undefined;
  }

  async sendStreamFrame(requestEnvelope: RpcEnvelope, frame: StreamFrame): Promise<void> {
    this.sendMessage(encodeWebSocketStreamFrame(requestEnvelope, frame));
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  terminate(): void {
    this.socket.terminate();
  }
}
