import type { ChatMessage } from "@workspace/agentic-core";
import type { HeadlessSession, SessionSnapshot } from "@workspace/agentic-session";
import {
  BUILDABLE_PACKAGE_WORKSPACE_REPO_FIXTURE,
  CONTENT_WORKSPACE_REPO_FIXTURE,
  type TestCase,
  type TestExecutionResult,
  type TestOrchestrationContext,
} from "../types.js";
import {
  getToolCalls,
  findLastAgentMessage,
  hasAgentResponse,
  noIncompleteInvocations,
  requireCausalEdgeEvidence,
  requireCommandIdempotencyEvidence,
  requireFreshnessRecoveryEvidence,
  requireImportBoundaryEvidence,
  requireMoveCopyEvidence,
  requireRevertEvidence,
  requireVcsEvidence,
  successfulReadMemoryEpisodes,
} from "./_helpers.js";

function checked(result: TestExecutionResult, evidence: string[]) {
  if (!hasAgentResponse(result) || !findLastAgentMessage(result).trim()) {
    return { passed: false, reason: "No agent response received" };
  }
  const invocations = noIncompleteInvocations(result);
  if (!invocations.passed) return invocations;
  return requireVcsEvidence(result, evidence);
}

const CAUSALITY_PROMPT =
  "Create and publish a distinctive multi-line file in the disposable project, then change and commit only one line. Explain where an untouched line came from and what can actually be established about the request and intent behind it.";

const MIXED_IMPORT_PROMPT =
  "Change exactly one existing line in the disposable project. Then explain what we actually know about both that edited line and a neighboring untouched line, including why each is present and where certainty ends.";

const READ_MEMORY_REASON = "Meridian relays reserve one retry slot for delayed acknowledgements";

function readResultDetails(call: ReturnType<typeof getToolCalls>[number]) {
  if (
    call.name !== "read" ||
    call.execution?.status !== "complete" ||
    call.execution.isError === true ||
    !isRecord(call.execution.result)
  ) {
    return null;
  }
  const details = call.execution.result["details"];
  return isRecord(details) ? details : null;
}

function requireInjectedReadMemory(result: TestExecutionResult) {
  const reads = getToolCalls(result).map(readResultDetails).filter(isRecord);
  const attached = reads.find((details) => {
    const provenance = details["provenance"];
    if (!isRecord(provenance) || provenance["status"] !== "attached") return false;
    const episodes = provenance["episodes"];
    return (
      Array.isArray(episodes) &&
      episodes.some((episode) => {
        if (!isRecord(episode)) return false;
        const cause = episode["cause"];
        return (
          isRecord(cause) &&
          typeof cause["triggerText"] === "string" &&
          cause["triggerText"].includes(READ_MEMORY_REASON) &&
          isRecord(cause["message"]) &&
          isRecord(episode["change"]) &&
          isRecord(episode["workUnit"]) &&
          isRecord(episode["command"])
        );
      })
    );
  });
  if (!attached) {
    return {
      passed: false,
      reason:
        "No ordinary read returned hash/range-bound attached memory with the prior request and reusable typed roots",
    };
  }
  const displayedRange = attached["displayedRange"];
  if (
    !isRecord(displayedRange) ||
    displayedRange["coordinateKind"] !== "utf16" ||
    !Number.isInteger(displayedRange["start"]) ||
    !Number.isInteger(displayedRange["end"])
  ) {
    return {
      passed: false,
      reason: "The memory-bearing read did not retain its exact displayed UTF-16 range",
    };
  }
  const final = findLastAgentMessage(result);
  if (
    !/retry.{0,24}(?:ceiling|budget|limit)/iu.test(final) ||
    !/meridian/iu.test(final) ||
    !/delayed acknowledgements/iu.test(final)
  ) {
    return {
      passed: false,
      reason: "The fresh reader did not use the injected memory to explain the non-obvious choice",
    };
  }
  return noIncompleteInvocations(result);
}

async function orchestrateReadMemory(
  context: TestOrchestrationContext
): Promise<TestExecutionResult> {
  const startedAt = Date.now();
  const fixtureName = context.runner.workspaceRepoName;
  if (!fixtureName) throw new Error("read memory requires a repository fixture");
  const repoPath = `projects/${fixtureName}`;
  const sessions: Array<{ role: "author" | "reader"; session: HeadlessSession }> = [];
  const cleanupErrors: string[] = [];
  let authorMessages: ChatMessage[] = [];
  let error: string | undefined;

  try {
    const author = await context.runner.spawn({ context: "task" });
    sessions.push({ role: "author", session: author });
    await context.sendAndWait(
      author,
      [
        `In ${repoPath}, create src/retry-policy.ts containing a small exported retryCeiling constant set to 7.`,
        `${READ_MEMORY_REASON}, so seven is deliberate and must remain below eight.`,
        "Commit this coherent change with that reason preserved. Report the path and clean state.",
      ].join(" "),
      "author records the non-obvious retry policy"
    );
    authorMessages = [...author.messages] as ChatMessage[];

    const reader = await context.runner.spawn({ context: "task" });
    sessions.push({ role: "reader", session: reader });
    await context.sendAndWait(
      reader,
      `A previous collaborator chose retryCeiling 7 in ${repoPath}/src/retry-policy.ts. Read the file and explain the recorded reason for that exact choice, with the evidence the workspace gives you.`,
      "fresh reader recovers intent from an ordinary read"
    );
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  const reader = sessions.find(({ role }) => role === "reader")?.session;
  const messages = [...authorMessages, ...(reader ? ([...reader.messages] as ChatMessage[]) : [])];
  const snapshots = sessions.map(({ role, session }) => {
    try {
      return { role, snapshot: session.snapshot() };
    } catch (cause) {
      return {
        role,
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  });
  const readerSnapshot = snapshots.find(({ role }) => role === "reader")?.snapshot;
  const execution: TestExecutionResult = {
    messages,
    duration: Date.now() - startedAt,
    ...(error ? { error } : {}),
    ...(readerSnapshot ? { snapshot: readerSnapshot as SessionSnapshot } : {}),
    diagnostics: {
      orchestrated: true,
      repoPath,
      sessions: snapshots.map(({ role, snapshot, error: snapshotError }) => ({
        role,
        messageCount: snapshot?.messages.length ?? 0,
        invocationCount: snapshot?.invocations.length ?? 0,
        ...(snapshotError ? { snapshotError } : {}),
      })),
    },
  };

  for (const { role, session } of [...sessions].reverse()) {
    try {
      await session.close();
      cleanupErrors.push(
        ...session
          .snapshot()
          .cleanupErrors.map((entry) => `${role} ${entry.phase}: ${entry.message}`)
      );
    } catch (cause) {
      cleanupErrors.push(`${role}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  if (cleanupErrors.length > 0) {
    execution.cleanupErrors = cleanupErrors;
    execution.error ??= `Headless cleanup failed: ${cleanupErrors.join("; ")}`;
  }
  return execution;
}

function requireDistinctMixedBlameSpans(result: TestExecutionResult) {
  const explicitSpans = getToolCalls(result).flatMap((call) => {
    if (
      call.name !== "vcs" ||
      call.arguments?.["operation"] !== "blame" ||
      call.execution?.status !== "complete" ||
      call.execution.isError === true ||
      !isRecord(call.execution.result)
    ) {
      return [];
    }
    const details = isRecord(call.execution.result["details"])
      ? call.execution.result["details"]
      : call.execution.result;
    const value = isRecord(details["result"]) ? details["result"] : details;
    return Array.isArray(value["spans"]) ? value["spans"].filter(isRecord) : [];
  });
  const attachedSpans = successfulReadMemoryEpisodes(result).flatMap((episode) =>
    Array.isArray(episode["ranges"])
      ? episode["ranges"].filter(isRecord).map(
          (range): Record<string, unknown> => ({
            ...episode,
            start: range["start"],
            end: range["end"],
          })
        )
      : []
  );
  const spans = [...explicitSpans, ...attachedSpans];
  const authored = spans.find((span) => span["stop"] === "authored");
  const imported = spans.find((span) => span["stop"] === "import-boundary");
  const authoredChange = authored?.["change"];
  const importedChange = imported?.["change"];
  const authoredWork = authored?.["workUnit"];
  const importedWork = imported?.["workUnit"];
  const authoredCommand = authored?.["command"];
  const importedCommand = imported?.["command"];
  if (
    !authored ||
    !imported ||
    !isRecord(authoredChange) ||
    !isRecord(importedChange) ||
    !isRecord(authoredWork) ||
    !isRecord(importedWork) ||
    !isRecord(authoredCommand) ||
    !isRecord(importedCommand) ||
    !Number.isInteger(authored["start"]) ||
    !Number.isInteger(authored["end"]) ||
    !Number.isInteger(imported["start"]) ||
    !Number.isInteger(imported["end"]) ||
    authoredChange["changeId"] === importedChange["changeId"] ||
    authoredWork["workUnitId"] === importedWork["workUnitId"] ||
    authoredCommand["commandId"] === importedCommand["commandId"] ||
    Math.max(authored["start"] as number, imported["start"] as number) <
      Math.min(authored["end"] as number, imported["end"] as number)
  ) {
    return {
      passed: false,
      reason:
        "Canonical blame results did not expose distinct, non-overlapping native-authored and import-boundary spans",
    };
  }
  return { passed: true, reason: undefined };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export const vcsAdvancedTests: TestCase[] = [
  {
    name: "vcs-read-injected-memory",
    description:
      "A fresh agent recovers a prior collaborator's non-obvious intent from an ordinary managed-file read",
    category: "vcs-advanced",
    workspaceRepoFixture: CONTENT_WORKSPACE_REPO_FIXTURE,
    prompt: "Harness-orchestrated read-time provenance memory.",
    orchestrate: orchestrateReadMemory,
    validate: (result) => {
      if (!hasAgentResponse(result)) return { passed: false, reason: "No agent response received" };
      return requireInjectedReadMemory(result);
    },
  },
  {
    name: "vcs-explicit-move-copy",
    description: "Use explicit file transfers and verify their distinct provenance semantics",
    category: "vcs-advanced",
    workspaceRepoFixture: CONTENT_WORKSPACE_REPO_FIXTURE,
    prompt:
      "Create two small source files in the disposable project. Reorganize them so one moves to a nested location and the other is duplicated, then explain what happened to their identities and history.",
    validate: (result) => {
      const base = checked(result, ["vcs.move", "vcs.copy"]);
      if (!base.passed) return base;
      return requireMoveCopyEvidence(result);
    },
  },
  {
    name: "vcs-walkable-causality-blame",
    description: "Walk realized content to its exact causal invocation and line ancestry",
    category: "vcs-advanced",
    resources: ["vcs:protected-main"],
    workspaceRepoFixture: CONTENT_WORKSPACE_REPO_FIXTURE,
    prompt: `${CAUSALITY_PROMPT} Read the finished file before answering so its exact-coordinate workspace memory is part of your evidence.`,
    validate: (result) => {
      const base = checked(result, []);
      if (!base.passed) return base;
      return requireCausalEdgeEvidence(
        result,
        `${CAUSALITY_PROMPT} Read the finished file before answering so its exact-coordinate workspace memory is part of your evidence.`
      );
    },
  },
  {
    name: "vcs-honest-import-boundary",
    description:
      "Explain an imported line using exact native facts and an honest external boundary",
    category: "vcs-advanced",
    workspaceRepoFixture: BUILDABLE_PACKAGE_WORKSPACE_REPO_FIXTURE,
    prompt:
      "Who changed an untouched line in the disposable project, and what can we actually establish about why it is here?",
    validate: (result) => {
      const base = checked(result, []);
      if (!base.passed) return base;
      return requireImportBoundaryEvidence(result, {
        sourceKind: "generated",
        sourceUriPrefix: "system-test://vcs-honest-import-boundary/",
      });
    },
  },
  {
    name: "vcs-edited-import-boundary",
    description: "Distinguish new native intent from untouched imported origin in one file",
    category: "vcs-advanced",
    workspaceRepoFixture: BUILDABLE_PACKAGE_WORKSPACE_REPO_FIXTURE,
    prompt: MIXED_IMPORT_PROMPT,
    validate: (result) => {
      const base = checked(result, []);
      if (!base.passed) return base;
      const spans = requireDistinctMixedBlameSpans(result);
      if (!spans.passed) return spans;
      const native = requireCausalEdgeEvidence(result, MIXED_IMPORT_PROMPT);
      if (!native.passed) return native;
      return requireImportBoundaryEvidence(result, {
        sourceKind: "generated",
        sourceUriPrefix: "system-test://vcs-edited-import-boundary/",
      });
    },
  },
  {
    name: "vcs-revert-preserves-history",
    description: "Counteract exact semantic changes without erasing their history",
    category: "vcs-advanced",
    workspaceRepoFixture: BUILDABLE_PACKAGE_WORKSPACE_REPO_FIXTURE,
    prompt:
      "Change and commit one existing line in the disposable project. Then semantically counteract that exact committed change so the original content returns without pretending the first change never happened. Commit the counteraction and explain the recorded relationship.",
    validate: (result) => {
      const base = checked(result, ["vcs.edit", "vcs.revert", "vcs.commit", "vcs.status"]);
      return base.passed ? requireRevertEvidence(result) : base;
    },
  },
  {
    name: "vcs-stale-basis-recovery",
    description: "Reject a stale local mutation and recover from a fresh observation",
    category: "vcs-advanced",
    workspaceRepoFixture: CONTENT_WORKSPACE_REPO_FIXTURE,
    prompt:
      "Demonstrate semantic optimistic concurrency in the disposable project: retain one exact working-head basis, advance the context with a different change, submit a new VCS edit against the retained stale basis, observe the typed refusal and unchanged state, then retry from a fresh basis with a fresh command identity. Explain whether the rejected command had any effect.",
    validate: (result) => {
      const base = checked(result, ["vcs.edit"]);
      if (!base.passed) return base;
      return requireFreshnessRecoveryEvidence(result);
    },
  },
  {
    name: "vcs-command-idempotency",
    description: "Retry one exact command without duplicating semantic work",
    category: "vcs-advanced",
    workspaceRepoFixture: CONTENT_WORKSPACE_REPO_FIXTURE,
    prompt:
      "Demonstrate semantic command idempotency in the disposable project as if the first response were lost: submit one exact VCS edit command, retry the identical request with the identical command identity, and prove both terminals name one application, work unit, and change with no duplicate history.",
    validate: (result) => {
      const base = checked(result, ["vcs.edit"]);
      return base.passed ? requireCommandIdempotencyEvidence(result) : base;
    },
  },
];
