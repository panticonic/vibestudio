/**
 * Per-invocation narration of an extension call: requested, resolved, ready,
 * admitted, completed. A shell keystroke makes one such call, so at the default
 * level these seven lines per call would be written, captured and persisted on
 * every key; they exist to follow one call through a stall, which is a
 * verbose-level investigation. Failures are always reported at warn level by
 * their own paths.
 */
export function traceInvocation(message: string, details: Record<string, unknown>): void {
  const level = process.env["VIBESTUDIO_LOG_LEVEL"];
  if (level === "verbose" || level === "trace") console.debug(message, details);
}
