/**
 * Replacement for the `signal-exit` npm package inside workerd.
 *
 * The real `signal-exit` does CommonJS `require('assert')` at module scope,
 * which workerd rejects at startup ("Dynamic require of 'assert' is not
 * supported"). Ink imports the default export and calls it as
 * `signalExit(cb)`. There is no real process to exit in a worker — session
 * teardown is driven by the host — so registered callbacks are tracked but
 * only fired via explicit disposal (see createInkTerminalSession).
 */
const callbacks = new Set<(code: number | null, signal: string | null) => void>();

function signalExit(cb: (code: number | null, signal: string | null) => void): () => void {
  callbacks.add(cb);
  return () => callbacks.delete(cb);
}

/** Invoked by the shim runtime on session disposal — runs Ink's cleanup. */
export function __runExitHandlers(code: number | null = 0, signal: string | null = null): void {
  for (const cb of [...callbacks]) {
    try {
      cb(code, signal);
    } catch {
      // ignore — cleanup handlers must not block disposal
    }
  }
}

export default signalExit;
export const onExit = signalExit;
export function load(): void {}
export function unload(): void {}
