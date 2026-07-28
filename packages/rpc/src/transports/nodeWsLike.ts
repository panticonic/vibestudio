import type { WsLike } from "../protocol/wsAdapter.js";

interface NodeWebSocket {
  readonly readyState: number;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: { toString(): string }) => void): void;
  on(event: "close", listener: (code: number, reason: { toString(): string }) => void): void;
  on(event: "error", listener: (error: unknown) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/**
 * Adapt a Node event-emitter WebSocket to the framework-agnostic transport
 * interface. Callers still own the concrete `ws` dependency and socket options.
 */
export class NodeWsLike implements WsLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(private readonly ws: NodeWebSocket) {
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
