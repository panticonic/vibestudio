import { EventEmitter } from "node:events";
import type { ProcessAdapter } from "@vibestudio/process-adapter";
import { constantTimeStringEqual } from "@vibestudio/shared/tokenManager";
import type { RpcEnvelope } from "@vibestudio/rpc";
import type { WsClientMessage, WsServerMessage } from "@vibestudio/shared/ws/protocol";
import {
  AUTHENTICATION_FRAME_MAX_BYTES,
  RPC_WEBSOCKET_MAX_PAYLOAD_BYTES,
} from "../ingressLimits.js";
import type { StreamFrame } from "../services/egressProxy.js";
import { encodeWebSocketStreamFrame, type RpcSessionChannel } from "./sessionChannel.js";

/** The existing RPC session protocol over a launcher-owned process pipe. This
 * grants no authority: the first auth frame must use the credential issued for
 * this exact launched connection, and the ordinary receiver resolves it. */
export class ProcessSessionChannel implements RpcSessionChannel {
  readonly OPEN = 1;
  readonly transportBinding = { kind: "local" } as const;
  private readonly events = new EventEmitter();
  private open = true;
  private first = true;

  constructor(
    private readonly process: ProcessAdapter,
    private readonly credential: string
  ) {
    process.on("message", this.receive);
    process.on("exit", this.exited);
    process.on("disconnect", this.disconnected);
    process.on("error", this.failed);
  }

  get readyState(): number {
    return this.open ? this.OPEN : 3;
  }
  get bufferedAmount(): number {
    return this.process.bufferedAmount ?? 0;
  }

  private readonly receive = (raw: unknown) => {
    if (!this.open || typeof raw !== "string") return;
    const bytes = Buffer.byteLength(raw);
    if (bytes > (this.first ? AUTHENTICATION_FRAME_MAX_BYTES : RPC_WEBSOCKET_MAX_PAYLOAD_BYTES)) {
      this.close(1009, "RPC process frame exceeds limit");
      return;
    }
    let message: WsClientMessage;
    try {
      message = JSON.parse(raw) as WsClientMessage;
      if (!message || typeof message !== "object" || typeof message.type !== "string") {
        throw new Error("Invalid RPC process message");
      }
    } catch {
      this.close(4004, "Invalid RPC process message");
      return;
    }
    if (this.first) {
      if (
        message.type !== "ws:auth" ||
        typeof message.token !== "string" ||
        !constantTimeStringEqual(message.token, this.credential)
      ) {
        this.close(4006, "RPC process credential does not match launch");
        return;
      }
      this.first = false;
    }
    this.events.emit("message", message, bytes);
  };

  private readonly exited = () => this.finish(1001, "Native process exited");
  private readonly disconnected = () => this.finish(1001, "Native process IPC disconnected");
  private readonly failed = (error: Error) => {
    this.events.emit("transportError", error);
    this.finish(1011, "Native process IPC failed");
  };

  onMessage(handler: (message: WsClientMessage, encodedBytes: number) => void): () => void {
    this.events.on("message", handler);
    return () => {
      this.events.off("message", handler);
    };
  }
  onClose(handler: (code: number, reason: string) => void): () => void {
    this.events.on("close", handler);
    return () => {
      this.events.off("close", handler);
    };
  }
  onError(handler: (error: unknown) => void): () => void {
    this.events.on("transportError", handler);
    return () => {
      this.events.off("transportError", handler);
    };
  }
  sendMessage(message: WsServerMessage): void {
    if (!this.open) return;
    const raw = JSON.stringify(message);
    if (Buffer.byteLength(raw) > RPC_WEBSOCKET_MAX_PAYLOAD_BYTES) {
      this.close(1009, "RPC process response exceeds limit");
      return;
    }
    try {
      this.process.postMessage(raw);
    } catch (error) {
      this.events.emit("transportError", error);
      this.close(1011, "RPC process delivery failed");
    }
  }
  takeInboundBody(_requestId: string): undefined {
    return undefined;
  }
  async sendStreamFrame(requestEnvelope: RpcEnvelope, frame: StreamFrame): Promise<void> {
    this.sendMessage(encodeWebSocketStreamFrame(requestEnvelope, frame));
  }
  close(code = 1000, reason = "RPC process session closed"): void {
    if (!this.open) return;
    this.finish(code, reason);
    // Authority is already retired even if the guest ignores shutdown.
    try {
      this.process.postMessage({ type: "shutdown", reason });
    } catch {
      // The session is already retired. A full/closed process pipe must not
      // turn best-effort shutdown into an exception in the authority owner.
    }
  }
  terminate(): void {
    this.close(1001, "RPC process session terminated");
  }

  private finish(code: number, reason: string): void {
    if (!this.open) return;
    this.open = false;
    this.process.off("message", this.receive);
    this.process.off("exit", this.exited);
    this.process.off("disconnect", this.disconnected);
    // Retain the error consumer for the adapter's lifetime: send callbacks can
    // deliver a late error even after exit. It carries no authority and the
    // retired adapter/channel cycle is garbage-collected with its owner.
    this.events.emit("close", code, reason);
    this.events.removeAllListeners();
  }
}
