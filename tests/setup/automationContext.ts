const TRANSIENT_CONTEXT_REPLACEMENT_MESSAGES = [
  "execution context was destroyed",
  "cannot find context with specified id",
  "inspected target navigated",
] as const;

/**
 * Electron replaces the main automation context during bootstrap handoff. That
 * narrow race is retryable; service, authorization, and product errors are not.
 */
export function isAutomationContextReplacement(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return TRANSIENT_CONTEXT_REPLACEMENT_MESSAGES.some((fragment) => message.includes(fragment));
}

export interface IdempotentAutomationReadOptions {
  label: string;
  timeoutMs?: number;
  delayMs?: number;
}

function isTransientAutomationReadFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return isAutomationContextReplacement(error) || /Test API not available/i.test(message);
}

/**
 * Repeat a side-effect-free Electron observation across the narrow bootstrap
 * context handoff, within one wall-clock budget. This function may replay the
 * callback and therefore must never receive clicks, writes, approval decisions,
 * arbitrary scripts, or RPC mutations.
 */
export async function retryIdempotentAutomationRead<T>(
  read: () => Promise<T>,
  options: IdempotentAutomationReadOptions
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const delayMs = options.delayMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let lastTransient: unknown;

  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `[AutomationRead] Timed out after ${timeoutMs}ms while ${options.label}${
                    lastTransient
                      ? `; last transient failure: ${
                          lastTransient instanceof Error
                            ? lastTransient.message
                            : String(lastTransient)
                        }`
                      : ""
                  }`
                )
              ),
            remainingMs
          );
        }),
      ]);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("[AutomationRead] Timed out")) {
        throw error;
      }
      if (!isTransientAutomationReadFailure(error)) throw error;
      lastTransient = error;
    } finally {
      if (timer) clearTimeout(timer);
    }

    const remainingAfterRead = deadline - Date.now();
    if (remainingAfterRead <= 0) break;
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, remainingAfterRead)));
    }
  }

  throw new Error(
    `[AutomationRead] Timed out after ${timeoutMs}ms while ${options.label}${
      lastTransient
        ? `; last transient failure: ${
            lastTransient instanceof Error ? lastTransient.message : String(lastTransient)
          }`
        : ""
    }`
  );
}
