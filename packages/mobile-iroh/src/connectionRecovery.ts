const CONNECTION_LOSS_PATTERN =
  /connection lost|not connected to server|pipe down|ice (?:failed|closed|disconnected)|did not recover in time/iu;

export function isTransientConnectionError(error: unknown): boolean {
  const code =
    error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "";
  if (code === "CONNECTION_LOST" || code === "PIPE_CLOSED") return true;
  const message = error instanceof Error ? error.message : String(error);
  return CONNECTION_LOSS_PATTERN.test(message);
}

/**
 * Re-run an idempotent bootstrap operation after the existing authenticated
 * mobile session reconnects. Pairing has already completed at this point, so a
 * transient pipe loss must not send the user back to QR/manual pairing.
 */
export async function retryAfterConnectionLoss<T>(
  operation: () => Promise<T>,
  options: {
    timeoutMs: number;
    waitUntilConnected: (timeoutMs: number) => Promise<void>;
    reconnectWaitMs?: number;
    onRetry?: (error: unknown) => void;
    now?: () => number;
  }
): Promise<T> {
  const now = options.now ?? Date.now;
  const deadline = now() + Math.max(1, options.timeoutMs);
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientConnectionError(error) || now() >= deadline) throw error;
      options.onRetry?.(error);
      const remaining = Math.max(1, deadline - now());
      try {
        await options.waitUntilConnected(
          Math.min(remaining, Math.max(1, options.reconnectWaitMs ?? 30_000))
        );
      } catch (waitError) {
        if (!isTransientConnectionError(waitError) || now() >= deadline) throw waitError;
      }
    }
  }
}
