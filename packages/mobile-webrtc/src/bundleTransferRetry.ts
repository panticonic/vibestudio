const RETRYABLE_TRANSFER_CODES = new Set([
  "CONNECTION_LOST",
  "bundle_append_failed",
  "bundle_finalize_failed",
  "BUNDLE_RANGE_INCOMPLETE",
]);

export function isRetryableBundleTransferError(error: unknown): boolean {
  const code =
    error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "";
  if (RETRYABLE_TRANSFER_CODES.has(code)) return true;

  const message = error instanceof Error ? error.message : String(error);
  return /connection lost|not connected to server|pipe down|ice failed|corrupt gzip|gzip trailer|zipexception|bundle integrity mismatch|artifact stream was empty/iu.test(
    message
  );
}

export async function retryBundleTransfer<T>(
  operation: () => Promise<T>,
  options: {
    attempts?: number;
    timeoutMs?: number;
    onRetry?: (error: unknown, nextAttempt: number) => void;
    wait?: () => Promise<void>;
  } = {}
): Promise<T> {
  const attempts = Math.max(
    1,
    Math.floor(options.attempts ?? (options.timeoutMs === undefined ? 3 : Number.POSITIVE_INFINITY))
  );
  const deadline =
    options.timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + options.timeoutMs;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || Date.now() >= deadline || !isRetryableBundleTransferError(error)) {
        throw error;
      }
      options.onRetry?.(error, attempt + 1);
      await options.wait?.();
    }
  }
}
