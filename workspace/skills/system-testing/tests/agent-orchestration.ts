import type { TestCase } from "../types.js";
import { BUILDABLE_PACKAGE_WORKSPACE_REPO_FIXTURE } from "../types.js";
import { validateAgentCompletionReport } from "../test-runner.js";

export const agentOrchestrationTests: TestCase[] = [
  {
    name: "subagent-diff-inspection",
    description:
      "A parent delegates a small change, reviews the child's semantic diff, and deliberately leaves it unintegrated",
    category: "agent-orchestration",
    workspaceRepoFixture: BUILDABLE_PACKAGE_WORKSPACE_REPO_FIXTURE,
    prompt:
      "Ask a fresh subagent to add and commit one small deterministic typed export in the disposable package. Review what the child changed without integrating it, then summarize the bounded diff and leave the terminal child result available for later inspection.",
    validate: validateAgentCompletionReport,
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
