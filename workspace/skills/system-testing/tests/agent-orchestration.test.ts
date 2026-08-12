import { describe, expect, it } from "vitest";
import type { TestExecutionResult } from "../types.js";

import { agentGoalPromptFindings } from "../prompt-contract.js";
import { agentOrchestrationTests } from "./agent-orchestration.js";

describe("agent orchestration scenarios", () => {
  it("state user goals without embedding the subagent API or runtime configuration", () => {
    for (const test of agentOrchestrationTests) {
      expect(agentGoalPromptFindings(test.prompt), test.name).toEqual([]);
      expect(test.validation, test.name).toBe(
        test.name === "subagent-diff-inspection" ? "agent-evidence" : undefined
      );
    }
  });

  it("joins the reviewed diff to the exact terminal child's committed event", () => {
    const test = agentOrchestrationTests.find(({ name }) => name === "subagent-diff-inspection")!;
    const runId = "spawn-run-with-a-long-canonical-identity";
    const runHandle = "spawn-run-with-a-long-ca…";
    const sourceEventId = "workspace-event:child-commit";
    const invocation = (
      name: string,
      id: string,
      arguments_: Record<string, unknown>,
      details: Record<string, unknown>,
      protocolText = ""
    ) => ({
      kind: "message" as const,
      senderId: "agent",
      complete: true,
      contentType: "invocation" as const,
      invocation: {
        id,
        name,
        arguments: arguments_,
        execution: {
          status: "complete" as const,
          isError: false,
          result: {
            protocolContent: protocolText ? [{ type: "text", text: protocolText }] : [],
            details,
          },
        },
      },
    });
    const execution = (
      inspectedSource = sourceEventId,
      integrationState = "unattempted",
      inspectedRun = runHandle
    ): TestExecutionResult =>
      ({
        duration: 1,
        messages: [
          invocation(
            "spawn_subagent",
            runId,
            { mode: "fresh", task: "Add an export" },
            { runId: runHandle }
          ),
          {
            kind: "message",
            senderId: "agent",
            complete: true,
            contentType: "task",
            task: {
              id: runId,
              taskType: "subagent",
              title: "Add an export",
              execution: {
                status: "complete",
                terminalOutcome: "success",
                description: "",
                result: { details: { sourceEventId } },
              },
            },
          },
          invocation(
            "inspect_subagent",
            "inspect-child",
            { runId: inspectedRun, query: "diff" },
            {
              runId: inspectedRun,
              query: "diff",
              semanticIntegration: {
                state: integrationState,
                sourceEventId: inspectedSource,
              },
            },
            `Source ${sourceEventId}: 1 adopt\nCoordinate: file:typed-export · adopt · add deterministic export\nChild source is committed and clean.`
          ),
          {
            kind: "message",
            senderId: "agent",
            senderMetadata: { type: "agent" },
            complete: true,
            content:
              "The committed typed export is a one-coordinate diff and remains unintegrated.",
          },
        ],
      }) as TestExecutionResult;

    expect(test.validate(execution())).toEqual({ passed: true, reason: undefined });
    expect(test.validate(execution("workspace-event:other")).passed).toBe(false);
    expect(test.validate(execution(sourceEventId, "complete")).passed).toBe(false);
    expect(test.validate(execution(sourceEventId, "unattempted", "another-run")).passed).toBe(
      false
    );
    expect(
      test.validate({
        duration: 1,
        messages: [
          {
            kind: "message",
            senderId: "agent",
            senderMetadata: { type: "agent" },
            complete: true,
            content: "The committed typed export remains unintegrated.",
          },
        ],
      } as TestExecutionResult).passed
    ).toBe(false);
  });

  it("keeps model selection out of scenario prose", () => {
    for (const test of agentOrchestrationTests) {
      expect(test.prompt, test.name).not.toMatch(/gpt-|claude-\d|thinkingLevel|launchConfig/u);
    }
  });

  it("keeps the delegated design synthesis independent of workspace fixtures", () => {
    const synthesis = agentOrchestrationTests.find(
      ({ name }) => name === "subagent-design-synthesis"
    );
    expect(synthesis?.authorityPolicy).toBeUndefined();
    expect(synthesis?.workspaceRepoFixture).toBeUndefined();
    expect(synthesis?.prompt).toContain("There is no existing codebase");
    expect(synthesis?.prompt).toContain(
      "Delegate two independent reviews concurrently to subagents"
    );
    expect(synthesis?.prompt).toContain("at most five bullets");
    expect(synthesis?.prompt).toContain("both replies are in the conversation");
    expect(synthesis?.prompt).toContain("one synthesis under 500 words");
    expect(synthesis?.prompt).not.toContain("finish supervising");
  });

  it("keeps delegation quality in trajectory review rather than stale task-card validation", () => {
    const synthesis = agentOrchestrationTests.find(
      ({ name }) => name === "subagent-design-synthesis"
    );
    expect(synthesis?.validation).toBeUndefined();
    expect(synthesis?.validate).toBeDefined();
  });
});
