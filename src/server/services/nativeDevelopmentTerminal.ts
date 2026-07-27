import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import nodePty from "node-pty";
import type {
  NativeDevelopmentTerminalSnapshot,
  NativeDevelopmentTerminalSurface,
} from "./nativeDevelopmentExecutor.js";

const DEFAULT_SCROLLBACK_BYTES = 2 * 1024 * 1024;
const MAX_READ_BYTES = 512 * 1024;

interface PtyProcess {
  pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
}

interface TerminalRecord {
  terminalSessionId: string;
  ownerSessionId: string;
  process: PtyProcess;
  chunks: Array<{ start: number; end: number; bytes: Buffer }>;
  cursor: number;
  alive: boolean;
  exit: { code: number; signal?: number } | null;
  exitPromise: Promise<void>;
  settleExit: () => void;
  writes: Map<string, string>;
}

/**
 * Host-owned PTY surface for native development tools.
 *
 * The Development service can expose these bounded methods directly; the tool
 * never inherits the source server's terminal, and interactive input/output is
 * tied to the exact development terminalSessionId.
 */
export class NativeDevelopmentTerminalRegistry implements NativeDevelopmentTerminalSurface {
  private readonly records = new Map<string, TerminalRecord>();

  launch(input: {
    ownerSessionId: string;
    executable: string;
    args: readonly string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    columns?: number;
    rows?: number;
  }): {
    terminalSessionId: string;
    pid: number;
    exit: Promise<void>;
  } {
    const terminalSessionId = `development-terminal:${input.ownerSessionId}:${randomUUID()}`;
    let settleExit!: () => void;
    const exitPromise = new Promise<void>((resolve) => {
      settleExit = resolve;
    });
    const process = (
      nodePty as unknown as {
        spawn(
          executable: string,
          args: string[],
          options: {
            name: string;
            cols: number;
            rows: number;
            cwd: string;
            env: NodeJS.ProcessEnv;
          }
        ): PtyProcess;
      }
    ).spawn(input.executable, [...input.args], {
      name: "xterm-256color",
      cols: input.columns ?? 120,
      rows: input.rows ?? 36,
      cwd: input.cwd,
      env: input.env,
    });
    const record: TerminalRecord = {
      terminalSessionId,
      ownerSessionId: input.ownerSessionId,
      process,
      chunks: [],
      cursor: 0,
      alive: true,
      exit: null,
      exitPromise,
      settleExit,
      writes: new Map(),
    };
    process.onData((data) => this.append(record, Buffer.from(data, "utf8")));
    process.onExit(({ exitCode, signal }) => {
      record.alive = false;
      record.exit = {
        code: exitCode,
        ...(signal === undefined ? {} : { signal }),
      };
      record.settleExit();
    });
    this.records.set(terminalSessionId, record);
    return { terminalSessionId, pid: process.pid, exit: exitPromise };
  }

  read(input: {
    terminalSessionId: string;
    after?: number;
    maxBytes?: number;
  }): NativeDevelopmentTerminalSnapshot {
    const record = this.require(input.terminalSessionId);
    const maximum = Math.min(MAX_READ_BYTES, Math.max(1, input.maxBytes ?? MAX_READ_BYTES));
    const earliest = record.chunks[0]?.start ?? record.cursor;
    const after = Math.max(earliest, Math.min(record.cursor, input.after ?? earliest));
    const parts: Buffer[] = [];
    let remaining = maximum;
    for (const chunk of record.chunks) {
      if (chunk.end <= after || remaining <= 0) continue;
      const offset = Math.max(0, after - chunk.start);
      const selected = chunk.bytes.subarray(offset, offset + remaining);
      parts.push(selected);
      remaining -= selected.byteLength;
    }
    return {
      terminalSessionId: record.terminalSessionId,
      cursor: record.cursor,
      text: Buffer.concat(parts).toString("utf8"),
      alive: record.alive,
      exit: record.exit,
    };
  }

  write(input: { terminalSessionId: string; writeId: string; data: string }): void {
    const record = this.require(input.terminalSessionId);
    const digest = createHash("sha256").update(input.data).digest("hex");
    const previous = record.writes.get(input.writeId);
    if (previous !== undefined) {
      if (previous !== digest) {
        throw coded("EIDEMPOTENCY_CONFLICT", "Terminal writeId was reused with different input");
      }
      return;
    }
    if (!record.alive) throw coded("EPROCESS_EXITED", "Development terminal has exited");
    record.process.write(input.data);
    record.writes.set(input.writeId, digest);
  }

  resize(input: { terminalSessionId: string; columns: number; rows: number }): void {
    const record = this.require(input.terminalSessionId);
    if (
      !Number.isInteger(input.columns) ||
      input.columns < 20 ||
      input.columns > 1_000 ||
      !Number.isInteger(input.rows) ||
      input.rows < 5 ||
      input.rows > 1_000
    ) {
      throw coded("EINVAL", "Invalid development terminal dimensions");
    }
    if (!record.alive) throw coded("EPROCESS_EXITED", "Development terminal has exited");
    record.process.resize(input.columns, input.rows);
  }

  assertOwner(terminalSessionId: string, ownerSessionId: string): void {
    const record = this.require(terminalSessionId);
    if (record.ownerSessionId !== ownerSessionId) {
      throw coded("EOWNERSHIP", "Development terminal belongs to another session");
    }
  }

  retire(terminalSessionId: string, ownerSessionId: string): void {
    this.assertOwner(terminalSessionId, ownerSessionId);
    this.records.delete(terminalSessionId);
  }

  abortLaunch(terminalSessionId: string, ownerSessionId: string): void {
    this.assertOwner(terminalSessionId, ownerSessionId);
    const record = this.require(terminalSessionId);
    if (record.alive) record.process.kill("SIGKILL");
    this.records.delete(terminalSessionId);
  }

  private require(terminalSessionId: string): TerminalRecord {
    const record = this.records.get(terminalSessionId);
    if (!record) throw coded("ENOENT", "Unknown development terminal session");
    return record;
  }

  private append(record: TerminalRecord, bytes: Buffer): void {
    if (bytes.byteLength === 0) return;
    const start = record.cursor;
    record.cursor += bytes.byteLength;
    record.chunks.push({ start, end: record.cursor, bytes });
    let total = record.chunks.reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0);
    while (total > DEFAULT_SCROLLBACK_BYTES && record.chunks.length > 1) {
      total -= record.chunks.shift()!.bytes.byteLength;
    }
  }
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
