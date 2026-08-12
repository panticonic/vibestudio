import type { TestCase, TestExecutionResult } from "../types.js";
import { BUILDABLE_PACKAGE_WORKSPACE_REPO_FIXTURE } from "../types.js";
import { validateAgentCompletionReport } from "../test-runner.js";
import { findLastAgentMessage, getToolCalls, noIncompleteInvocations } from "./_helpers.js";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function callDetails(call: ReturnType<typeof getToolCalls>[number]) {
  return record(record(call.execution?.result)?.["details"]);
}

function protocolText(call: ReturnType<typeof getToolCalls>[number]): string {
  const content = record(call.execution?.result)?.["protocolContent"];
  return Array.isArray(content)
    ? content
        .map((block) => record(block)?.["text"])
        .filter((text): text is string => typeof text === "string")
        .join("\n")
    : "";
}

function validateUnintegratedSubagentDiff(result: TestExecutionResult) {
  const base = validateAgentCompletionReport(result);
  if (!base.passed) return base;
  const calls = getToolCalls(result);
  const spawn = calls.find(
    (call) =>
      call.name === "spawn_subagent" &&
      call.execution?.status === "complete" &&
      call.execution.isError !== true
  );
  if (!spawn) {
    return { passed: false, reason: "No completed child launch established a canonical run" };
  }
  const runHandle = callDetails(spawn)?.["runId"];
  if (typeof runHandle !== "string" || !runHandle) {
    return { passed: false, reason: "The child launch receipt did not identify its exact run" };
  }
  const task = result.messages.find(
    (message) =>
      message.task?.id === spawn.id &&
      message.task.execution.status === "complete" &&
      message.task.execution.terminalOutcome === "success" &&
      message.task.execution.isError !== true
  )?.task;
  const sourceEventId = record(record(task?.execution.result)?.["details"])?.["sourceEventId"];
  if (typeof sourceEventId !== "string" || !sourceEventId) {
    return {
      passed: false,
      reason: "The exact terminal child did not retain a committed source event",
    };
  }
  const inspection = calls.find((call) => {
    if (
      call.name !== "inspect_subagent" ||
      call.arguments?.["query"] !== "diff" ||
      call.arguments?.["runId"] !== runHandle ||
      call.execution?.status !== "complete" ||
      call.execution.isError === true
    ) {
      return false;
    }
    const details = callDetails(call);
    const integration = record(details?.["semanticIntegration"]);
    return (
      details?.["runId"] === runHandle &&
      integration?.["state"] === "unattempted" &&
      integration["sourceEventId"] === sourceEventId
    );
  });
  if (!inspection) {
    return {
      passed: false,
      reason:
        "No bounded diff joined the exact terminal child's committed event to an unintegrated parent state",
    };
  }
  const diff = protocolText(inspection);
  const escapedEvent = sourceEventId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (
    !new RegExp(`Source\\s+${escapedEvent}:\\s*[1-9]\\d*\\s+adopt`, "u").test(diff) ||
    !/Coordinate:.*\badopt\b/iu.test(diff) ||
    !/Child source is committed and clean/iu.test(diff)
  ) {
    return {
      passed: false,
      reason: "The child-relative diff did not prove a non-empty committed clean change",
    };
  }
  const final = findLastAgentMessage(result);
  if (!/export/iu.test(final) || !/(?:unintegrated|not integrated|left .*separate)/iu.test(final)) {
    return {
      passed: false,
      reason: "The parent did not summarize the export diff and its unintegrated disposition",
    };
  }
  return noIncompleteInvocations(result);
}

export const agentOrchestrationTests: TestCase[] = [
  {
    name: "subagent-diff-inspection",
    description:
      "A parent delegates a small change, reviews the child's semantic diff, and deliberately leaves it unintegrated",
    category: "agent-orchestration",
    workspaceRepoFixture: BUILDABLE_PACKAGE_WORKSPACE_REPO_FIXTURE,
    prompt:
      "Ask a fresh subagent to add one small deterministic typed export in the disposable package. Review what the child changed without integrating it, then summarize the bounded diff.",
    validation: "agent-evidence",
    validate: validateUnintegratedSubagentDiff,
  },
  {
    name: "subagent-design-synthesis",
    description: "Two children explore competing design priorities that the parent synthesizes",
    category: "agent-orchestration",
    prompt:
      "Run a brief design review for a hypothetical standalone TypeScript library that represents edge-case test corpora. There is no existing codebase for it, so reason only from this brief. Delegate two independent reviews concurrently to subagents: one favoring a simple data model, the other favoring provenance and debuggability. Ask each reviewer to keep their reply to at most five bullets. Once both replies are in the conversation, write one synthesis under 500 words covering the main tradeoffs and disagreements.",
    validate: validateAgentCompletionReport,
  },
  {
    name: "claude-subagent-readonly-diagnostic",
    description:
      "Claude Code performs a bounded read-only audit while the parent supervises its progress and verifies that no source changed",
    category: "agent-orchestration",
    prompt:
      "Ask Claude Code to perform a read-only audit comparing the subagent reading-versus-inspection documentation with the current implementation. Have it identify one concrete developer-ergonomics risk with source evidence. Supervise the task through its normal progress and runtime information, confirm afterward that its workspace stayed clean, and report the finding plus any difficulty you encountered supervising it.",
    validate: validateAgentCompletionReport,
  },
  {
    name: "terminal-extension-capability-acquisition",
    description:
      "A harmless argv-mode terminal command exercises the installed scoped terminal capability",
    category: "agent-orchestration",
    authorityPolicy: {
      authority: [
        {
          ruleId: "terminal-native-execution",
          capability: {
            kind: "prefix",
            prefix: "userland:extensions/shell/native.shell.execute#",
          },
          resource: {
            kind: "exact",
            key: "native.shell:extension:@workspace-extensions/shell",
          },
          tier: "gated",
          decision: "once",
        },
      ],
    },
    prompt:
      "Use the installed terminal capability to run a harmless bounded argv-mode printf command without shell interpretation. Print agentic-terminal-roundtrip, then report the observed output, exit status, and whether the command timed out or truncated anything.",
    validate: validateAgentCompletionReport,
  },
];
