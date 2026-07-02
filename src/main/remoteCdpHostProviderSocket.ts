import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import type { CdpHostProviderSocket } from "./cdpHostProvider.js";
import type { ServerClient } from "./serverClient.js";

export interface RemoteCdpHostProviderSocketOptions {
  serverClient: ServerClient;
  hostConnectionId: string;
  sessionId?: string;
}

export class RemoteCdpHostProviderSocket extends EventEmitter implements CdpHostProviderSocket {
  readyState: number = WebSocket.CONNECTING;
  private readonly sessionId: string;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private closed = false;

  constructor(private readonly options: RemoteCdpHostProviderSocketOptions) {
    super();
    this.sessionId = options.sessionId ?? randomUUID();
    void this.open();
  }

  send(data: string): void {
    if (this.readyState !== WebSocket.OPEN || this.closed) return;
    void this.options.serverClient
      .call("panelCdp", "hostProvider.send", [this.sessionId, data])
      .catch((error: unknown) => {
        this.fail(error);
      });
  }

  close(_code?: number, _reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = WebSocket.CLOSED;
    const reader = this.reader;
    this.reader = null;
    void reader?.cancel().catch(() => {});
    void this.options.serverClient
      .call("panelCdp", "hostProvider.close", [this.sessionId])
      .catch(() => {});
    this.emit("close");
  }

  private async open(): Promise<void> {
    try {
      const response = await this.options.serverClient.stream("panelCdp", "hostProvider.open", [
        this.sessionId,
        this.options.hostConnectionId,
      ]);
      if (this.closed) {
        void this.options.serverClient
          .call("panelCdp", "hostProvider.close", [this.sessionId])
          .catch(() => {});
        return;
      }
      if (!response.ok) {
        throw new Error(`CDP host provider stream failed: HTTP ${response.status}`);
      }
      if (!response.body) {
        throw new Error("CDP host provider stream did not include a body");
      }

      this.readyState = WebSocket.OPEN;
      this.emit("open");
      this.reader = response.body.getReader();
      await this.readLoop(this.reader);
      this.close();
    } catch (error) {
      this.fail(error);
    }
  }

  private async readLoop(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffered = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      buffered = this.emitBufferedMessages(buffered);
    }
    buffered += decoder.decode();
    this.emitBufferedMessages(buffered);
  }

  private emitBufferedMessages(buffered: string): string {
    let cursor = 0;
    for (;;) {
      const newline = buffered.indexOf("\n", cursor);
      if (newline === -1) break;
      const line = buffered.slice(cursor, newline);
      cursor = newline + 1;
      if (line) this.emitFrame(line);
    }
    return buffered.slice(cursor);
  }

  private emitFrame(line: string): void {
    try {
      const payload = JSON.parse(line) as unknown;
      this.emit("message", typeof payload === "string" ? payload : JSON.stringify(payload));
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    this.emit("error", error);
    this.close();
  }
}
