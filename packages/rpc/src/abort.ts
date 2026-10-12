/** Throw the caller's cancellation reason without relying on newer AbortSignal APIs. */
export function throwIfAborted(signal?: AbortSignal | null): void {
  if (!signal?.aborted) return;
  const reason = (signal as AbortSignal & { readonly reason?: unknown }).reason;
  if (reason !== undefined) throw reason;

  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  throw error;
}
