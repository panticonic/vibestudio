import type { WebSocket } from "ws";
import type { WsLike } from "@vibez1/rpc/protocol/wsAdapter";

/**
 * Adapt a Node `ws` WebSocket to the framework-agnostic WsLike interface that the RPC client
 * transports expect. This is the single shared implementation for every Node-side server
 * connection (desktop, headless host, CLI, terminal/remote apps) — construct the `ws` socket
 * (with any TLS options) at the call site and wrap it here. Do not re-vendor this per app.
 */
export class NodeWsLike implements WsLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(private readonly ws: WebSocket) {
    ws.on("open", () => this.onopen?.());
    ws.on("message", (data) => this.onmessage?.({ data: data.toString() }));
    ws.on("close", (code, reason) => this.onclose?.({ code, reason: reason.toString() }));
    ws.on("error", (error) => this.onerror?.(error));
  }

  get readyState(): number {
    return this.ws.readyState;
  }

  send(data: string): void {
    this.ws.send(data);
  }

  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }
}
