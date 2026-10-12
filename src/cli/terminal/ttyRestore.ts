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
