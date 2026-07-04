import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import type { RpcClient } from "@vibez1/rpc";
import type { CdpHostBridgeSocket } from "./hostBridge.js";

export interface RemoteCdpHostBridgeSocketOptions {
  rpc: Pick<RpcClient, "call" | "stream">;
  hostConnectionId: string;
  sessionId?: string;
  ndjsonLimits?: RemoteCdpNdjsonLimits;
}

export interface RemoteCdpNdjsonLimits {
  maxChunkBytes?: number;
  maxLineBytes?: number;
}

export const DEFAULT_MAX_NDJSON_CHUNK_BYTES = 256 * 1024 * 1024;
export const DEFAULT_MAX_NDJSON_LINE_BYTES = 256 * 1024 * 1024;

function resolvePositiveLimit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

export class RemoteCdpHostBridgeSocket extends EventEmitter implements CdpHostBridgeSocket {
  readyState: number = WebSocket.CONNECTING;
  private readonly sessionId: string;
  private readonly maxNdjsonChunkBytes: number;
  private readonly maxNdjsonLineBytes: number;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private closed = false;

  constructor(private readonly options: RemoteCdpHostBridgeSocketOptions) {
    super();
    this.sessionId = options.sessionId ?? randomUUID();
    this.maxNdjsonChunkBytes = resolvePositiveLimit(
      options.ndjsonLimits?.maxChunkBytes,
      DEFAULT_MAX_NDJSON_CHUNK_BYTES,
      "maxChunkBytes"
    );
    this.maxNdjsonLineBytes = resolvePositiveLimit(
      options.ndjsonLimits?.maxLineBytes,
      DEFAULT_MAX_NDJSON_LINE_BYTES,
      "maxLineBytes"
    );
    void this.open();
  }

  send(data: string): void {
    if (this.readyState !== WebSocket.OPEN || this.closed) return;
    void this.options.rpc
      .call("main", "panelCdp.hostProvider.send", [this.sessionId, data])
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
    void this.options.rpc
      .call("main", "panelCdp.hostProvider.close", [this.sessionId])
      .catch(() => {});
    this.emit("close");
  }

  private async open(): Promise<void> {
    try {
      const response = await this.options.rpc.stream("main", "panelCdp.hostProvider.open", [
        this.sessionId,
        this.options.hostConnectionId,
      ]);
      if (this.closed) {
        void this.options.rpc
          .call("main", "panelCdp.hostProvider.close", [this.sessionId])
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
    let bufferedLineBytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > this.maxNdjsonChunkBytes) {
        throw new Error(`CDP host provider frame exceeded ${this.maxNdjsonChunkBytes} bytes`);
      }
      bufferedLineBytes = observeNdjsonLineBytes(
        value,
        bufferedLineBytes,
        this.maxNdjsonLineBytes
      );
      buffered += decoder.decode(value, { stream: true });
      buffered = this.emitBufferedMessages(buffered);
      if (buffered.length === 0) bufferedLineBytes = 0;
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

function observeNdjsonLineBytes(
  chunk: Uint8Array,
  initialLineBytes: number,
  maxLineBytes: number
): number {
  let lineBytes = initialLineBytes;
  for (const byte of chunk) {
    if (byte === 0x0a) {
      lineBytes = 0;
      continue;
    }
    lineBytes += 1;
    if (lineBytes > maxLineBytes) {
      throw new Error(`CDP host provider NDJSON line exceeded ${maxLineBytes} bytes`);
    }
  }
  return lineBytes;
}
