import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import nodePty from "node-pty";
export interface NativeTerminalSnapshot {
  terminalSessionId: string;
  cursor: number;
  text: string;
  alive: boolean;
  exit: { code: number; signal?: number } | null;
}

export interface NativeTerminalSurface {
  read(input: {
    terminalSessionId: string;
    after?: number;
    maxBytes?: number;
  }): NativeTerminalSnapshot;
  write(input: { terminalSessionId: string; sequence: number; data: string }): void;
  resize(input: { terminalSessionId: string; columns: number; rows: number }): void;
}

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
  writeSequence: number;
  writeDigest: string | null;
}

/**
 * PTY mechanism shared by explicitly authorized host terminals and native development tools.
 *
 * The Development service can expose these bounded methods directly; the tool
 * never inherits the source server's terminal, and interactive input/output is
 * tied to the exact development terminalSessionId.
 */
export class NativeTerminalRegistry implements NativeTerminalSurface {
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
    if (this.records.size >= 32) throw coded("ELIMIT", "Native terminal session limit reached");
    this.validateDimensions(input.columns ?? 120, input.rows ?? 36);
    const terminalSessionId = `native-terminal:${randomUUID()}`;
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
      writeSequence: 0,
      writeDigest: null,
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
  }): NativeTerminalSnapshot {
    const record = this.require(input.terminalSessionId);
    const maximum = input.maxBytes ?? MAX_READ_BYTES;
    if (!Number.isSafeInteger(maximum) || maximum < 4 || maximum > MAX_READ_BYTES)
      throw coded("EINVAL", "Terminal read limit must be between 4 and 524288 bytes");
    if (input.after !== undefined && (!Number.isSafeInteger(input.after) || input.after < 0))
      throw coded("EINVAL", "Invalid terminal read cursor");
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
    let output = Buffer.concat(parts);
    if (output.length && (output[0]! & 0xc0) === 0x80)
      throw coded("EINVAL", "Terminal read cursor is inside a UTF-8 character");
    // A read cursor must not split a UTF-8 character and replace its halves in
    // two responses. PTY chunks entered this buffer as complete UTF-8 strings.
    let lead = output.length - 1;
    while (lead >= 0 && (output[lead]! & 0xc0) === 0x80) lead--;
    if (lead >= 0) {
      const byte = output[lead]!;
      const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
      if (output.length - lead < width) output = output.subarray(0, lead);
    }
    return {
      terminalSessionId: record.terminalSessionId,
      cursor: after + output.length,
      text: output.toString("utf8"),
      alive: record.alive,
      exit: record.exit,
    };
  }

  write(input: { terminalSessionId: string; sequence: number; data: string }): void {
    const record = this.require(input.terminalSessionId);
    const digest = createHash("sha256").update(input.data).digest("hex");
    if (input.sequence === record.writeSequence) {
      if (record.writeDigest !== digest) {
        throw coded("EIDEMPOTENCY_CONFLICT", "Terminal sequence was reused with different input");
      }
      return;
    }
    if (!record.alive) throw coded("EPROCESS_EXITED", "Native terminal has exited");
    if (Buffer.byteLength(input.data) > MAX_READ_BYTES)
      throw coded("ELIMIT", "Terminal input exceeds the byte limit");
    if (!Number.isSafeInteger(input.sequence) || input.sequence !== record.writeSequence + 1)
      throw coded("EINPUT_SEQUENCE", "Terminal input must be delivered in sequence");
    record.process.write(input.data);
    record.writeSequence = input.sequence;
    record.writeDigest = digest;
  }

  resize(input: { terminalSessionId: string; columns: number; rows: number }): void {
    const record = this.require(input.terminalSessionId);
    this.validateDimensions(input.columns, input.rows);
    if (!record.alive) throw coded("EPROCESS_EXITED", "Native terminal has exited");
    record.process.resize(input.columns, input.rows);
  }

  private validateDimensions(columns: number, rows: number): void {
    if (
      !Number.isInteger(columns) ||
      columns < 20 ||
      columns > 1_000 ||
      !Number.isInteger(rows) ||
      rows < 5 ||
      rows > 1_000
    ) {
      throw coded("EINVAL", "Invalid native terminal dimensions");
    }
  }

  async close(
    terminalSessionId: string,
    ownerSessionId: string
  ): Promise<{
    processExited: boolean;
    descendantCleanup: "unverified";
  }> {
    this.assertOwner(terminalSessionId, ownerSessionId);
    const record = this.require(terminalSessionId);
    this.records.delete(terminalSessionId);
    if (record.alive) {
      try {
        record.process.kill();
      } catch {
        /* The PTY may have exited concurrently. */
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          record.exitPromise,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 1500);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    return { processExited: !record.alive, descendantCleanup: "unverified" };
  }

  assertOwner(terminalSessionId: string, ownerSessionId: string): void {
    const record = this.require(terminalSessionId);
    if (record.ownerSessionId !== ownerSessionId) {
      throw coded("EOWNERSHIP", "Native terminal belongs to another session");
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
    if (!record) throw coded("ENOENT", "Unknown native terminal session");
    return record;
  }

  private append(record: TerminalRecord, bytes: Buffer): void {
    if (bytes.byteLength === 0) return;
    const start = record.cursor;
    record.cursor += bytes.byteLength;
    if (bytes.byteLength >= DEFAULT_SCROLLBACK_BYTES) {
      let offset = bytes.length - DEFAULT_SCROLLBACK_BYTES;
      while ((bytes[offset]! & 0xc0) === 0x80) offset++;
      record.chunks = [
        {
          start: start + offset,
          end: record.cursor,
          bytes: Buffer.from(bytes.subarray(offset)),
        },
      ];
      return;
    }
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
