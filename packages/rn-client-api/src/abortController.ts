/** Upgrade React Native's signal in place: fetch and native listeners retain
 * their original EventTarget/AbortSignal identity. Only the controller gains
 * ownership of the standard abort reason, recorded before native dispatch. */
interface NativeSignal {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

interface NativeController {
  readonly signal: NativeSignal;
  abort(reason?: unknown): void;
}

export function installStandardAbortController(
  NativeAbortController: new () => NativeController,
  Signal: Function & { prototype: NativeSignal },
  DOMException: new (message?: string, name?: string) => Error
): void {
  const prototype = Signal.prototype;
  if (
    "reason" in prototype &&
    typeof Reflect.get(prototype, "throwIfAborted") === "function" &&
    typeof Reflect.get(Signal, "abort") === "function" &&
    typeof Reflect.get(Signal, "any") === "function"
  )
    return;

  const abortedGetter = Object.getOwnPropertyDescriptor(prototype, "aborted")?.get;
  const originalReason = Object.getOwnPropertyDescriptor(prototype, "reason")?.get;
  if (!abortedGetter) throw new TypeError("AbortSignal must provide its native aborted getter");
  const aborted = abortedGetter;
  const reasons = new WeakMap<NativeSignal, unknown>();
  const reasonOf = (signal: NativeSignal): unknown => {
    if (!aborted.call(signal)) return undefined;
    // Signals created before installation cannot retrospectively acquire a
    // caller reason, but their default cancellation must still be stable.
    if (!reasons.has(signal))
      reasons.set(
        signal,
        originalReason
          ? originalReason.call(signal)
          : new DOMException("This operation was aborted", "AbortError")
      );
    return reasons.get(signal);
  };
  Object.defineProperties(prototype, {
    reason: {
      configurable: true,
      enumerable: true,
      get(this: NativeSignal) {
        return reasonOf(this);
      },
    },
    throwIfAborted: {
      configurable: true,
      writable: true,
      enumerable: true,
      value(this: NativeSignal) {
        if (aborted.call(this)) throw reasonOf(this);
      },
    },
  });

  const nativeAbort = NativeAbortController.prototype.abort;
  Object.defineProperty(NativeAbortController.prototype, "abort", {
    configurable: true,
    writable: true,
    enumerable: true,
    value(this: NativeController, reason?: unknown): void {
      if (aborted.call(this.signal)) return;
      reasons.set(
        this.signal,
        reason === undefined ? new DOMException("This operation was aborted", "AbortError") : reason
      );
      nativeAbort.call(this);
    },
  });
  Object.defineProperties(Signal, {
    abort: {
      configurable: true,
      writable: true,
      value(reason?: unknown) {
        const controller = new NativeAbortController();
        controller.abort(reason);
        return controller.signal;
      },
    },
    any: {
      configurable: true,
      writable: true,
      value(iterable: Iterable<NativeSignal>) {
        // Complete iterable conversion/brand validation before attaching anything:
        // invalid input cannot strand a partially admitted listener lifetime.
        const signals = [...iterable];
        for (const signal of signals) aborted.call(signal);
        const controller = new NativeAbortController();
        for (const signal of signals) {
          if (signal.aborted) {
            controller.abort(reasonOf(signal));
            return controller.signal;
          }
        }
        const releases: Array<() => void> = [];
        const release = () => {
          const failures: unknown[] = [];
          for (const dispose of releases.splice(0)) {
            try {
              dispose();
            } catch (error) {
              failures.push(error);
            }
          }
          if (failures.length === 1) throw failures[0];
          if (failures.length > 1)
            throw new AggregateError(failures, "AbortSignal.any listener retirement failed", {
              cause: failures[0],
            });
        };
        try {
          for (const signal of new Set(signals)) {
            const onAbort = () => {
              try {
                release();
              } finally {
                controller.abort(reasonOf(signal));
              }
            };
            releases.push(() => signal.removeEventListener("abort", onAbort));
            signal.addEventListener("abort", onAbort, { once: true });
          }
        } catch (error) {
          try {
            release();
          } catch (cleanup) {
            throw new AggregateError(
              [error, cleanup],
              "AbortSignal.any admission and retirement failed",
              { cause: error }
            );
          }
          throw error;
        }
        return controller.signal;
      },
    },
  });
}
