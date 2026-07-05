/**
 * serverLogStore — in-process capture of ALL host server logs.
 *
 * The server's logging convention is `console.*` with a `[Tag]` prefix
 * (createDevLogger writes through console too), so installing a console
 * interceptor captures the complete host log stream — startup, services,
 * builds, third-party — without touching call sites. Each record is
 * structured with as much metadata as we can attach cheaply:
 *
 *   { seq, timestamp, level, tag, message, fields, pid }
 *
 * plus store-level constants (workspaceId, serverBootId, startedAt) surfaced
 * by the serverLog service envelope.
 *
 * Security: host logs include secrets by design (startup pairing codes, the
 * admin token echo). The store REDACTS registered secret strings at capture
 * time so the log surface is safe to expose to userland agents/panels.
 *
 * Persistence: records are also appended as JSONL to
 * `<statePath>/logs/server-log.jsonl` (size-rotated once to `.1`) for
 * post-mortems; queries are served from the in-memory ring buffer only.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type ServerLogLevel = "verbose" | "info" | "warn" | "error";

export interface ServerLogRecord {
  /** Monotonic per-boot sequence number (also the streaming dedupe key). */
  seq: number;
  /** Epoch ms capture time. */
  timestamp: number;
  level: ServerLogLevel;
  /** Subsystem tag parsed from the conventional `[Tag]` prefix, if present. */
  tag?: string;
  /** The formatted message (tag prefix stripped when parsed into `tag`). */
  message: string;
  /** Structured trailing args (JSON-safe), when the call site passed any. */
  fields?: unknown[];
  pid: number;
}

export interface ServerLogQuery {
  /** Return records with seq > sinceSeq (streaming catch-up cursor). */
  sinceSeq?: number;
  /** Epoch-ms lower bound (inclusive). */
  since?: number;
  /** Epoch-ms upper bound (inclusive). */
  until?: number;
  /** Minimum level (verbose < info < warn < error). */
  level?: ServerLogLevel;
  /** Exact subsystem tag match. */
  tag?: string;
  /** Case-insensitive substring match on message. */
  contains?: string;
  /** Max records returned (default 500, capped by the store). */
  limit?: number;
}

export interface ServerLogStats {
  bufferSize: number;
  totalCaptured: number;
  oldestSeq: number | null;
  latestSeq: number;
  byLevel: Record<ServerLogLevel, number>;
  /** Capture counts per subsystem tag, descending, top 50. */
  byTag: Array<{ tag: string; count: number }>;
}

const LEVEL_PRIORITY: Record<ServerLogLevel, number> = {
  verbose: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const DEFAULT_BUFFER_SIZE = 20_000;
const DEFAULT_QUERY_LIMIT = 500;
const MAX_QUERY_LIMIT = 5_000;
const JSONL_ROTATE_BYTES = 16 * 1024 * 1024;

const TAG_PREFIX_RE = /^\[([^\]\n]{1,64})\]\s?/;

function formatConsoleArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack ?? arg.message;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

/** Best-effort JSON-safe clone for structured trailing args. */
function toJsonSafe(arg: unknown): unknown {
  if (arg instanceof Error) return { name: arg.name, message: arg.message, stack: arg.stack };
  try {
    return JSON.parse(JSON.stringify(arg));
  } catch {
    return String(arg);
  }
}

export interface ServerLogStore {
  /** Capture one record. Used by the console interceptor and available directly. */
  append(level: ServerLogLevel, parts: unknown[]): void;
  query(query: ServerLogQuery): { records: ServerLogRecord[]; latestSeq: number };
  /** Last `limit` records in ascending seq order. */
  tail(limit?: number): { records: ServerLogRecord[]; latestSeq: number };
  stats(): ServerLogStats;
  /** Redact this exact string from all past-buffered and future records. */
  addSecret(secret: string): void;
  /** Streaming hook: fires per captured record (the service batches). */
  onAppend(listener: (record: ServerLogRecord) => void): () => void;
  /**
   * Patch console.log/info/debug/warn/error to tee into this store while
   * still writing to the original console. Idempotent.
   */
  installConsoleCapture(): void;
  /** Start appending JSONL to `<dir>/server-log.jsonl` (size-rotated). */
  attachJsonlSink(dir: string): void;
  latestSeq(): number;
}

export function createServerLogStore(
  options: { bufferSize?: number; now?: () => number } = {}
): ServerLogStore {
  const bufferSize = options.bufferSize ?? DEFAULT_BUFFER_SIZE;
  const now = options.now ?? Date.now;
  const buffer: ServerLogRecord[] = [];
  const listeners = new Set<(record: ServerLogRecord) => void>();
  const secrets: string[] = [];
  let seq = 0;
  let totalCaptured = 0;
  let capturing = false;
  let consoleInstalled = false;
  let jsonlPath: string | null = null;
  let jsonlBytes = 0;

  const redact = (text: string): string => {
    let out = text;
    for (const secret of secrets) {
      if (secret && out.includes(secret)) out = out.split(secret).join("[redacted]");
    }
    return out;
  };

  /** Redact secrets inside a JSON-safe structured value. */
  const redactDeep = (value: unknown): unknown => {
    if (secrets.length === 0) return value;
    try {
      return JSON.parse(redact(JSON.stringify(value)));
    } catch {
      return value;
    }
  };

  const writeJsonl = (record: ServerLogRecord): void => {
    if (!jsonlPath) return;
    try {
      const line = `${JSON.stringify(record)}\n`;
      jsonlBytes += line.length;
      if (jsonlBytes > JSONL_ROTATE_BYTES) {
        fs.renameSync(jsonlPath, `${jsonlPath}.1`);
        jsonlBytes = line.length;
      }
      fs.appendFileSync(jsonlPath, line);
    } catch {
      // Persistence is best-effort; never let the sink break logging.
    }
  };

  const store: ServerLogStore = {
    append(level: ServerLogLevel, parts: unknown[]): void {
      // Re-entrancy guard: a listener (event fan-out) that itself logs must
      // not recurse into capture.
      if (capturing) return;
      capturing = true;
      try {
        const [head, ...rest] = parts;
        let message = redact(formatConsoleArg(head));
        // printf-style call sites and multi-string logs: join string tails
        // into the message, keep non-strings as structured fields.
        const fields: unknown[] = [];
        for (const arg of rest) {
          if (typeof arg === "string") {
            message += ` ${redact(arg)}`;
          } else {
            fields.push(arg);
          }
        }
        let tag: string | undefined;
        const tagMatch = TAG_PREFIX_RE.exec(message);
        if (tagMatch) {
          tag = tagMatch[1];
          message = message.slice(tagMatch[0].length);
        }
        const record: ServerLogRecord = {
          seq: ++seq,
          timestamp: now(),
          level,
          ...(tag ? { tag } : {}),
          message,
          ...(fields.length > 0 ? { fields: fields.map((f) => redactDeep(toJsonSafe(f))) } : {}),
          pid: process.pid,
        };
        buffer.push(record);
        if (buffer.length > bufferSize) buffer.splice(0, buffer.length - bufferSize);
        totalCaptured++;
        writeJsonl(record);
        for (const listener of listeners) {
          try {
            listener(record);
          } catch {
            // Listener failures must never break logging.
          }
        }
      } finally {
        capturing = false;
      }
    },

    query(query: ServerLogQuery): { records: ServerLogRecord[]; latestSeq: number } {
      const limit = Math.max(1, Math.min(query.limit ?? DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT));
      const minPriority = query.level ? LEVEL_PRIORITY[query.level] : 0;
      const needle = query.contains?.toLowerCase();
      const matched: ServerLogRecord[] = [];
      // Scan newest→oldest so `limit` keeps the most recent matches, then
      // restore ascending order for the caller.
      for (let i = buffer.length - 1; i >= 0 && matched.length < limit; i--) {
        const record = buffer[i]!;
        if (query.sinceSeq !== undefined && record.seq <= query.sinceSeq) break;
        if (query.since !== undefined && record.timestamp < query.since) break;
        if (query.until !== undefined && record.timestamp > query.until) continue;
        if (LEVEL_PRIORITY[record.level] < minPriority) continue;
        if (query.tag !== undefined && record.tag !== query.tag) continue;
        if (needle && !record.message.toLowerCase().includes(needle)) continue;
        matched.push(record);
      }
      matched.reverse();
      return { records: matched, latestSeq: seq };
    },

    tail(limit = DEFAULT_QUERY_LIMIT): { records: ServerLogRecord[]; latestSeq: number } {
      const capped = Math.max(1, Math.min(limit, MAX_QUERY_LIMIT));
      return { records: buffer.slice(-capped), latestSeq: seq };
    },

    stats(): ServerLogStats {
      const byLevel: Record<ServerLogLevel, number> = { verbose: 0, info: 0, warn: 0, error: 0 };
      const byTagMap = new Map<string, number>();
      for (const record of buffer) {
        byLevel[record.level]++;
        if (record.tag) byTagMap.set(record.tag, (byTagMap.get(record.tag) ?? 0) + 1);
      }
      const byTag = [...byTagMap.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 50);
      return {
        bufferSize,
        totalCaptured,
        oldestSeq: buffer[0]?.seq ?? null,
        latestSeq: seq,
        byLevel,
        byTag,
      };
    },

    addSecret(secret: string): void {
      if (!secret || secret.length < 8) return; // too short to redact safely
      secrets.push(secret);
      // Scrub anything already captured before the secret was registered.
      for (const record of buffer) {
        if (record.message.includes(secret)) {
          record.message = record.message.split(secret).join("[redacted]");
        }
      }
    },

    onAppend(listener: (record: ServerLogRecord) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    installConsoleCapture(): void {
      if (consoleInstalled) return;
      consoleInstalled = true;
      const patch = (
        method: "log" | "info" | "debug" | "warn" | "error",
        level: ServerLogLevel
      ) => {
        const original = console[method].bind(console);
        console[method] = (...args: unknown[]) => {
          store.append(level, args);
          original(...args);
        };
      };
      patch("debug", "verbose");
      patch("log", "info");
      patch("info", "info");
      patch("warn", "warn");
      patch("error", "error");
    },

    attachJsonlSink(dir: string): void {
      try {
        fs.mkdirSync(dir, { recursive: true });
        jsonlPath = path.join(dir, "server-log.jsonl");
        // Fresh boot starts a fresh file; the previous boot's log rotates away.
        try {
          if (fs.existsSync(jsonlPath)) fs.renameSync(jsonlPath, `${jsonlPath}.1`);
        } catch {
          /* rotation is best-effort */
        }
        jsonlBytes = 0;
      } catch {
        jsonlPath = null;
      }
    },

    latestSeq(): number {
      return seq;
    },
  };
  return store;
}
