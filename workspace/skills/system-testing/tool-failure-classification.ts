const ARGUMENT_REJECTION = /^Invalid arguments for tool\s+/i;
const SAFE_VCS_REJECTIONS = new Set([
  "ConflictPresent",
  "DependencyBlocked",
  "DestinationOccupied",
  "IntegrationIncomplete",
  "NoEffect",
  "RevisionChanged",
  "WorkingChangesPresent",
]);

/**
 * The harness rejects malformed tool arguments before invoking the tool. That
 * is a model/protocol correction, not a failed platform effect: no filesystem,
 * service, eval, or external operation began. Keep the rejected invocation in
 * diagnostics, but do not classify it with execution/infrastructure failures.
 */
export function isPreExecutionArgumentRejection(...values: unknown[]): boolean {
  return values.some((value) => typeof value === "string" && ARGUMENT_REJECTION.test(value));
}

/**
 * These typed VCS refusals are optimistic-concurrency or state preconditions.
 * The service guarantees that they perform no effect and the agent is expected
 * to re-observe and correct its request. Keep them in the trajectory, but do
 * not conflate a successful fail-closed guard with an infrastructure failure.
 */
export function isSafeVcsDomainRejection(
  toolName: string,
  terminalReasonCode: string | undefined
): boolean {
  return (
    (toolName === "vcs" || toolName === "commit") &&
    terminalReasonCode !== undefined &&
    SAFE_VCS_REJECTIONS.has(terminalReasonCode)
  );
}
