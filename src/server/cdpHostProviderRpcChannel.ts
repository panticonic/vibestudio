import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { createDevLogger } from "@vibestudio/dev-log";
import type { CdpBridge, CdpHostProviderConnection } from "./cdpBridge.js";
import type { CallerKind } from "@vibestudio/shared/serviceDispatcher";

const log = createDevLogger("CdpHostProviderRpcChannel");

export interface CdpHostProviderRpcCaller {
  id: string;
  kind: CallerKind;
}

export class CdpHostProviderRpcChannel {
  private readonly sessions = new Map<string, RpcCdpHostProviderConnection>();

  constructor(private readonly bridge: CdpBridge) {}

  open(sessionId: string, hostConnectionId: string, caller: CdpHostProviderRpcCaller): Response {
    if (!sessionId) throw new Error("CDP host provider session id is required");
    if (!hostConnectionId) throw new Error("CDP host provider host connection id is required");
    if (caller.kind !== "shell" && caller.kind !== "server") {
      throw new Error(`CDP host provider RPC is not available to ${caller.kind} callers`);
    }
    if (this.sessions.has(sessionId)) {
      throw new Error(`CDP host provider session already exists: ${sessionId}`);
    }
    const ownerCallerId = caller.kind === "shell" ? caller.id : undefined;
    if (!this.bridge.canConnectHostProvider(hostConnectionId, ownerCallerId)) {
      throw new Error(`CDP host provider not authorized: ${hostConnectionId}`);
    }

    let connection: RpcCdpHostProviderConnection | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        connection = new RpcCdpHostProviderConnection(
          sessionId,
          hostConnectionId,
          caller,
          controller,
          () => {
            if (this.sessions.get(sessionId) === connection) this.sessions.delete(sessionId);
          }
        );
        this.sessions.set(sessionId, connection);
        this.bridge.connectHostProvider(hostConnectionId, connection, ownerCallerId);
      },
      cancel: () => {
        connection?.close(1000, "CDP host provider stream cancelled");
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  send(sessionId: string, data: string, caller: CdpHostProviderRpcCaller): void {
    const connection = this.sessions.get(sessionId);
    if (!connection || connection.readyState !== WebSocket.OPEN) {
      throw new Error(`CDP host provider session not connected: ${sessionId}`);
    }
    if (!connection.canUse(caller)) {
      throw new Error(`CDP host provider session not authorized: ${sessionId}`);
    }
    connection.receive(data);
  }

  close(sessionId: string, caller: CdpHostProviderRpcCaller): void {
    const connection = this.sessions.get(sessionId);
    if (!connection) return;
    if (!connection.canUse(caller)) {
      throw new Error(`CDP host provider session not authorized: ${sessionId}`);
    }
    connection.close(1000, "CDP host provider RPC session closed");
  }

  stop(): void {
    for (const connection of this.sessions.values()) {
      connection.close(1000, "CDP host provider RPC channel stopped");
    }
    this.sessions.clear();
  }
}

class RpcCdpHostProviderConnection extends EventEmitter implements CdpHostProviderConnection {
  readyState: number = WebSocket.OPEN;
  private readonly encoder = new TextEncoder();
  private closed = false;

  constructor(
    private readonly sessionId: string,
    private readonly hostConnectionId: string,
    private readonly owner: CdpHostProviderRpcCaller,
    private readonly controller: ReadableStreamDefaultController<Uint8Array>,
    private readonly onClosed: () => void
  ) {
    super();
  }

  canUse(caller: CdpHostProviderRpcCaller): boolean {
    if (caller.kind === "server") return true;
    return caller.kind === this.owner.kind && caller.id === this.owner.id;
  }

  send(data: string): void {
    if (this.readyState !== WebSocket.OPEN || this.closed) return;
    try {
      this.controller.enqueue(this.encoder.encode(`${JSON.stringify(data)}\n`));
    } catch (error) {
      this.fail(error);
    }
  }

  close(_code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = WebSocket.CLOSED;
    this.onClosed();
    try {
      this.controller.close();
    } catch {
      // The stream may already have been cancelled by the reader.
    }
    log.info(
      `CDP host provider RPC session closed: ${this.sessionId} (${this.hostConnectionId}${
        reason ? `, ${reason}` : ""
      })`
    );
    this.emit("close");
  }

  receive(data: string): void {
    if (this.readyState !== WebSocket.OPEN || this.closed) return;
    this.emit("message", data);
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = WebSocket.CLOSED;
    this.onClosed();
    try {
      this.controller.error(error);
    } catch {
      // The stream may already have been cancelled by the reader.
    }
    this.emit("error", error);
    this.emit("close");
  }
}
