import {
  BUILDABLE_PACKAGE_WORKSPACE_REPO_FIXTURE,
  CONTENT_WORKSPACE_REPO_FIXTURE,
  type TestCase,
  type TestExecutionResult,
} from "../types.js";
import {
  finalMessageHasAll,
  getToolCalls,
  noIncompleteInvocations,
  requireCausalEdgeEvidence,
  requireFreshnessRecoveryEvidence,
  requireImportBoundaryEvidence,
  requireMoveCopyEvidence,
  requireRevertEvidence,
  requireVcsEvidence,
} from "./_helpers.js";

function checked(result: TestExecutionResult, tokens: string[], evidence: string[]) {
  const message = finalMessageHasAll(result, tokens);
  if (!message.passed) return message;
  const invocations = noIncompleteInvocations(result);
  if (!invocations.passed) return invocations;
  return requireVcsEvidence(result, evidence);
}

const VCS_CAUSALITY_PROMPT =
  "Create and publish a distinctive multi-line file, then change and commit only one line. Using the workspace guidance, explain an untouched line from the current file. Follow the realized work all the way back to the exact initiating message and sender, show how the exact action request remains retrievable, and distinguish observable intent evidence from private reasoning. Finish with VCS_CAUSALITY_OK untouched:original command: invocation: turn: message:exact sender:exact request:walkable intent:observable-private blame:exact edges:walkable.";

const VCS_MIXED_IMPORT_PROMPT =
  "Change exactly one existing line in the disposable project. Then explain what we actually know about both that edited line and a neighboring untouched line, including why each is present and where certainty ends. Finish with VCS_MIXED_ORIGIN_OK edited:native untouched:import-boundary pre-import:unknown.";

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
  if (
    !authored ||
    !imported ||
    !Number.isInteger(authored["start"]) ||
    !Number.isInteger(authored["end"]) ||
    !Number.isInteger(imported["start"]) ||
    !Number.isInteger(imported["end"]) ||
    authored["changeId"] === imported["changeId"] ||
    authored["workUnitId"] === imported["workUnitId"] ||
    authored["commandId"] === imported["commandId"] ||
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
      "Use the workspace guidance to create two managed source files in the disposable project. Move one to a nested path and independently copy the other. Do not reconstruct either operation by deleting and rewriting bytes. Walk the resulting provenance far enough to prove the move kept its file identity and the copy got a new identity linked to its source. Finish with VCS_TRANSFER_OK moved:same-identity copied:new-identity ancestry:walkable work-units:2.",
    validate: (result) => {
      const base = checked(
        result,
        [
          "VCS_TRANSFER_OK",
          "moved:same-identity",
          "copied:new-identity",
          "ancestry:walkable",
          "work-units:2",
        ],
        ["vcs.neighbors"]
      );
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
    prompt: VCS_CAUSALITY_PROMPT,
    validate: (result) => {
      const base = checked(
        result,
        [
          "VCS_CAUSALITY_OK",
          "untouched:original",
          "command:",
          "invocation:",
          "turn:",
          "message:exact",
          "sender:exact",
          "request:walkable",
          "intent:observable-private",
          "blame:exact",
          "edges:walkable",
        ],
        ["vcs.blame", "vcs.inspect", "vcs.neighbors"]
      );
      if (!base.passed) return base;
      return requireCausalEdgeEvidence(result, VCS_CAUSALITY_PROMPT);
    },
  },
  {
    name: "vcs-honest-import-boundary",
    description:
      "Explain an imported line using exact native facts and an honest external boundary",
    category: "vcs-advanced",
    workspaceRepoFixture: BUILDABLE_PACKAGE_WORKSPACE_REPO_FIXTURE,
    prompt:
      "Who changed an untouched line in the disposable project, and what can we actually establish about why it is here? Finish with VCS_IMPORT_BOUNDARY_OK.",
    validate: (result) => {
      const base = checked(
        result,
        ["VCS_IMPORT_BOUNDARY_OK", "pre-import:unknown"],
        ["vcs.blame", "vcs.inspect"]
      );
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
    prompt: VCS_MIXED_IMPORT_PROMPT,
    validate: (result) => {
      const base = checked(
        result,
        ["VCS_MIXED_ORIGIN_OK", "edited:native", "untouched:import-boundary", "pre-import:unknown"],
        ["vcs.blame", "vcs.inspect", "vcs.neighbors"]
      );
      if (!base.passed) return base;
      const spans = requireDistinctMixedBlameSpans(result);
      if (!spans.passed) return spans;
      const native = requireCausalEdgeEvidence(result, VCS_MIXED_IMPORT_PROMPT);
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
      "Change and commit one existing line in the disposable project. Then undo that exact change through workspace history, commit the reversal, and verify both the restored file and the original/counteraction history. Finish with VCS_REVERT_OK restored:true original: counteraction: history:preserved.",
    validate: (result) => {
      const base = checked(
        result,
        ["VCS_REVERT_OK", "restored:true", "original:", "counteraction:", "history:preserved"],
        ["vcs.revert", "vcs.commit", "vcs.neighbors", "vcs.status"]
      );
      return base.passed ? requireRevertEvidence(result) : base;
    },
  },
  {
    name: "vcs-stale-basis-recovery",
    description: "Reject a stale local mutation and recover from a fresh observation",
    category: "vcs-advanced",
    workspaceRepoFixture: CONTENT_WORKSPACE_REPO_FIXTURE,
    prompt:
      "In the disposable project, deliberately retain an observed working identity, advance the context once, and try a different write against the retained identity. Prove the stale attempt was rejected with no partial effect. Re-observe and complete the intent with a new command identity. Finish with VCS_STALE_OK refusal:RevisionChanged partial:none commands:distinct recovered:true.",
    validate: (result) => {
      const base = checked(
        result,
        [
          "VCS_STALE_OK",
          "refusal:RevisionChanged",
          "partial:none",
          "commands:distinct",
          "recovered:true",
        ],
        ["vcs.edit"]
      );
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
      "Perform one small managed-file change, retain the complete canonical request, and retry that identical request with the same command identity as if the first response had been uncertain. Prove the terminal response is identical and no second work unit, application, or change appeared. Finish with VCS_IDEMPOTENT_OK result:same work-units:1 applications:1 changes:1.",
    validate: (result) =>
      checked(
        result,
        ["VCS_IDEMPOTENT_OK", "result:same", "work-units:1", "applications:1", "changes:1"],
        ["vcs.edit", "commandId"]
      ),
  },
];
