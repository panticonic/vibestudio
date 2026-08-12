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

/**
 * Repeat an Electron main-process evaluation only when its automation context
 * was replaced. Product, authorization, and assertion failures still surface
 * immediately.
 */
export async function retryAutomationContextReplacement<T>(
  evaluate: () => Promise<T>,
  options: { attempts?: number; delayMs?: number } = {}
): Promise<T> {
  const attempts = options.attempts ?? 10;
  const delayMs = options.delayMs ?? 100;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await evaluate();
    } catch (error) {
      if (!isAutomationContextReplacement(error)) throw error;
      lastError = error;
      if (attempt + 1 < attempts && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError;
}
