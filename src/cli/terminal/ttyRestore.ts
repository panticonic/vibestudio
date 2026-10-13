/**
 * Terminal restoration for `vibestudio terminal`.
 *
 * The terminal browser owns the TTY while its `run(host)` is pending: raw
 * mode, the alternate screen, a hidden cursor, mouse and paste reporting. The
 * CLI owns the TTY before and after, and must hand it back to the shell in a
 * usable state on every exit path — a normal quit, a thrown error, a lost
 * connection, a signal, or the imported app calling `process.exit`.
 */

/**
 * Everything a terminal app may have switched on, switched back off. Each
 * sequence is idempotent, so restoring a terminal that was never touched is
 * harmless.
 */
export const TERMINAL_RESET_SEQUENCE = [
  "\x1b[?2026l", // end synchronized output
  "\x1b[?1000l", // mouse: button reporting off
  "\x1b[?1002l", // mouse: drag reporting off
  "\x1b[?1003l", // mouse: any-motion reporting off
  "\x1b[?1006l", // mouse: SGR encoding off
  "\x1b[?2004l", // bracketed paste off
  "\x1b[?1004l", // focus reporting off
  "\x1b[0m", // reset colors and attributes
  "\x1b[?1049l", // leave the alternate screen
  "\x1b[?25h", // show the cursor
].join("");

export interface RestorableInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
  pause(): unknown;
}

export interface RestorableOutput {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

/** Return the terminal to line mode with the main screen and a visible cursor. */
export function restoreTerminal(input: RestorableInput, output: RestorableOutput): void {
  if (input.isTTY && input.isRaw) input.setRawMode?.(false);
  input.pause();
  if (output.isTTY) output.write(TERMINAL_RESET_SEQUENCE);
}

/**
 * Keep the terminal restorable for the lifetime of one app run. Restores on
 * `process.exit` (which bypasses `finally` blocks) as well as when the
 * returned release function runs; restoring twice is harmless.
 */
export function guardTerminal(
  input: RestorableInput,
  output: RestorableOutput,
  processLike: Pick<NodeJS.Process, "on" | "off"> = process
): () => void {
  const onExit = () => restoreTerminal(input, output);
  processLike.on("exit", onExit);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    processLike.off("exit", onExit);
    restoreTerminal(input, output);
  };
}

/**
 * Whether `error` on `stream` is a read or write on a terminal that has hung
 * up. On anything but a TTY (a redirected file), EIO is a real I/O failure.
 */
export function isTerminalHangup(stream: { isTTY?: boolean }, error: unknown): boolean {
  return stream.isTTY === true && (error as NodeJS.ErrnoException | null)?.code === "EIO";
}

/**
 * Treat a hung-up terminal as gone, not as a crash. Once the terminal window
 * closes (or its SSH link drops), every read and write on it fails with EIO.
 * Without a listener Node throws that `error` event and ends the command in
 * the middle of stopping and joining what it owns; with this one the command
 * keeps running its cleanup and later output is simply dropped. Any other
 * stream error still fails the process as before. Returns a release function.
 */
export function tolerateTerminalHangup(
  streams: readonly (Pick<NodeJS.EventEmitter, "on" | "off"> & { isTTY?: boolean })[] = [
    process.stdin,
    process.stdout,
    process.stderr,
  ]
): () => void {
  const listeners = streams.map((stream) => {
    const onError = (error: NodeJS.ErrnoException) => {
      if (!isTerminalHangup(stream, error)) throw error;
    };
    stream.on("error", onError);
    return () => stream.off("error", onError);
  });
  return () => {
    for (const release of listeners) release();
  };
}

type WarningProcess = Pick<NodeJS.Process, "on" | "off" | "listeners" | "removeAllListeners">;

/**
 * Send this process's own warnings (Node's `ExperimentalWarning` for
 * `node:sqlite`, deprecations) to `write` instead of stderr. While a terminal
 * command runs, the TTY belongs to the user — its prompts and then the
 * terminal browser's screen — and launcher diagnostics belong in its log.
 *
 * Node emits a warning on the tick after the code that raised it, so a
 * command that installs this before its first `await` also routes warnings
 * raised while its modules loaded. Returns a function that restores Node's
 * own reporting.
 */
export function routeProcessWarnings(
  write: (text: string) => void,
  processLike: WarningProcess = process
): () => void {
  const previous = processLike.listeners("warning") as ((warning: Error) => void)[];
  processLike.removeAllListeners("warning");
  const onWarning = (warning: Error) => {
    write(`(node:${process.pid}) ${warning.name}: ${warning.message}\n`);
  };
  processLike.on("warning", onWarning);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    processLike.off("warning", onWarning);
    for (const listener of previous) processLike.on("warning", listener);
  };
}
