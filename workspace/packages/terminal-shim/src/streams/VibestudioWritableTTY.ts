import { EventEmitter } from "node:events";

/**
 * Duck-typed writable TTY sufficient for Ink's stdout/stderr. Ink writes ANSI
 * frames via `write()` and reads `columns`/`rows`/`isTTY`; it listens for
 * `resize`. We forward every write to a sink (the host, via RPC) as UTF-8 bytes.
 * There is no real fd — nothing here touches a real stream.
 */
export class VibestudioWritableTTY extends EventEmitter {
  readonly isTTY = true as const;
  columns: number;
  rows: number;
  writable = true;
  writableEnded = false;
  destroyed = false;
  writableLength = 0;

  private readonly sink: (data: Uint8Array) => void;
  private readonly encoder = new TextEncoder();

  constructor(sink: (data: Uint8Array) => void, columns: number, rows: number) {
    super();
    this.sink = sink;
    this.columns = columns;
    this.rows = rows;
  }

  write(
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | (() => void),
    cb?: () => void,
  ): boolean {
    const done = typeof encodingOrCb === "function" ? encodingOrCb : cb;
    const bytes = typeof chunk === "string" ? this.encoder.encode(chunk) : chunk;
    this.sink(bytes);
    if (done) queueMicrotask(done);
    return true;
  }

  end(chunk?: string | Uint8Array): void {
    if (chunk !== undefined) this.write(chunk);
    this.writableEnded = true;
    this.emit("finish");
  }

  // Ink/ansi-escapes occasionally probe these — provide safe answers.
  getColorDepth(): number {
    return 24;
  }
  hasColors(): boolean {
    return true;
  }

  /** Internal: update size and notify Ink so it re-lays-out. */
  setSize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.emit("resize");
  }
}
