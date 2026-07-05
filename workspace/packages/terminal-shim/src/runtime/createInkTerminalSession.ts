import { VibestudioWritableTTY } from "../streams/VibestudioWritableTTY.js";
import { VibestudioReadableTTY } from "../streams/VibestudioReadableTTY.js";
import { __setTerminalSize } from "../node/terminal-size.js";
import { __runExitHandlers } from "../node/signal-exit.js";

export interface TerminalSize {
  columns: number;
  rows: number;
}

/**
 * The worker-side port the shim writes terminal output through and asks the
 * host for terminal effects. The wire encoding lives in
 * `@workspace/terminal-host-protocol`; the shim only needs this surface.
 */
export interface TerminalHostSink {
  /** Forward a chunk of terminal output to the host for the given stream. */
  write(stream: "stdout" | "stderr", data: Uint8Array): void;
  /** Ask the host to set raw mode on the real TTY (focused session only). */
  setRawMode?(enabled: boolean): void;
}

export interface CreateInkTerminalSessionOptions {
  sessionId: string;
  sink: TerminalHostSink;
  initialSize?: TerminalSize;
}

export interface InkTerminalSession {
  /** Pass these into Ink's `render(node, { stdin, stdout, stderr })`. */
  stdin: VibestudioReadableTTY;
  stdout: VibestudioWritableTTY;
  stderr: VibestudioWritableTTY;
  /** Deliver host-forwarded input bytes to Ink's `useInput`. */
  emitInput(data: Uint8Array): void;
  /** Apply a host resize: updates streams + the terminal-size shim. */
  emitResize(size: TerminalSize): void;
  /** Run Ink/signal-exit cleanup and mark the session torn down. */
  dispose(): void;
}

/**
 * Build the Node-ish TTY environment Ink expects inside workerd. Streams write
 * to / read from the host (never a real fd). `nodejs_compat` supplies
 * `process`/`stream`/`events`/`Buffer`, so we shim only the TTY streams, the
 * resizable terminal-size holder, and signal-exit cleanup.
 */
export function createInkTerminalSession(
  options: CreateInkTerminalSessionOptions,
): InkTerminalSession {
  const size = options.initialSize ?? { columns: 80, rows: 24 };
  __setTerminalSize(size);

  const stdout = new VibestudioWritableTTY(
    (data) => options.sink.write("stdout", data),
    size.columns,
    size.rows,
  );
  const stderr = new VibestudioWritableTTY(
    (data) => options.sink.write("stderr", data),
    size.columns,
    size.rows,
  );
  const stdin = new VibestudioReadableTTY((enabled) => options.sink.setRawMode?.(enabled));

  let disposed = false;

  return {
    stdin,
    stdout,
    stderr,
    emitInput(data: Uint8Array): void {
      if (disposed) return;
      stdin.push(data);
    },
    emitResize(next: TerminalSize): void {
      if (disposed) return;
      __setTerminalSize(next);
      stdout.setSize(next.columns, next.rows);
      stderr.setSize(next.columns, next.rows);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      __runExitHandlers(0, null);
    },
  };
}
