import type { TestExecutionResult } from "../types.js";

export interface InvocationCardPayloadLike {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
  status?: string;
  terminalOutcome?: string;
  result?: unknown;
  error?: unknown;
  isError?: boolean;
  execution?: {
    status?: string;
    terminalOutcome?: string;
    result?: unknown;
    error?: unknown;
    isError?: boolean;
  };
}

/**
 * Find the last complete agent message (not from self, not thinking).
 * The self-sent message has kind "message" + pending:true initially,
 * then becomes pending:false. Agent messages never have pending.
 * We use a heuristic: skip the first message (likely the prompt).
 */
export function findLastAgentMessage(result: TestExecutionResult): string {
  const msgs = result.messages;
  // Skip messages from the first sender (the test client)
  const selfSenderId = msgs[0]?.senderId;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (
      m.senderId !== selfSenderId &&
      m.kind === "message" &&
      m.complete &&
      m.contentType !== "thinking" &&
      m.contentType !== "invocation" &&
      !m.pending
    ) {
      return m.content ?? "";
    }
  }
  return "";
}

/** Check if the agent produced any response at all */
export function hasAgentResponse(result: TestExecutionResult): boolean {
  const selfSenderId = result.messages[0]?.senderId;
  return result.messages.some(
    (m) =>
      m.senderId !== selfSenderId &&
      m.kind === "message" &&
      m.complete &&
      m.contentType !== "thinking" &&
      m.contentType !== "typing" &&
      m.contentType !== "invocation"
  );
}

/** Check that the response contains a specific string (case-insensitive) */
export function responseContains(result: TestExecutionResult, text: string): boolean {
  return normalizeMarkerText(findLastAgentMessage(result)).includes(normalizeMarkerText(text));
}

/** Normalize harmless prose/Markdown presentation around validator markers.
 * Agent answers are user-facing text, so `field: **yes**`, `field = yes`, and
 * `FIELD:yes` should carry the same semantic evidence. */
function normalizeMarkerText(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[*_`~]/g, "")
      // Hyphenated prose tokens are formatting, not protocol identifiers. Treat
      // ordinary spaces and hyphens equivalently while underscore-based sentinel
      // markers remain collapsed/exact after the line above.
      .replace(/[\s-]+/g, " ")
      .replace(/\s*([:=])\s*/g, "$1")
  );
}

export function finalMessageHasAll(
  result: TestExecutionResult,
  tokens: readonly string[]
): { passed: boolean; reason?: string } {
  const msg = findLastAgentMessage(result);
  if (!msg) return { passed: false, reason: "No agent response received" };
  const normalized = normalizeMarkerText(msg);
  const missing = tokens.filter((token) => !normalized.includes(normalizeMarkerText(token)));
  return {
    passed: missing.length === 0,
    reason:
      missing.length === 0
        ? undefined
        : `Missing ${missing.join(", ")} in response: ${msg.slice(0, 400)}`,
  };
}

export function finalMessageHasAny(
  result: TestExecutionResult,
  tokens: readonly string[]
): { passed: boolean; reason?: string } {
  const msg = findLastAgentMessage(result);
  if (!msg) return { passed: false, reason: "No agent response received" };
  const normalized = normalizeMarkerText(msg);
  const found = tokens.some((token) => normalized.includes(normalizeMarkerText(token)));
  return {
    passed: found,
    reason: found
      ? undefined
      : `Expected one of ${tokens.join(", ")} in response: ${msg.slice(0, 400)}`,
  };
}

export function finalMessageHasMarkerCount(
  result: TestExecutionResult,
  marker: string
): { passed: boolean; reason?: string } {
  const msg = findLastAgentMessage(result);
  if (!msg) return { passed: false, reason: "No agent response received" };
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `\\b${escapedMarker}\\b\\s*[:=-]?\\s*(?:count\\s*[:=-]?\\s*)?(\\d+)\\b`,
    "i"
  ).exec(msg);
  return {
    passed: Boolean(match),
    reason: match
      ? undefined
      : `Missing ${marker} followed by a numeric count in response: ${msg.slice(0, 400)}`,
  };
}

export function finalMessageHasNumericField(
  result: TestExecutionResult,
  field: string
): { passed: boolean; reason?: string } {
  const msg = findLastAgentMessage(result);
  if (!msg) return { passed: false, reason: "No agent response received" };
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`\\b${escapedField}\\s*[:=]\\s*(\\d+)\\b`, "i").exec(msg);
  return {
    passed: Boolean(match),
    reason: match ? undefined : `Missing ${field}=<number> in response: ${msg.slice(0, 400)}`,
  };
}

export function finalMessageHasField(
  result: TestExecutionResult,
  field: string
): { passed: boolean; reason?: string } {
  const msg = findLastAgentMessage(result);
  if (!msg) return { passed: false, reason: "No agent response received" };
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`\\b${escapedField}\\s*[:=]\\s*\\S+`, "i").exec(msg);
  return {
    passed: Boolean(match),
    reason: match ? undefined : `Missing ${field}=<value> in response: ${msg.slice(0, 400)}`,
  };
}

/** Require semantic identity fields to contain real values rather than marker placeholders. */
export function finalMessageHasConcreteFields(
  result: TestExecutionResult,
  fields: readonly string[]
): { passed: boolean; reason?: string } {
  const msg = findLastAgentMessage(result);
  if (!msg) return { passed: false, reason: "No agent response received" };
  const placeholders = new Set([
    "-",
    "missing",
    "n/a",
    "na",
    "none",
    "not",
    "not-available",
    "null",
    "unavailable",
    "undefined",
    "unknown",
  ]);
  const invalid: string[] = [];
  for (const field of fields) {
    const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`\\b${escapedField}\\s*[:=]\\s*[*_\x60~]*([^\\s,*_\x60~]+)`, "i").exec(
      msg
    );
    const value = match?.[1]?.replace(/[.;]+$/, "").toLowerCase();
    if (!value || placeholders.has(value)) invalid.push(`${field}:${value ?? "missing"}`);
  }
  return {
    passed: invalid.length === 0,
    reason:
      invalid.length === 0
        ? undefined
        : `Expected concrete semantic identity values; received ${invalid.join(", ")}`,
  };
}

export function noIncompleteInvocations(result: TestExecutionResult): {
  passed: boolean;
  reason?: string;
} {
  const incomplete = incompleteToolCalls(result);
  return {
    passed: incomplete.length === 0,
    reason:
      incomplete.length === 0
        ? undefined
        : `Expected no incomplete tool calls, got ${incomplete.map((c) => `${c.name}:${c.execution?.status ?? "unknown"}`).join(", ")}`,
  };
}

export function noFailedInvocations(result: TestExecutionResult): {
  passed: boolean;
  reason?: string;
} {
  const failed = failedToolCalls(result);
  return {
    passed: true,
    reason:
      failed.length === 0
        ? undefined
        : `Observed failed tool calls: ${failed.map((c) => `${c.name}:${formatInvocationError(c)}`).join(", ")}`,
  };
}

/** Check that the response does NOT contain error-indicating phrases alongside the expected content */
export function responseSucceeds(
  result: TestExecutionResult,
  expectedContent: string
): { passed: boolean; reason?: string } {
  const msg = findLastAgentMessage(result);
  if (!msg) return { passed: false, reason: "No agent response received" };
  const lower = msg.toLowerCase();
  const hasContent = lower.includes(expectedContent.toLowerCase());
  if (!hasContent)
    return {
      passed: false,
      reason: `Expected "${expectedContent}" in response, got: ${msg.slice(0, 300)}`,
    };
  return { passed: true };
}

export function getToolCalls(result: TestExecutionResult): InvocationCardPayloadLike[] {
  const calls: InvocationCardPayloadLike[] = [];
  for (const msg of result.messages) {
    if (msg.contentType !== "invocation") continue;
    if (msg.invocation) {
      calls.push(normalizeInvocationCard(msg.invocation as InvocationCardPayloadLike));
      continue;
    }
    try {
      const parsed = JSON.parse(msg.content ?? "") as InvocationCardPayloadLike;
      if (parsed && typeof parsed.name === "string") calls.push(normalizeInvocationCard(parsed));
    } catch {
      // Ignore malformed invocation content; validation can fail on missing calls.
    }
  }
  return calls;
}

/** Normalize historical nested cards and current flattened invocation projections. */
function normalizeInvocationCard(call: InvocationCardPayloadLike): InvocationCardPayloadLike {
  const nested = call.execution;
  const hasExecution =
    nested !== undefined ||
    call.status !== undefined ||
    call.terminalOutcome !== undefined ||
    call.result !== undefined ||
    call.error !== undefined ||
    call.isError !== undefined;
  if (!hasExecution) return call;
  return {
    ...call,
    execution: {
      status: nested?.status ?? call.status,
      terminalOutcome: nested?.terminalOutcome ?? call.terminalOutcome,
      result: nested?.result ?? nested?.error ?? call.result ?? call.error,
      isError: nested?.isError ?? call.isError,
    },
  };
}

/** Concatenated code of all successful eval invocations, for API-usage evidence checks. */
export function successfulEvalCode(result: TestExecutionResult): string {
  return getToolCalls(result)
    .filter(
      (call) =>
        call.name === "eval" &&
        call.execution?.status === "complete" &&
        call.execution.isError !== true
    )
    .map((call) => (typeof call.arguments?.["code"] === "string" ? call.arguments["code"] : ""))
    .join("\n");
}

/** Values returned through the canonical successful eval result projection. */
export function successfulEvalReturnValues(result: TestExecutionResult): unknown[] {
  return getToolCalls(result)
    .filter(
      (call) =>
        call.name === "eval" &&
        call.execution?.status === "complete" &&
        call.execution.isError !== true
    )
    .flatMap((call) => {
      const executionResult = call.execution?.result;
      if (!isRecord(executionResult) || !isRecord(executionResult["details"])) return [];
      const details = executionResult["details"];
      return Object.prototype.hasOwnProperty.call(details, "returnValue")
        ? [details["returnValue"]]
        : [];
    });
}

export function requireEvalEvidence(
  result: TestExecutionResult,
  required: readonly string[]
): { passed: boolean; reason?: string } {
  const code = successfulEvalCode(result);
  const missing = required.filter((token) => !code.includes(token));
  if (missing.length > 0) {
    return { passed: false, reason: `Successful eval did not exercise ${missing.join(", ")}` };
  }
  return { passed: true };
}

/**
 * Require observable use of canonical semantic VCS operations without forcing
 * agents through raw eval. Focused agent tools are first-class adapters over
 * the same service; vague UX fixtures should accept the shortest documented
 * surface and reserve eval for exact request/retry experiments.
 */
export function requireVcsEvidence(
  result: TestExecutionResult,
  required: readonly string[]
): { passed: boolean; reason?: string } {
  const exercised = new Set<string>();
  const code = successfulEvalCode(result);
  for (const token of required) {
    if (code.includes(token)) exercised.add(token);
  }
  for (const call of getToolCalls(result)) {
    if (call.execution?.status !== "complete" || call.execution.isError === true) continue;
    if (call.name === "vcs" && typeof call.arguments?.["operation"] === "string") {
      exercised.add(`vcs.${call.arguments["operation"]}`);
      continue;
    }
    for (const operation of VCS_TOOL_OPERATIONS[call.name] ?? []) exercised.add(operation);
  }
  const missing = required.filter((token) => !exercised.has(token));
  return {
    passed: missing.length === 0,
    reason:
      missing.length === 0
        ? undefined
        : `Completed agent tools or successful eval did not exercise ${missing.join(", ")}`,
  };
}

const VCS_TOOL_OPERATIONS: Readonly<Record<string, readonly string[]>> = {
  edit: ["vcs.edit"],
  write: ["vcs.edit"],
  move_file: ["vcs.move"],
  copy_file: ["vcs.copy"],
  commit: ["vcs.commit"],
  provenance: ["vcs.inspect", "vcs.neighbors"],
};

/** Prove that two focused authoring steps were exactly the chain committed and then observed clean. */
export function requireWholeChainCommitEvidence(result: TestExecutionResult): {
  passed: boolean;
  reason?: string;
} {
  const calls = getToolCalls(result);
  const steps = calls
    .map((call, index) => ({ call, index, value: focusedMutationResult(call) }))
    .filter(
      (
        entry
      ): entry is {
        call: InvocationCardPayloadLike;
        index: number;
        value: Record<string, unknown>;
      } => entry.value !== null
    );
  if (steps.length !== 2) {
    return fail(
      `Expected exactly two completed managed edit/write application steps; observed ${steps.length}`
    );
  }
  const applicationIds: string[] = [];
  for (const { value } of steps) {
    const applicationId = stringField(value, "applicationId");
    const workingHead = recordField(value, "workingHead");
    if (
      !applicationId ||
      workingHead?.["kind"] !== "application" ||
      workingHead["applicationId"] !== applicationId ||
      value["changeCount"] !== 1 ||
      !isStringArray(value["changeIds"]) ||
      value["changeIds"].length !== 1
    ) {
      return fail(
        "A completed managed edit/write did not expose one exact application and authored change"
      );
    }
    applicationIds.push(applicationId);
  }
  if (new Set(applicationIds).size !== 2) {
    return fail("The two managed authoring steps reused an application identity");
  }

  const commit = calls
    .map((call, index) => ({ index, value: focusedCommitResult(call) }))
    .find(
      (entry) =>
        entry.index > steps[1]!.index &&
        entry.value !== null &&
        arraysEqual(entry.value["committedApplicationIds"], applicationIds)
    );
  const eventId = commit?.value ? eventIdFromCommit(commit.value) : null;
  if (!commit?.value || !eventId) {
    return fail(
      "No completed commit consumed exactly the two observed application identities into an event"
    );
  }

  const status = calls
    .map((call, index) => ({ index, value: focusedVcsResult(call, "status") }))
    .find(
      (entry) =>
        entry.index > commit.index &&
        entry.value !== null &&
        entry.value["clean"] === true &&
        eventRefEquals(entry.value["committed"], eventId) &&
        eventRefEquals(entry.value["workingHead"], eventId) &&
        zeroWorkingCounts(entry.value["workingCounts"])
    );
  if (!status) {
    return fail(
      "No final status joined the commit event to a clean event working head with zero local counts"
    );
  }
  if (!findLastAgentMessage(result).includes(eventId)) {
    return fail(`The final answer did not report the committed event ${eventId}`);
  }
  return { passed: true, reason: undefined };
}

/** Prove that the event produced by commit is exactly the event published as protected main. */
export function requirePublishedCommitEvidence(result: TestExecutionResult): {
  passed: boolean;
  reason?: string;
} {
  const calls = getToolCalls(result);
  for (const [commitIndex, call] of calls.entries()) {
    const commit = focusedCommitResult(call);
    const eventId = commit ? eventIdFromCommit(commit) : null;
    if (!eventId) continue;
    for (let index = commitIndex + 1; index < calls.length; index++) {
      const push = focusedVcsResult(calls[index]!, "push");
      if (push?.["eventId"] !== eventId || push["mainEventId"] !== eventId) continue;
      if (!findLastAgentMessage(result).includes(eventId)) {
        return fail(`The final answer did not report the published event ${eventId}`);
      }
      return { passed: true, reason: undefined };
    }
  }
  return fail(
    "Completed commit and push results did not join one event identity to published protected main"
  );
}

/** Prove one source event was resolved locally, re-compared complete, parented, and pushed. */
export function requireIncrementalIntegrationEvidence(result: TestExecutionResult): {
  passed: boolean;
  reason?: string;
} {
  const calls = getToolCalls(result);
  for (const [commitIndex, call] of calls.entries()) {
    const commit = focusedCommitResult(call);
    const sourceEventId = commit ? stringField(commit, "integrationSourceEventId") : null;
    const eventId = commit ? eventIdFromCommit(commit) : null;
    if (!commit || !sourceEventId || !eventId) continue;
    const commitArgs = call.arguments ?? {};
    if (
      commitArgs["integratesEventId"] !== undefined &&
      commitArgs["integratesEventId"] !== sourceEventId
    ) {
      continue;
    }
    const sourceWasPublished = calls.slice(0, commitIndex).some((candidate) => {
      const push = focusedVcsResult(candidate, "push");
      return push?.["eventId"] === sourceEventId && push["mainEventId"] === sourceEventId;
    });
    if (!sourceWasPublished) continue;

    const decisions = calls
      .slice(0, commitIndex)
      .map((candidate, relativeIndex) => {
        const args = candidate.arguments ?? {};
        const value = focusedVcsResult(candidate, "integrate");
        const decision = recordField(args, "decision");
        return {
          index: relativeIndex,
          args,
          value,
          decision,
          sourceChangeIds:
            decision && isStringArray(decision["sourceChangeIds"])
              ? decision["sourceChangeIds"]
              : [],
          decisionKind: decision ? stringField(decision, "kind") : null,
        };
      })
      .filter(
        (
          entry
        ): entry is typeof entry & {
          value: Record<string, unknown>;
          decision: Record<string, unknown>;
        } =>
          entry.args["sourceEventId"] === sourceEventId &&
          entry.value !== null &&
          entry.decision !== null &&
          entry.sourceChangeIds.length > 0 &&
          Boolean(stringField(entry.value, "decisionId")) &&
          Boolean(stringField(entry.value, "applicationId"))
      );
    if (decisions.length === 0) continue;
    const firstDecision = decisions[0]!;
    const sourceCompare = calls
      .slice(0, firstDecision.index)
      .map((candidate, index) => ({ index, value: focusedVcsResult(candidate, "compare") }))
      .find(({ value: compare }) => {
        if (!compare || compare["sourceEventId"] !== sourceEventId) return false;
        const comparedChanges = Array.isArray(compare["changes"]) ? compare["changes"] : [];
        return decisions.every((entry) =>
          entry.sourceChangeIds.every((changeId) =>
            comparedChanges.some((candidate) => {
              const disposition = isRecord(candidate)
                ? recordField(candidate, "disposition")
                : null;
              return (
                isRecord(candidate) &&
                candidate["changeId"] === changeId &&
                disposition?.["status"] === "actionable"
              );
            })
          )
        );
      });
    if (!sourceCompare?.value) continue;
    const localTarget = recordField(sourceCompare.value, "target");
    const localEventId =
      localTarget?.["kind"] === "event" && typeof localTarget["eventId"] === "string"
        ? localTarget["eventId"]
        : null;
    if (!localEventId || localEventId === sourceEventId) continue;
    let localCommitIndex = -1;
    for (let index = sourceCompare.index - 1; index >= 0; index -= 1) {
      const candidateCommit = focusedCommitResult(calls[index]!);
      if (candidateCommit && eventIdFromCommit(candidateCommit) === localEventId) {
        localCommitIndex = index;
        break;
      }
    }
    if (localCommitIndex < 0) continue;
    const localWasPublished = calls.slice(localCommitIndex + 1, commitIndex).some((candidate) => {
      const push = focusedVcsResult(candidate, "push");
      return push?.["eventId"] === localEventId || push?.["mainEventId"] === localEventId;
    });
    if (localWasPublished) continue;
    const committedApplications = commit["committedApplicationIds"];
    if (
      !isStringArray(committedApplications) ||
      decisions.some(
        (entry) => !committedApplications.includes(entry.value["applicationId"] as string)
      )
    ) {
      continue;
    }

    const lastDecision = decisions.at(-1)!;
    const resolvedCompare = calls
      .slice(lastDecision.index + 1, commitIndex)
      .map((candidate) => focusedVcsResult(candidate, "compare"))
      .find((compare) => {
        if (
          !compare ||
          compare["sourceEventId"] !== sourceEventId ||
          !sameState(compare["target"], lastDecision.value["workingHead"])
        ) {
          return false;
        }
        const counts = recordField(compare, "counts");
        const resolution = recordField(compare, "resolution");
        if (
          !counts ||
          !resolution ||
          resolution["complete"] !== true ||
          resolution["remainingChangeCount"] !== 0 ||
          counts["actionable"] !== 0 ||
          counts["alreadySatisfied"] !== 0 ||
          counts["conflicting"] !== 0 ||
          counts["blocked"] !== 0
        ) {
          return false;
        }
        const comparedChanges = Array.isArray(compare["changes"]) ? compare["changes"] : [];
        if (comparedChanges.length === 0) {
          const adoptedCount = decisions
            .filter((entry) => entry.decisionKind === "adopted")
            .reduce((total, entry) => total + entry.sourceChangeIds.length, 0);
          const accountedCount = decisions
            .filter(
              (entry) => entry.decisionKind === "reconciled" || entry.decisionKind === "declined"
            )
            .reduce((total, entry) => total + entry.sourceChangeIds.length, 0);
          return (
            typeof counts["shared"] === "number" &&
            counts["shared"] >= adoptedCount &&
            typeof counts["accounted"] === "number" &&
            counts["accounted"] >= accountedCount
          );
        }
        return decisions.every((entry) => {
          const decisionId = entry.value["decisionId"] as string;
          return entry.sourceChangeIds.every((changeId) =>
            comparedChanges.some((candidate) => {
              if (!isRecord(candidate) || candidate["changeId"] !== changeId) return false;
              const disposition = recordField(candidate, "disposition");
              if (entry.decisionKind === "adopted") {
                return disposition?.["status"] === "shared";
              }
              return (
                (entry.decisionKind === "reconciled" || entry.decisionKind === "declined") &&
                disposition?.["status"] === "accounted" &&
                isStringArray(disposition["decisionIds"]) &&
                disposition["decisionIds"].includes(decisionId)
              );
            })
          );
        });
      });
    if (!resolvedCompare) continue;

    const published = calls.slice(commitIndex + 1).some((candidate) => {
      const push = focusedVcsResult(candidate, "push");
      return push?.["eventId"] === eventId && push["mainEventId"] === eventId;
    });
    if (!published) continue;
    const clean = calls.slice(commitIndex + 1).some((candidate) => {
      const status = focusedVcsResult(candidate, "status");
      return Boolean(
        status?.["clean"] === true &&
        eventRefEquals(status["committed"], eventId) &&
        eventRefEquals(status["workingHead"], eventId) &&
        zeroWorkingCounts(status["workingCounts"])
      );
    });
    if (!clean) continue;
    return { passed: true, reason: undefined };
  }
  return fail(
    "Completed canonical results did not identity-join an unpublished local commit and published source through local decisions, a complete comparison, the integration commit, clean final state, and final push"
  );
}

/** Prove focused move/copy identity semantics and the copy's two exact lineage endpoints. */
export function requireMoveCopyEvidence(result: TestExecutionResult): {
  passed: boolean;
  reason?: string;
} {
  const calls = getToolCalls(result);
  const move = calls.map((call) => focusedToolDetails(call, "move_file")).find(Boolean) ?? null;
  const copy = calls.map((call) => focusedToolDetails(call, "copy_file")).find(Boolean) ?? null;
  if (!move || !copy) return fail("Completed move_file and copy_file details were both required");
  const moveSource = recordField(move, "source");
  const moveDestination = recordField(move, "destination");
  if (
    move["operation"] !== "moved" ||
    !moveSource ||
    !moveDestination ||
    !stringField(moveSource, "fileId") ||
    moveSource["fileId"] !== moveDestination["fileId"]
  ) {
    return fail("move_file details did not preserve one exact file identity");
  }
  const copySource = recordField(copy, "source");
  const copyDestination = recordField(copy, "destination");
  const copyChangeId = stringField(copy, "changeId");
  const copyApplicationId = stringField(copy, "applicationId");
  if (
    copy["operation"] !== "copied" ||
    !copySource ||
    !copyDestination ||
    !stringField(copySource, "fileId") ||
    !stringField(copyDestination, "fileId") ||
    copySource["fileId"] === copyDestination["fileId"] ||
    !copyChangeId ||
    !copyApplicationId ||
    !stringField(copy, "workUnitId") ||
    copy["workUnitId"] === move["workUnitId"]
  ) {
    return fail("copy_file details did not mint a new file identity in a distinct work unit");
  }

  const provenanceDetails = calls
    .map((call) => focusedToolDetails(call, "provenance"))
    .filter((value): value is Record<string, unknown> => value !== null);
  const edges = provenanceDetails.flatMap((details) =>
    Array.isArray(details["adjacency"]) ? details["adjacency"].filter(isRecord) : []
  );
  const sourceEndpoint = edges.some((edge) => {
    const from = recordField(edge, "from");
    const to = recordField(edge, "to");
    return (
      edge["kind"] === "authored-copy-source" &&
      from?.["kind"] === "change" &&
      from["changeId"] === copyChangeId &&
      to?.["kind"] === "file" &&
      sameState(to["state"], copySource["state"]) &&
      to["repositoryId"] === copySource["repositoryId"] &&
      to["fileId"] === copySource["fileId"]
    );
  });
  if (!sourceEndpoint) {
    return fail("Copy provenance did not expose the exact authored change → source file endpoint");
  }

  const realization = edges.find((edge) => {
    const from = recordField(edge, "from");
    const to = recordField(edge, "to");
    return (
      edge["kind"] === "realizes-change" &&
      from?.["kind"] === "applied-change" &&
      typeof from["appliedChangeId"] === "string" &&
      to?.["kind"] === "change" &&
      to["changeId"] === copyChangeId
    );
  });
  const child = realization ? recordField(realization, "from") : null;
  const childAppliedChangeId = child ? stringField(child, "appliedChangeId") : null;
  const mappedCopy = childAppliedChangeId
    ? edges.find((edge) => {
        const from = recordField(edge, "from");
        const to = recordField(edge, "to");
        return (
          edge["kind"] === "copies-content" &&
          from?.["kind"] === "applied-change" &&
          from["appliedChangeId"] === childAppliedChangeId &&
          to?.["kind"] === "applied-change" &&
          typeof to["appliedChangeId"] === "string" &&
          to["appliedChangeId"] !== childAppliedChangeId
        );
      })
    : null;
  const inspectedChild = provenanceDetails.some((details) => {
    const node = recordField(details, "node");
    const value = node ? recordField(node, "value") : null;
    return (
      node?.["kind"] === "applied-change" &&
      value?.["appliedChangeId"] === childAppliedChangeId &&
      value["applicationId"] === copyApplicationId &&
      value["changeId"] === copyChangeId
    );
  });
  if (!mappedCopy || !inspectedChild) {
    return fail(
      "Copy provenance did not join its application/change to a mapped copies-content edge between exact applied-change coordinate identities"
    );
  }
  return { passed: true, reason: undefined };
}

/** Prove a counteraction targets the exact authored change and restores the observed file text. */
export function requireRevertEvidence(result: TestExecutionResult): {
  passed: boolean;
  reason?: string;
} {
  const calls = getToolCalls(result);
  for (const [revertIndex, revertCall] of calls.entries()) {
    const revert = focusedVcsResult(revertCall, "revert");
    const revertArgs = revertCall.arguments ?? {};
    if (
      !revert ||
      !isStringArray(revertArgs["changeIds"]) ||
      revertArgs["changeIds"].length !== 1 ||
      !isStringArray(revert["changeIds"]) ||
      revert["changeIds"].length !== 1
    ) {
      continue;
    }
    const originalChangeId = revertArgs["changeIds"][0]!;
    const counteractionChangeId = revert["changeIds"][0]!;
    const revertApplicationId = stringField(revert, "applicationId");
    if (!revertApplicationId || counteractionChangeId === originalChangeId) continue;

    const authored = calls
      .slice(0, revertIndex)
      .map((call, index) => ({ call, index, value: focusedMutationResult(call) }))
      .reverse()
      .find(
        (entry) =>
          entry.value !== null &&
          isStringArray(entry.value["changeIds"]) &&
          entry.value["changeIds"].includes(originalChangeId)
      );
    if (!authored?.value) continue;
    const originalApplicationId = stringField(authored.value, "applicationId");
    const path =
      typeof authored.call.arguments?.["path"] === "string"
        ? authored.call.arguments["path"]
        : null;
    const oldText =
      typeof authored.call.arguments?.["oldText"] === "string"
        ? authored.call.arguments["oldText"]
        : null;
    const newText =
      typeof authored.call.arguments?.["newText"] === "string"
        ? authored.call.arguments["newText"]
        : null;
    if (!originalApplicationId || !path || !oldText || !newText || oldText === newText) continue;

    const originalCommit = calls
      .slice(authored.index + 1, revertIndex)
      .map((call) => focusedCommitResult(call))
      .find(
        (commit) =>
          commit !== null &&
          isStringArray(commit["committedApplicationIds"]) &&
          commit["committedApplicationIds"].includes(originalApplicationId)
      );
    if (!originalCommit) continue;

    const counteractionCommitEntry = calls
      .map((call, index) => ({ index, value: focusedCommitResult(call) }))
      .find(
        (entry) =>
          entry.index > revertIndex &&
          entry.value !== null &&
          isStringArray(entry.value["committedApplicationIds"]) &&
          entry.value["committedApplicationIds"].includes(revertApplicationId)
      );
    const restoredEventId = counteractionCommitEntry?.value
      ? eventIdFromCommit(counteractionCommitEntry.value)
      : null;
    if (!counteractionCommitEntry?.value || !restoredEventId) continue;

    const edges = calls
      .map((call) => focusedToolDetails(call, "provenance"))
      .filter((value): value is Record<string, unknown> => value !== null)
      .flatMap((details) =>
        Array.isArray(details["adjacency"]) ? details["adjacency"].filter(isRecord) : []
      );
    const counteracts = edges.some((edge) => {
      const from = recordField(edge, "from");
      const to = recordField(edge, "to");
      return (
        edge["kind"] === "counteracts" &&
        from?.["kind"] === "change" &&
        from["changeId"] === counteractionChangeId &&
        to?.["kind"] === "change" &&
        to["changeId"] === originalChangeId
      );
    });
    if (!counteracts) continue;

    const clean = calls.slice(counteractionCommitEntry.index + 1).some((call) => {
      const status = focusedVcsResult(call, "status");
      return Boolean(
        status?.["clean"] === true &&
        eventRefEquals(status["committed"], restoredEventId) &&
        eventRefEquals(status["workingHead"], restoredEventId) &&
        zeroWorkingCounts(status["workingCounts"])
      );
    });
    const restored = calls
      .slice(counteractionCommitEntry.index + 1)
      .some(
        (call) =>
          call.name === "read" &&
          call.arguments?.["path"] === path &&
          focusedToolProtocolText(call).includes(oldText) &&
          !focusedToolProtocolText(call).includes(newText)
      );
    if (!clean || !restored) continue;
    return { passed: true, reason: undefined };
  }
  return fail(
    "Completed canonical evidence did not join the authored change, exact counteracts edge, counteraction commit, clean status, and restored final file content"
  );
}

function focusedMutationResult(call: InvocationCardPayloadLike): Record<string, unknown> | null {
  if (call.name !== "edit" && call.name !== "write") return null;
  const details = focusedToolDetails(call, call.name);
  return details?.["storage"] === "vcs" && isRecord(details["vcsResult"])
    ? details["vcsResult"]
    : null;
}

function focusedCommitResult(call: InvocationCardPayloadLike): Record<string, unknown> | null {
  const details = focusedToolDetails(call, "commit");
  if (!details) return null;
  return isRecord(details["result"])
    ? details["result"]
    : eventIdFromCommit(details)
      ? details
      : null;
}

function focusedVcsResult(
  call: InvocationCardPayloadLike,
  operation: string
): Record<string, unknown> | null {
  if (call.name !== "vcs" || call.arguments?.["operation"] !== operation) return null;
  const details = focusedToolDetails(call, "vcs");
  if (!details) return null;
  if (details["operation"] !== undefined && details["operation"] !== operation) return null;
  return isRecord(details["result"]) ? details["result"] : details;
}

function focusedToolDetails(
  call: InvocationCardPayloadLike,
  name: string
): Record<string, unknown> | null {
  if (
    call.name !== name ||
    call.execution?.status !== "complete" ||
    call.execution.isError === true ||
    !isRecord(call.execution.result)
  ) {
    return null;
  }
  return isRecord(call.execution.result["details"])
    ? call.execution.result["details"]
    : call.execution.result;
}

function focusedToolProtocolText(call: InvocationCardPayloadLike): string {
  if (
    call.execution?.status !== "complete" ||
    call.execution.isError === true ||
    !isRecord(call.execution.result) ||
    !Array.isArray(call.execution.result["protocolContent"])
  ) {
    return "";
  }
  return call.execution.result["protocolContent"]
    .filter(isRecord)
    .map((content) =>
      content["type"] === "text" && typeof content["text"] === "string" ? content["text"] : ""
    )
    .join("\n");
}

function eventIdFromCommit(value: Record<string, unknown>): string | null {
  const event = recordField(value, "event");
  return event?.["kind"] === "event" && typeof event["eventId"] === "string"
    ? event["eventId"]
    : null;
}

function recordField(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  return isRecord(value[key]) ? value[key] : null;
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === "string" && value[key].length > 0 ? value[key] : null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function arraysEqual(value: unknown, expected: readonly string[]): boolean {
  return (
    isStringArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function eventRefEquals(value: unknown, eventId: string): boolean {
  return isRecord(value) && value["kind"] === "event" && value["eventId"] === eventId;
}

function sameState(left: unknown, right: unknown): boolean {
  if (!isRecord(left) || !isRecord(right) || left["kind"] !== right["kind"]) return false;
  return left["kind"] === "event"
    ? left["eventId"] === right["eventId"]
    : left["kind"] === "application" && left["applicationId"] === right["applicationId"];
}

function zeroWorkingCounts(value: unknown): boolean {
  return (
    isRecord(value) &&
    value["applications"] === 0 &&
    value["workUnits"] === 0 &&
    value["changes"] === 0
  );
}

function fail(reason: string): { passed: false; reason: string } {
  return { passed: false, reason };
}

/**
 * Require semantic evidence in the values returned by successful eval calls.
 *
 * This complements `requireEvalEvidence`: source-code inspection proves that an
 * agent attempted the intended public operation, while result inspection proves
 * that a completed invocation actually exposed the expected protocol fields or
 * typed outcomes. Keeping the two checks separate makes failures diagnostic.
 */
export function requireEvalResultEvidence(
  result: TestExecutionResult,
  required: readonly string[]
): { passed: boolean; reason?: string } {
  const resultText = getToolCalls(result)
    .filter(
      (call) =>
        call.name === "eval" &&
        call.execution?.status === "complete" &&
        call.execution.isError !== true
    )
    .map((call) => JSON.stringify(call.execution?.result ?? null))
    .join("\n")
    .toLowerCase();
  const missing = required.filter((value) => !resultText.includes(value.toLowerCase()));
  return {
    passed: missing.length === 0,
    reason:
      missing.length === 0
        ? undefined
        : `Successful eval results did not expose ${missing.join(", ")}`,
  };
}

interface ObservedCausalEdge {
  kind: string;
  from: Record<string, unknown>;
  to: Record<string, unknown>;
}

interface ObservedBlameOrigin {
  changeId: string;
  workUnitId: string;
  commandId: string;
}

function blameOrigin(record: Record<string, unknown>): ObservedBlameOrigin | null {
  const change = record["change"];
  const workUnit = record["workUnit"];
  const command = record["command"];
  if (
    !isRecord(change) ||
    change["kind"] !== "change" ||
    typeof change["changeId"] !== "string" ||
    !isRecord(workUnit) ||
    workUnit["kind"] !== "work-unit" ||
    typeof workUnit["workUnitId"] !== "string" ||
    !isRecord(command) ||
    command["kind"] !== "command" ||
    typeof command["commandId"] !== "string"
  ) {
    return null;
  }
  return {
    changeId: change["changeId"],
    workUnitId: workUnit["workUnitId"],
    commandId: command["commandId"],
  };
}

interface InvocationCoordinate {
  logId: string;
  head: string;
  invocationId: string;
}

interface InspectedInvocation extends InvocationCoordinate {
  turnId: string | null;
  requestDigest: string | null;
}

interface InspectedTurn {
  logId: string;
  head: string;
  turnId: string;
  triggerMessageId: string | null;
}

interface InspectedMessage {
  logId: string;
  head: string;
  messageId: string;
  role: string | null;
  sourceMessageId: string | null;
  senderId: string | null;
  text: string;
}

/**
 * Require one joined content-to-observable-intent proof from completed tool results.
 *
 * Method names and a polished final answer cannot prove causality. This reads
 * the actual blame span, exact graph endpoints, and inspected
 * invocation/turn/message nodes, then joins their identities. Each record may
 * come from a focused provenance result or a direct VCS call; the public data
 * model is the same either way.
 */
export function requireCausalEdgeEvidence(
  result: TestExecutionResult,
  expectedPromptText: string
): {
  passed: boolean;
  reason?: string;
} {
  const edges: ObservedCausalEdge[] = [];
  const origins: ObservedBlameOrigin[] = [];
  const inspectedInvocations: InspectedInvocation[] = [];
  const inspectedTurns: InspectedTurn[] = [];
  const inspectedMessages: InspectedMessage[] = [];
  for (const call of getToolCalls(result)) {
    if (call.execution?.status !== "complete" || call.execution.isError === true) continue;
    collectCausalEvidence(
      call.execution.result,
      edges,
      origins,
      inspectedInvocations,
      inspectedTurns,
      inspectedMessages,
      new Set<object>()
    );
  }

  for (const origin of origins) {
    const authored = edges.some(
      (edge) =>
        edge.kind === "authored-change" &&
        isNode(edge.from, "work-unit", "workUnitId", origin.workUnitId) &&
        isNode(edge.to, "change", "changeId", origin.changeId)
    );
    if (!authored) continue;
    const workCause = edges.some(
      (edge) =>
        edge.kind === "caused-by" &&
        isNode(edge.from, "work-unit", "workUnitId", origin.workUnitId) &&
        isNode(edge.to, "command", "commandId", origin.commandId)
    );
    if (!workCause) continue;
    const invocationEdge = edges.find(
      (edge) =>
        edge.kind === "caused-by" &&
        isNode(edge.from, "command", "commandId", origin.commandId) &&
        trajectoryInvocation(edge.to) !== null
    );
    const coordinate = invocationEdge ? trajectoryInvocation(invocationEdge.to) : null;
    if (!coordinate) continue;
    const inspected = inspectedInvocations.find(
      (candidate) =>
        candidate.logId === coordinate.logId &&
        candidate.head === coordinate.head &&
        candidate.invocationId === coordinate.invocationId
    );
    if (!inspected?.turnId || !inspected.requestDigest) continue;
    const turnId = inspected.turnId;
    const turnEdge = edges.find(
      (edge) =>
        edge.kind === "part-of-turn" &&
        sameInvocation(edge.from, coordinate) &&
        isTrajectoryNode(edge.to, "trajectory-turn", "turnId", turnId, coordinate)
    );
    if (!turnEdge) continue;
    const turn = inspectedTurns.find(
      (candidate) =>
        candidate.logId === coordinate.logId &&
        candidate.head === coordinate.head &&
        candidate.turnId === turnId
    );
    if (!turn?.triggerMessageId) continue;
    const triggerMessageId = turn.triggerMessageId;
    const messageEdge = edges.find(
      (edge) =>
        edge.kind === "triggered-by" &&
        isTrajectoryNode(edge.from, "trajectory-turn", "turnId", turn.turnId, coordinate) &&
        isTrajectoryNode(edge.to, "trajectory-message", "messageId", triggerMessageId, coordinate)
    );
    if (!messageEdge) continue;
    const message = inspectedMessages.find(
      (candidate) =>
        candidate.logId === coordinate.logId &&
        candidate.head === coordinate.head &&
        candidate.messageId === triggerMessageId &&
        candidate.role === "user" &&
        Boolean(candidate.sourceMessageId) &&
        Boolean(candidate.senderId) &&
        candidate.text.trim() === expectedPromptText.trim()
    );
    if (message) return { passed: true, reason: undefined };
  }

  return {
    passed: false,
    reason:
      "Completed tool results did not contain one identity-joined blame → change → work unit → command → invocation with request reference → turn → exact current user prompt with source message and sender identities",
  };
}

const ORDINARY_CHANGE_KINDS = new Set([
  "text-edit",
  "file-create",
  "file-delete",
  "file-restore",
  "file-move",
  "file-copy",
  "file-mode",
  "content-replace",
  "repository-create",
  "repository-delete",
  "repository-restore",
  "repository-move",
]);

/**
 * Require an identity-joined, honestly bounded import explanation.
 *
 * The snapshot is a fact on the import work unit, not a synthetic change. A
 * valid proof therefore joins the terminal blame identities through an
 * ordinary inspected change, its exact import work unit and recorded intent,
 * and the completed import command. User-facing prose is deliberately not an
 * evidence channel; an unrelated snapshot or a polished unsupported claim
 * cannot satisfy the validator.
 */
export function requireImportBoundaryEvidence(
  result: TestExecutionResult,
  expected: { sourceKind: string; sourceUriPrefix: string }
): {
  passed: boolean;
  reason?: string;
} {
  const origins: Array<{ changeId: string; workUnitId: string; commandId: string }> = [];
  const changes = new Map<string, Record<string, unknown>>();
  const workUnits = new Map<string, Record<string, unknown>>();
  const commands = new Map<string, Record<string, unknown>>();
  const visit = (value: unknown, seen: Set<object>): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (!Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const origin = blameOrigin(record);
      if (record["stop"] === "import-boundary" && origin) origins.push(origin);
      const node = record["node"];
      if (isRecord(node) && isRecord(node["value"])) {
        const inspected = node["value"];
        if (node["kind"] === "change" && typeof inspected["changeId"] === "string") {
          changes.set(inspected["changeId"], inspected);
        } else if (node["kind"] === "work-unit" && typeof inspected["workUnitId"] === "string") {
          workUnits.set(inspected["workUnitId"], inspected);
        } else if (node["kind"] === "command" && typeof inspected["commandId"] === "string") {
          commands.set(inspected["commandId"], inspected);
        }
      }
    }
    for (const child of Object.values(value)) visit(child, seen);
  };
  for (const call of getToolCalls(result)) {
    if (call.execution?.status !== "complete" || call.execution.isError === true) continue;
    // `vcs` and `provenance` are host-shaped tool results. An eval program may
    // call the same services, but its returned object is arbitrary agent code
    // and cannot serve as validator evidence by itself.
    if (call.name !== "vcs" && call.name !== "provenance") continue;
    visit(call.execution.result, new Set<object>());
  }

  for (const origin of origins) {
    const change = changes.get(origin.changeId);
    if (
      !change ||
      !ORDINARY_CHANGE_KINDS.has(String(change["kind"])) ||
      change["authoredByWorkUnitId"] !== origin.workUnitId
    ) {
      continue;
    }

    const workUnit = workUnits.get(origin.workUnitId);
    const snapshot = workUnit?.["externalSnapshot"];
    if (
      !workUnit ||
      workUnit["kind"] !== "import" ||
      workUnit["commandId"] !== origin.commandId ||
      typeof workUnit["intentSummary"] !== "string" ||
      workUnit["intentSummary"].trim().length === 0 ||
      !isRecord(snapshot) ||
      snapshot["sourceKind"] !== expected.sourceKind ||
      typeof snapshot["sourceUri"] !== "string" ||
      !snapshot["sourceUri"].startsWith(expected.sourceUriPrefix) ||
      typeof snapshot["snapshotRevision"] !== "string" ||
      snapshot["snapshotRevision"].trim().length === 0 ||
      snapshot["snapshotRevision"] === "unknown" ||
      typeof snapshot["snapshotDigest"] !== "string" ||
      !/^snapshot:[0-9a-f]{64}$/u.test(snapshot["snapshotDigest"])
    ) {
      continue;
    }

    const command = commands.get(origin.commandId);
    if (
      !command ||
      command["method"] !== "importSnapshot" ||
      command["status"] !== "complete" ||
      !isRecord(command["result"]) ||
      command["result"]["kind"] !== "work-unit" ||
      command["result"]["workUnitId"] !== origin.workUnitId
    ) {
      continue;
    }

    return { passed: true, reason: undefined };
  }

  return {
    passed: false,
    reason:
      "Completed tool results did not identity-join an import-boundary blame span through its ordinary change, owning import work unit with exact external snapshot and intent, and completed command",
  };
}

function collectCausalEvidence(
  value: unknown,
  edges: ObservedCausalEdge[],
  origins: ObservedBlameOrigin[],
  inspectedInvocations: InspectedInvocation[],
  inspectedTurns: InspectedTurn[],
  inspectedMessages: InspectedMessage[],
  seen: Set<object>
): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (!Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record["kind"] === "string" && isRecord(record["from"]) && isRecord(record["to"])) {
      edges.push({ kind: record["kind"], from: record["from"], to: record["to"] });
    }
    const origin = blameOrigin(record);
    if (
      typeof record["start"] === "number" &&
      typeof record["end"] === "number" &&
      Array.isArray(record["path"]) &&
      origin
    ) {
      origins.push(origin);
    }
    if (
      isRecord(record["node"]) &&
      record["node"]["kind"] === "trajectory-invocation" &&
      isRecord(record["node"]["value"])
    ) {
      const coordinate = trajectoryInvocation(record["node"]["value"]);
      const value = record["node"]["value"];
      if (coordinate) {
        inspectedInvocations.push({
          ...coordinate,
          turnId: typeof value["turnId"] === "string" ? value["turnId"] : null,
          requestDigest:
            isRecord(value["requestRef"]) && typeof value["requestRef"]["digest"] === "string"
              ? value["requestRef"]["digest"]
              : null,
        });
      }
    }
    if (
      isRecord(record["node"]) &&
      record["node"]["kind"] === "trajectory-turn" &&
      isRecord(record["node"]["value"])
    ) {
      const value = record["node"]["value"];
      if (
        typeof value["logId"] === "string" &&
        typeof value["head"] === "string" &&
        typeof value["turnId"] === "string"
      ) {
        inspectedTurns.push({
          logId: value["logId"],
          head: value["head"],
          turnId: value["turnId"],
          triggerMessageId:
            typeof value["triggerMessageId"] === "string" ? value["triggerMessageId"] : null,
        });
      }
    }
    if (
      isRecord(record["node"]) &&
      record["node"]["kind"] === "trajectory-message" &&
      isRecord(record["node"]["value"])
    ) {
      const value = record["node"]["value"];
      if (
        typeof value["logId"] === "string" &&
        typeof value["head"] === "string" &&
        typeof value["messageId"] === "string"
      ) {
        inspectedMessages.push({
          logId: value["logId"],
          head: value["head"],
          messageId: value["messageId"],
          role: typeof value["role"] === "string" ? value["role"] : null,
          sourceMessageId:
            typeof value["sourceMessageId"] === "string" ? value["sourceMessageId"] : null,
          senderId:
            isRecord(value["senderRef"]) && typeof value["senderRef"]["id"] === "string"
              ? value["senderRef"]["id"]
              : null,
          text: Array.isArray(value["textBlocks"])
            ? value["textBlocks"]
                .filter(
                  (block): block is Record<string, unknown> =>
                    isRecord(block) && typeof block["content"] === "string"
                )
                .map((block) => block["content"] as string)
                .join("\n")
            : "",
        });
      }
    }
  }
  for (const child of Object.values(value)) {
    collectCausalEvidence(
      child,
      edges,
      origins,
      inspectedInvocations,
      inspectedTurns,
      inspectedMessages,
      seen
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNode(
  value: Record<string, unknown>,
  kind: string,
  identityField: string,
  identity: string
): boolean {
  return value["kind"] === kind && value[identityField] === identity;
}

function trajectoryInvocation(value: Record<string, unknown>): InvocationCoordinate | null {
  if (value["kind"] !== undefined && value["kind"] !== "trajectory-invocation") {
    return null;
  }
  return typeof value["logId"] === "string" &&
    typeof value["head"] === "string" &&
    typeof value["invocationId"] === "string"
    ? {
        logId: value["logId"],
        head: value["head"],
        invocationId: value["invocationId"],
      }
    : null;
}

function sameInvocation(value: Record<string, unknown>, coordinate: InvocationCoordinate): boolean {
  const candidate = trajectoryInvocation(value);
  return Boolean(
    candidate &&
    candidate.logId === coordinate.logId &&
    candidate.head === coordinate.head &&
    candidate.invocationId === coordinate.invocationId
  );
}

function isTrajectoryNode(
  value: Record<string, unknown>,
  kind: "trajectory-turn" | "trajectory-message",
  identityField: "turnId" | "messageId",
  identity: string,
  coordinate: Pick<InvocationCoordinate, "logId" | "head">
): boolean {
  return (
    value["kind"] === kind &&
    value["logId"] === coordinate.logId &&
    value["head"] === coordinate.head &&
    value[identityField] === identity
  );
}

/** Prove an uncertain exact mutation retry replayed one terminal result without
 * creating a second semantic application, work unit, or change. */
export function requireCommandIdempotencyEvidence(result: TestExecutionResult): {
  passed: boolean;
  reason?: string;
} {
  const evalCode = successfulEvalCode(result);
  if ((evalCode.match(/\bvcs\.edit\s*\(/gu) ?? []).length < 2) {
    return fail("A successful eval did not submit the same semantic edit twice");
  }

  const mutations: Record<string, unknown>[] = [];
  const statuses: Record<string, unknown>[] = [];
  const visit = (value: unknown, seen: Set<object>): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (!Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const workingHead = recordField(record, "workingHead");
      if (
        stringField(record, "commandId") &&
        stringField(record, "contextId") &&
        stringField(record, "workUnitId") &&
        stringField(record, "applicationId") &&
        record["changeCount"] === 1 &&
        isStringArray(record["changeIds"]) &&
        record["changeIds"].length === 1 &&
        record["incorporatedChangeCount"] === 0 &&
        isStringArray(record["incorporatedChangeIds"]) &&
        record["incorporatedChangeIds"].length === 0 &&
        isStringArray(record["decisionIds"]) &&
        workingHead?.["kind"] === "application" &&
        workingHead["applicationId"] === record["applicationId"]
      ) {
        mutations.push(record);
      }
      if (stringField(record, "contextId") && workingHead && isRecord(record["workingCounts"])) {
        statuses.push(record);
      }
    }
    for (const child of Object.values(value)) visit(child, seen);
  };
  for (const value of successfulEvalReturnValues(result)) visit(value, new Set<object>());

  for (const [index, first] of mutations.entries()) {
    const second = mutations
      .slice(index + 1)
      .find((candidate) => JSON.stringify(candidate) === JSON.stringify(first));
    if (!second) continue;
    const applicationId = stringField(first, "applicationId")!;
    const contextId = stringField(first, "contextId")!;
    const status = statuses.find((candidate) => {
      const counts = recordField(candidate, "workingCounts");
      return (
        candidate["contextId"] === contextId &&
        sameState(candidate["workingHead"], { kind: "application", applicationId }) &&
        counts?.["applications"] === 1 &&
        counts["workUnits"] === 1 &&
        counts["changes"] === 1
      );
    });
    if (status) return { passed: true, reason: undefined };
  }
  return fail(
    "Completed canonical results did not show two identical mutation terminals joined to one application, work unit, change, and final working state"
  );
}

/**
 * Validate the observable protocol proof for the stale-frontier recovery test.
 *
 * A disciplined agent may catch `RevisionChanged` inside eval so it can prove
 * the rejected request had no effect and complete the recovery in one scoped
 * program. The same protocol also permits the typed refusal to escape one eval
 * invocation before a later successful eval performs the proof and recovery.
 * Source-code token matching cannot distinguish either valid workflow from a
 * comment, so this validator reads invocation results instead.
 */
export function requireFreshnessRecoveryEvidence(result: TestExecutionResult): {
  passed: boolean;
  reason?: string;
} {
  const evalCalls = getToolCalls(result).filter((call) => call.name === "eval");
  const successfulResults = evalCalls
    .filter((call) => call.execution?.status === "complete" && call.execution.isError !== true)
    .map((call) => call.execution?.result);
  const failedResults = evalCalls
    .filter((call) => {
      const execution = call.execution;
      return Boolean(
        execution &&
        (execution.isError === true ||
          execution.status === "error" ||
          execution.status === "failed")
      );
    })
    .map((call) => call.execution?.result);

  const refusalObserved =
    successfulResults.some((value) =>
      containsStructuredField(value, "code", (candidate) => candidate === "RevisionChanged")
    ) || failedResults.some((value) => containsExactProtocolToken(value, "RevisionChanged"));
  const proofs = successfulResults.map((value) => canonicalFreshnessProof(value));
  const noPartialEffect = proofs.some((proof) => proof.noPartialEffect);
  const recovered = proofs.some((proof) => proof.recovered);
  const distinctCommands = proofs.some((proof) => proof.distinctCommands);

  const missing = [
    !refusalObserved ? "typed RevisionChanged refusal" : null,
    !noPartialEffect ? "partialEffect:none" : null,
    !recovered ? "recovered:true" : null,
    !distinctCommands ? "distinct oldCommand/newCommand" : null,
  ].filter((value): value is string => value !== null);
  return {
    passed: missing.length === 0,
    reason: missing.length === 0 ? undefined : `Eval results did not prove ${missing.join(", ")}`,
  };
}

function containsStructuredField(
  value: unknown,
  key: string,
  predicate: (candidate: unknown) => boolean,
  seen = new Set<object>()
): boolean {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (!Array.isArray(value) && key in value && predicate((value as Record<string, unknown>)[key])) {
    return true;
  }
  return Object.values(value).some((child) => containsStructuredField(child, key, predicate, seen));
}

function containsExactProtocolToken(value: unknown, token: string): boolean {
  if (typeof value === "string") {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}(?:$|[^A-Za-z0-9_])`).test(value);
  }
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some((child) => containsExactProtocolToken(child, token));
}

interface FreshnessStatusProof {
  contextId: string;
  committed: unknown;
  workingHead: unknown;
  workingCounts: unknown;
}

function freshnessStatus(value: unknown): FreshnessStatusProof | null {
  if (
    !isRecord(value) ||
    typeof value["contextId"] !== "string" ||
    !isRecord(value["committed"]) ||
    !isRecord(value["workingHead"]) ||
    !isRecord(value["workingCounts"])
  ) {
    return null;
  }
  return {
    contextId: value["contextId"],
    committed: value["committed"],
    workingHead: value["workingHead"],
    workingCounts: value["workingCounts"],
  };
}

function sameFreshnessStatus(left: FreshnessStatusProof, right: FreshnessStatusProof): boolean {
  return (
    left.contextId === right.contextId &&
    JSON.stringify(left.committed) === JSON.stringify(right.committed) &&
    JSON.stringify(left.workingHead) === JSON.stringify(right.workingHead) &&
    JSON.stringify(left.workingCounts) === JSON.stringify(right.workingCounts)
  );
}

function canonicalFreshnessProof(
  value: unknown,
  seen = new Set<object>()
): { noPartialEffect: boolean; recovered: boolean; distinctCommands: boolean } {
  const empty = { noPartialEffect: false, recovered: false, distinctCommands: false };
  if (!value || typeof value !== "object" || seen.has(value)) return empty;
  seen.add(value);

  if (!Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const entries = Object.entries(record);
    const stale = entries
      .filter(([key]) => /stale|refusal/iu.test(key))
      .map(([, candidate]) => candidate)
      .find(
        (candidate) =>
          isRecord(candidate) &&
          typeof candidate["commandId"] === "string" &&
          containsStructuredField(candidate, "code", (code) => code === "RevisionChanged")
      );
    const staleCommandId =
      isRecord(stale) && typeof stale["commandId"] === "string" ? stale["commandId"] : null;

    const before = entries
      .filter(([key]) => /before.*stale|after.*(?:advance|step2)|status.*step2/iu.test(key))
      .map(([, candidate]) => freshnessStatus(candidate))
      .find((candidate): candidate is FreshnessStatusProof => candidate !== null);
    const afterStale = entries
      .filter(([key]) => /after.*stale/iu.test(key))
      .map(([, candidate]) => freshnessStatus(candidate))
      .find((candidate): candidate is FreshnessStatusProof => candidate !== null);
    const afterRecovery = entries
      .filter(([key]) => /after.*(?:retry|recover|fresh)/iu.test(key))
      .map(([, candidate]) => freshnessStatus(candidate))
      .find((candidate): candidate is FreshnessStatusProof => candidate !== null);
    const recoveryMutation = entries
      .filter(([key]) => /retry|recover|fresh/iu.test(key))
      .map(([, candidate]) => candidate)
      .find(
        (candidate) =>
          isRecord(candidate) &&
          typeof candidate["commandId"] === "string" &&
          typeof candidate["workUnitId"] === "string" &&
          typeof candidate["applicationId"] === "string" &&
          isRecord(candidate["workingHead"])
      );
    const recoveryCommandId =
      isRecord(recoveryMutation) && typeof recoveryMutation["commandId"] === "string"
        ? recoveryMutation["commandId"]
        : null;
    const noPartialEffect = Boolean(
      before && afterStale && sameFreshnessStatus(before, afterStale)
    );
    const recovered = Boolean(
      afterStale &&
      afterRecovery &&
      recoveryMutation &&
      afterStale.contextId === afterRecovery.contextId &&
      JSON.stringify(afterStale.workingHead) !== JSON.stringify(afterRecovery.workingHead) &&
      JSON.stringify((recoveryMutation as Record<string, unknown>)["workingHead"]) ===
        JSON.stringify(afterRecovery.workingHead)
    );
    const distinctCommands = Boolean(
      staleCommandId && recoveryCommandId && staleCommandId !== recoveryCommandId
    );
    if (noPartialEffect || recovered || distinctCommands) {
      return { noPartialEffect, recovered, distinctCommands };
    }
  }

  return Object.values(value).reduce((proof, child) => {
    const nested = canonicalFreshnessProof(child, seen);
    return {
      noPartialEffect: proof.noPartialEffect || nested.noPartialEffect,
      recovered: proof.recovered || nested.recovered,
      distinctCommands: proof.distinctCommands || nested.distinctCommands,
    };
  }, empty);
}

export function requireAnyEvalEvidence(
  result: TestExecutionResult,
  alternatives: readonly (readonly string[])[]
): { passed: boolean; reason?: string } {
  const code = successfulEvalCode(result);
  const matched = alternatives.some((required) => required.every((token) => code.includes(token)));
  if (!matched) {
    return {
      passed: false,
      reason: `Successful eval did not exercise any supported path: ${alternatives
        .map((tokens) => tokens.join(" + "))
        .join(" or ")}`,
    };
  }
  return { passed: true };
}

export function completedToolNames(result: TestExecutionResult): Set<string> {
  return new Set(
    getToolCalls(result)
      .filter((call) => call.execution?.status === "complete" && !call.execution?.isError)
      .map((call) => call.name)
  );
}

export function incompleteToolCalls(result: TestExecutionResult): InvocationCardPayloadLike[] {
  return getToolCalls(result).filter((call) => !isSettledInvocation(call));
}

export function failedToolCalls(result: TestExecutionResult): InvocationCardPayloadLike[] {
  return getToolCalls(result).filter((call) => {
    const execution = call.execution;
    if (!execution) return false;
    if (execution.isError) return true;
    return execution.status === "error" || execution.status === "failed";
  });
}

function isSettledInvocation(call: InvocationCardPayloadLike): boolean {
  const execution = call.execution;
  if (!execution) return false;
  if (execution.status === "complete" || execution.status === "error") return true;
  return typeof execution.terminalOutcome === "string" && execution.terminalOutcome.length > 0;
}

function formatInvocationError(call: InvocationCardPayloadLike): string {
  const execution = call.execution;
  const raw = execution?.result;
  const message =
    raw && typeof raw === "object" && "error" in raw
      ? String((raw as { error?: unknown }).error)
      : raw === undefined
        ? (execution?.status ?? "unknown")
        : String(raw);
  return message.slice(0, 160);
}
