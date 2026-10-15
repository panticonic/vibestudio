/** These declarations describe the implementation installed by polyfills.ts,
 * not browser APIs borrowed by a native type environment. */
export {};
declare global {
  interface AbortSignal {
    // Matches the WHATWG declaration: a caller can abort with any JS value.
    readonly reason: any;
    throwIfAborted(): void;
  }
  interface AbortController {
    abort(reason?: unknown): void;
  }
  namespace AbortSignal {
    function abort(reason?: unknown): AbortSignal;
    function any(signals: Iterable<AbortSignal>): AbortSignal;
  }
}
