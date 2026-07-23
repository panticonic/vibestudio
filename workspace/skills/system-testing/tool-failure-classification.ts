const ARGUMENT_REJECTION = /^Invalid arguments for tool\s+/i;

/**
 * The harness rejects malformed tool arguments before invoking the tool. That
 * is a model/protocol correction, not a failed platform effect: no filesystem,
 * service, eval, or external operation began. Keep the rejected invocation in
 * diagnostics, but do not classify it with execution/infrastructure failures.
 */
export function isPreExecutionArgumentRejection(...values: unknown[]): boolean {
  return values.some((value) => typeof value === "string" && ARGUMENT_REJECTION.test(value));
}
