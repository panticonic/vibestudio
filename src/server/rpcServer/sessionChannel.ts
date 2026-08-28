import type { FrameType } from "@vibestudio/rpc/protocol/streamCodec";
import type { WsClientMessage, WsServerMessage } from "@vibestudio/shared/ws/protocol";
import { WebSocket } from "ws";

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
  sendStreamFrame(
    requestId: string,
    frameType: FrameType,
    payload: Uint8Array,
    fallbackMessage: WsServerMessage
  ): Promise<void>;
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

  async sendStreamFrame(
    _requestId: string,
    _frameType: FrameType,
    _payload: Uint8Array,
    fallbackMessage: WsServerMessage
  ): Promise<void> {
    this.sendMessage(fallbackMessage);
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  terminate(): void {
    this.socket.terminate();
  }
}
