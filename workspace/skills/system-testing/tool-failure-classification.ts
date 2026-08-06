const ARGUMENT_REJECTION = /(?:^|unknown_tool_failure:\s*)Invalid arguments for tool\s+/i;
const SAFE_VCS_REJECTIONS = new Set([
  "ConflictPresent",
  "CoupledGroupIncomplete",
  "DestinationOccupied",
  "IntegrationIncomplete",
  "InvalidReference",
  "NoEffect",
  "RevisionChanged",
  "WorkingChangesPresent",
  "BuildGateFailed",
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
 * Read-only discovery tools may reject a path after dispatch when the runtime
 * path policy has the authoritative workspace view. The typed failure proves
 * that no effect was attempted and directs the agent to correct its input.
 */
export function isReadOnlyInputRejection(toolName: string, ...values: unknown[]): boolean {
  if (!new Set(["read", "ls", "grep", "find", "glob", "stat"]).has(toolName)) return false;
  return values.some((value) => {
    let rendered: string;
    try {
      rendered = typeof value === "string" ? value : JSON.stringify(value);
    } catch {
      return false;
    }
    return (
      rendered.includes('"protocol":"agent-tool-failure.v1"') &&
      rendered.includes('"kind":"invalid-input"') &&
      rendered.includes('"policy":"correct-input"')
    );
  });
}

/**
 * These typed VCS refusals are optimistic-concurrency, reference, or state
 * preconditions. The service/tool adapter guarantees that they perform no
 * effect and the agent is expected to re-observe and correct its request. Keep
 * them in the trajectory, but do not conflate a successful fail-closed guard
 * with an infrastructure failure.
 */
export function isSafeVcsDomainRejection(
  toolName: string,
  terminalReasonCode: string | undefined
): boolean {
  return (
    toolName === "vcs" &&
    terminalReasonCode !== undefined &&
    SAFE_VCS_REJECTIONS.has(terminalReasonCode)
  );
}

/**
 * Provenance is a read-only typed-root lookup. An exact root that is stale,
 * malformed, or unreachable is refused before any effect; the agent should
 * copy a freshly observed root unchanged and retry.
 */
export function isSafeProvenanceDomainRejection(
  toolName: string,
  terminalReasonCode: string | undefined
): boolean {
  return toolName === "provenance" && terminalReasonCode === "InvalidReference";
}

/**
 * Static module resolution happens before any eval guest code executes. A
 * typed unavailable-module result is therefore a correctable, no-effect input
 * rejection, not an infrastructure failure.
 */
export function isSafeEvalDomainRejection(
  toolName: string,
  terminalReasonCode: string | undefined
): boolean {
  return toolName === "eval" && terminalReasonCode === "module_not_available";
}

/**
 * The eval runtime distinguishes a guest program failure from its own
 * infrastructure failing. Agentic development is expected to execute,
 * diagnose, edit, and rerun imperfect user code, so every eval failure
 * explicitly typed as `user-code` remains visible in diagnostics but is not a
 * failed platform effect. The failure code is evidence for diagnosis, not a
 * second allowlist that can drift as new guest-code errors are added. Untyped
 * eval errors and every infrastructure/cancellation failure remain
 * unexpected.
 */
export function isEvalGuestCodeFailure(
  toolName: string,
  terminalReasonCode: string | undefined,
  failureKind: string | undefined
): boolean {
  return (
    toolName === "eval" &&
    failureKind === "user-code" &&
    terminalReasonCode !== "module_not_available"
  );
}

const SAFE_SUBAGENT_CLOSE_REJECTIONS = new Set([
  "IntegrationIncomplete",
  "InvalidReference",
  "WorkingChangesPresent",
]);

/**
 * Subagent tools expose typed no-effect domain refusals. inspect_subagent
 * reports ambiguous references before reading anything. close_subagent checks
 * lifecycle preconditions before cancellation, context teardown, or
 * subscription removal. Keep both visible without treating the guard itself as
 * a platform execution failure.
 */
export function isSafeSubagentDomainRejection(
  toolName: string,
  terminalReasonCode: string | undefined
): boolean {
  if (toolName === "inspect_subagent" && terminalReasonCode === "InvalidReference") {
    return true;
  }
  return (
    toolName === "close_subagent" &&
    terminalReasonCode !== undefined &&
    SAFE_SUBAGENT_CLOSE_REJECTIONS.has(terminalReasonCode)
  );
}

export type BuiltInToolFailureClassification =
  | "argument-rejection"
  | "domain-rejection"
  | "guest-code-failure";

/**
 * A failed invocation can still be useful evidence without representing a
 * failed platform effect. `expected` is reserved for failures a test
 * deliberately induces; `diagnosticOnly` describes typed no-effect guards and
 * guest-code exceptions discovered while the agent is working.
 */
export interface ToolFailureDisposition {
  expected?: boolean;
  diagnosticOnly?: boolean;
  classification?: BuiltInToolFailureClassification;
}

/**
 * Keep this predicate shared by suite accounting, rerun selection, reports,
 * and diagnostics. A classification also makes older persisted trajectories
 * safe to read after `diagnosticOnly` was added to the summary shape.
 */
export function isUnexpectedToolFailure(failure: ToolFailureDisposition): boolean {
  return (
    failure.expected !== true &&
    failure.diagnosticOnly !== true &&
    failure.classification === undefined
  );
}

/**
 * One canonical classifier is shared by suite accounting and semantic
 * validators. This prevents a scenario from rejecting the same typed,
 * no-effect failure that the runner correctly keeps as diagnostic evidence.
 */
export function classifyBuiltInToolFailure(input: {
  name: string;
  terminalReasonCode?: string;
  failureCode?: string;
  failureKind?: string;
  error?: unknown;
  result?: unknown;
  description?: unknown;
}): BuiltInToolFailureClassification | null {
  if (isPreExecutionArgumentRejection(input.error, input.result, input.description)) {
    return "argument-rejection";
  }
  if (isReadOnlyInputRejection(input.name, input.error, input.result, input.description)) {
    return "argument-rejection";
  }
  if (
    isSafeVcsDomainRejection(input.name, input.terminalReasonCode ?? input.failureCode) ||
    isSafeProvenanceDomainRejection(input.name, input.terminalReasonCode ?? input.failureCode) ||
    isSafeEvalDomainRejection(input.name, input.terminalReasonCode ?? input.failureCode) ||
    isSafeSubagentDomainRejection(input.name, input.terminalReasonCode ?? input.failureCode)
  ) {
    return "domain-rejection";
  }
  if (
    isEvalGuestCodeFailure(
      input.name,
      input.terminalReasonCode ?? input.failureCode,
      input.failureKind
    )
  ) {
    return "guest-code-failure";
  }
  return null;
}
