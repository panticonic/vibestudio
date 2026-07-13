import { OAuthConnectionError } from "./errors.js";

export function connectionAbortError(): OAuthConnectionError {
  return new OAuthConnectionError("approval_denied", "Credential connection cancelled");
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw connectionAbortError();
}

export function abortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  onAbort?: () => void
): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      onAbort?.();
      reject(connectionAbortError());
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(connectionAbortError());
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function anySignal(
  signals: ReadonlyArray<AbortSignal | undefined>
): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  for (const signal of active) {
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}
