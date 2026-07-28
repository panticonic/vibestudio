import { describe, expect, it } from "vitest";

import type { TestExecutionResult } from "../types.js";
import { agentOrchestrationTests } from "./agent-orchestration.js";

function terminalExecution(code: string): TestExecutionResult {
  return {
    duration: 1,
    messages: [
      { kind: "message", senderId: "user", complete: true, content: "prompt" },
      {
        kind: "message",
        senderId: "agent",
        complete: true,
        contentType: "invocation",
        content: "{}",
        invocation: {
          id: "eval-1",
          name: "eval",
          arguments: { code },
          execution: {
            status: "complete",
            isError: false,
            result: {
              details: {
                returnValue: {
                  exitCode: 0,
                  stdout: "agentic-terminal-roundtrip",
                  stderr: "",
                  durationMs: 4,
                },
              },
            },
          },
        },
      },
      {
        kind: "message",
        senderId: "agent",
        complete: true,
        content: "agentic-terminal-roundtrip completed with exit code 0.",
      },
    ],
  } as TestExecutionResult;
}

function completedTool(
  id: string,
  name: string,
  args: Record<string, unknown>,
  details: Record<string, unknown> = {},
  subagent?: {
    runId?: string;
    agentKind?: string;
    launchConfig?: Record<string, unknown> | null;
  }
): TestExecutionResult["messages"][number] {
  return {
    kind: "message",
    senderId: "agent",
    complete: true,
    contentType: "invocation",
    content: "{}",
    invocation: {
      id,
      name,
      arguments: args,
      execution: {
        status: "complete",
        isError: false,
        result: { details },
      },
      ...(subagent ? { subagent } : {}),
    },
  } as TestExecutionResult["messages"][number];
}

const fixtureLaunchConfig = {
  model: "openai-codex:gpt-5.3-codex-spark",
  thinkingLevel: "minimal",
};

describe("agent orchestration validators", () => {
  const terminal = agentOrchestrationTests.find(
    ({ name }) => name === "terminal-extension-custom-approval"
  )!;
  const claude = agentOrchestrationTests.find(
    ({ name }) => name === "claude-subagent-readonly-diagnostic"
  )!;
  const fixtureFanout = agentOrchestrationTests.find(
    ({ name }) => name === "cheap-subagent-fixture-fanout"
  )!;

  it("accepts the documented short shell extension name", () => {
    const execution = terminalExecution(
      "return extensions.invoke('shell', 'exec', [{ command: '/usr/bin/printf', args: ['agentic-terminal-roundtrip'], shell: false }]);"
    );

    expect(terminal.validate(execution)).toEqual({ passed: true });
  });

  it("rejects prose-only claims without a successful extension invocation", () => {
    expect(terminal.validate(terminalExecution("return { ok: true };"))).toMatchObject({
      passed: false,
      reason: expect.stringContaining("shell extension"),
    });
  });

  it("accepts a report that follows the requested Claude evidence contract", () => {
    const execution = {
      duration: 1,
      messages: [
        { kind: "message", senderId: "user", complete: true, content: "prompt" },
        completedTool("spawn", "spawn_subagent", {
          agentKind: "claude-code",
          config: { model: "haiku", effort: "low" },
        }),
        completedTool("runtime", "inspect_subagent", { query: "runtime" }),
        completedTool("read", "read_subagent", {}),
        completedTool("status", "inspect_subagent", { query: "status" }),
        completedTool("close", "close_subagent", {}),
        {
          kind: "message",
          senderId: "agent",
          complete: true,
          content: [
            "Completed.",
            "Run ID: claude-run-1.",
            "Finding: docs/implementation mismatch creates a concrete ergonomics risk.",
            "Semantic status: clean.",
            "Runtime evidence: external process exited with code 0.",
            "Cleanup: closed without integration.",
          ].join("\n"),
        },
      ],
    } as TestExecutionResult;

    expect(claude.validate(execution)).toEqual({ passed: true });
  });

  it("rejects fixture fan-out claims when the latest child integration still needs a decision", () => {
    const messages: TestExecutionResult["messages"] = [
      { id: "prompt", kind: "message", senderId: "user", complete: true, content: "prompt" },
    ];
    for (const runId of ["fixture-a", "fixture-b", "fixture-c"]) {
      messages.push(
        completedTool(`spawn-${runId}`, "spawn_subagent", {
          agentKind: "pi",
          config: fixtureLaunchConfig,
        }, {}, {
          runId,
          agentKind: "pi",
          launchConfig: fixtureLaunchConfig,
        }),
        completedTool(`inspect-${runId}`, "inspect_subagent", { runId }),
        completedTool(
          `integrate-${runId}`,
          "integrate_subagent",
          { runId },
          {
            status: runId === "fixture-c" ? "needs-decision" : "working",
            sourceEventId: `workspace-event:${runId}`,
          }
        ),
        completedTool(`close-${runId}`, "close_subagent", { runId })
      );
    }
    messages.push(
      completedTool("eval", "eval", {}, { returnValue: { ok: true } }),
      completedTool("commit", "vcs", { operation: "commit" }, {
        operation: "commit",
        result: {
          integrationSourceEventIds: [
            "workspace-event:fixture-a",
            "workspace-event:fixture-b",
            "workspace-event:fixture-c",
          ],
        },
      }),
      completedTool("provenance", "provenance", {}),
      {
        id: "final",
        kind: "message",
        senderId: "agent",
        complete: true,
        content:
          "Three cheap-model fixture corpora were integrated with causal provenance and author evidence.",
      }
    );

    expect(fixtureFanout.validate({ duration: 1, messages } as TestExecutionResult)).toMatchObject({
      passed: false,
      reason: expect.stringContaining("fully resolved"),
    });
  });

  it("accepts supervised integration through both subagent and semantic VCS tools", () => {
    const sourceEventIds = [
      "workspace-event:fixture-a",
      "workspace-event:fixture-b",
      "workspace-event:fixture-c",
    ];
    const messages: TestExecutionResult["messages"] = [
      { id: "prompt", kind: "message", senderId: "user", complete: true, content: "prompt" },
    ];
    for (const [index, runId] of ["fixture-a", "fixture-b", "fixture-c"].entries()) {
      messages.push(
        completedTool(`spawn-${runId}`, "spawn_subagent", {
          agentKind: "pi",
          config: fixtureLaunchConfig,
        }, {}, {
          runId,
          agentKind: "pi",
          launchConfig: fixtureLaunchConfig,
        }),
        completedTool(`inspect-${runId}`, "inspect_subagent", { runId })
      );
      if (index === 0) {
        messages.push(
          completedTool(
            `integrate-incomplete-${runId}`,
            "integrate_subagent",
            { runId },
            { status: "needs-decision", sourceEventId: sourceEventIds[index] }
          ),
          completedTool(
            `integrate-${runId}`,
            "integrate_subagent",
            { runId },
            { status: "working", sourceEventId: sourceEventIds[index] }
          )
        );
      } else {
        messages.push(
          completedTool(`integrate-${runId}`, "vcs", {
            operation: "integrate",
            sourceEventId: sourceEventIds[index],
          })
        );
      }
      messages.push(
        completedTool(`close-${runId}`, "close_subagent", { runId }, { discarded: false })
      );
    }
    messages.push(
      completedTool("eval", "eval", {}, {
        returnValue: {
          counts: { causality: 14, stateMachine: 17, unicodeSerialization: 12, total: 43 },
          unicodeChecks: { allParsed: true, allSerialized: true },
        },
      }),
      completedTool("commit", "vcs", { operation: "commit" }, {
        operation: "commit",
        result: { integrationSourceEventIds: sourceEventIds },
      }),
      completedTool("provenance", "provenance", {}),
      {
        id: "final",
        kind: "message",
        senderId: "agent",
        complete: true,
        content:
          "Three cheap-model fixture corpora were integrated with causal provenance and author evidence.",
      }
    );

    expect(fixtureFanout.validate({ duration: 1, messages } as TestExecutionResult)).toEqual({
      passed: true,
    });

    const evalMessage = messages.find(
      (message) =>
        message.contentType === "invocation" &&
        (message as { invocation?: { name?: string } }).invocation?.name === "eval"
    ) as {
      invocation: {
        execution: { result: { details: { returnValue: { unicodeChecks: object } } } };
      };
    };
    evalMessage.invocation.execution.result.details.returnValue.unicodeChecks = {
      allParsed: true,
      allSerialized: false,
    };
    expect(fixtureFanout.validate({ duration: 1, messages } as TestExecutionResult)).toMatchObject({
      passed: false,
      reason: expect.stringContaining("structured evidence"),
    });
  });

  it("declares only the canonical digest-scoped workspace verification approval", () => {
    expect(fixtureFanout.authorityPolicy).toEqual({
      authority: [
        {
          ruleId: "fixture-verification-userland-approval",
          capability: { kind: "exact", key: "user-approval.request" },
          resource: { kind: "exact", key: "user-approval.request" },
          tier: "gated",
          decision: "once",
        },
      ],
      userland: [
        {
          ruleId: "fixture-verification-workspace-test",
          subject: { kind: "prefix", prefix: "workspace-test:" },
          decision: "allow",
          remember: false,
        },
      ],
    });
  });
});
