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
