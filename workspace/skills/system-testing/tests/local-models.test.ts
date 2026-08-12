import { describe, expect, it } from "vitest";
import type { TestExecutionResult } from "../types.js";
import { localModelTests } from "./local-models.js";

const test = localModelTests[0]!;

function execution(
  model: string,
  options: {
    taskStatus?: "running" | "complete";
    terminalOutcome?: "success" | "tool_error";
    childHeading?: string;
    finalHeading?: string;
  } = {}
): TestExecutionResult {
  const runId = "spawn-local-model";
  const heading = options.childHeading ?? "system-test-local-model-download-and-task-a1b2c3d4";
  const invocation = (
    name: string,
    arguments_: Record<string, unknown>,
    extra: Record<string, unknown> = {}
  ) => ({
    id: `${name}-call`,
    senderId: "agent",
    kind: "message" as const,
    contentType: "invocation" as const,
    complete: true,
    content: "",
    invocation: {
      id: name === "spawn_subagent" ? runId : `${name}-call`,
      name,
      arguments: arguments_,
      ...extra,
      execution: { status: "complete", isError: false, result: { details: {} } },
    },
  });
  return {
    duration: 1,
    messages: [
      invocation("eval", {
        code: `
          const extension = "@workspace-extensions/local-models";
          const status = await services.extensions.invoke(extension, "status", []);
          const models = await services.extensions.invoke(extension, "listModels", []);
          return { status, models };
        `,
      }),
      invocation(
        "spawn_subagent",
        { prompt: "Read the README heading", config: { model } },
        { subagent: { agentKind: "pi", launchConfig: { model } } }
      ),
      {
        id: runId,
        senderId: "agent",
        kind: "message" as const,
        contentType: "task",
        complete: options.taskStatus !== "running",
        content: "",
        task: {
          id: runId,
          taskType: "subagent",
          title: "Read the README heading",
          execution: {
            status: options.taskStatus ?? "complete",
            terminalOutcome: options.terminalOutcome ?? "success",
            description: "",
            result: { protocolContent: [{ type: "text", text: `# ${heading}` }] },
          },
          subagent: { agentKind: "pi", launchConfig: { model } },
        },
      },
      {
        id: "final",
        senderId: "agent",
        senderMetadata: { type: "agent" },
        kind: "message" as const,
        complete: true,
        content: `The README heading is ${options.finalHeading ?? heading}.`,
      },
    ],
  } as unknown as TestExecutionResult;
}

describe("local model task evidence", () => {
  it("requires lifecycle inspection and an exact local-model child", () => {
    expect(test.validation).toBe("agent-evidence");
    expect(test.validate(execution("local:lfm2.5-2.6b"))).toEqual({
      passed: true,
      reason: undefined,
    });
  });

  it("rejects a child launched on a hosted model", () => {
    expect(test.validate(execution("openai-codex:gpt-5.3-codex-spark"))).toMatchObject({
      passed: false,
    });
  });

  it("rejects a local child that has not completed successfully", () => {
    expect(
      test.validate(execution("local:lfm2.5-2.6b", { taskStatus: "running" }))
    ).toMatchObject({ passed: false });
    expect(
      test.validate(execution("local:lfm2.5-2.6b", { terminalOutcome: "tool_error" }))
    ).toMatchObject({ passed: false });
  });

  it("requires the parent to report the local child's observed heading", () => {
    expect(
      test.validate(
        execution("local:lfm2.5-2.6b", {
          finalHeading: "system-test-local-model-download-and-task-deadbeef",
        })
      )
    ).toMatchObject({ passed: false });
  });
});
