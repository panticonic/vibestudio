import {
  BUILDABLE_PACKAGE_WORKSPACE_REPO_FIXTURE,
  CONTENT_WORKSPACE_REPO_FIXTURE,
  type TestCase,
  type TestExecutionResult,
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

function requireDistinctMixedBlameSpans(result: TestExecutionResult) {
  const spans = getToolCalls(result).flatMap((call) => {
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
    name: "vcs-explicit-move-copy",
    description: "Use explicit file transfers and verify their distinct provenance semantics",
    category: "vcs-advanced",
    workspaceRepoFixture: CONTENT_WORKSPACE_REPO_FIXTURE,
    prompt:
      "Create two small source files in the disposable project. Reorganize them so one moves to a nested location and the other is duplicated, then explain what happened to their identities and history.",
    validate: (result) => {
      const base = checked(result, ["vcs.move", "vcs.copy", "vcs.inspect", "vcs.neighbors"]);
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
    prompt: CAUSALITY_PROMPT,
    validate: (result) => {
      const base = checked(result, ["vcs.blame", "vcs.inspect", "vcs.neighbors"]);
      if (!base.passed) return base;
      return requireCausalEdgeEvidence(result, CAUSALITY_PROMPT);
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
      const base = checked(result, ["vcs.blame", "vcs.inspect"]);
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
      const base = checked(result, ["vcs.blame", "vcs.inspect", "vcs.neighbors"]);
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
      "Change and commit one existing line in the disposable project. Restore its original content, commit that restoration, and explain what the workspace history records about both changes.",
    validate: (result) => {
      const base = checked(result, [
        "vcs.edit",
        "vcs.revert",
        "vcs.commit",
        "vcs.neighbors",
        "vcs.status",
      ]);
      return base.passed ? requireRevertEvidence(result) : base;
    },
  },
  {
    name: "vcs-stale-basis-recovery",
    description: "Reject a stale local mutation and recover from a fresh observation",
    category: "vcs-advanced",
    workspaceRepoFixture: CONTENT_WORKSPACE_REPO_FIXTURE,
    prompt:
      "Demonstrate how the disposable project behaves when a change is attempted from an out-of-date view, then complete the intended change safely. Explain whether the rejected attempt had any effect.",
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
      "Demonstrate what happens when the same managed-file change is submitted again because its first response might have been lost. Explain whether any duplicate history was created.",
    validate: (result) => {
      const base = checked(result, ["vcs.edit"]);
      return base.passed ? requireCommandIdempotencyEvidence(result) : base;
    },
  },
];
