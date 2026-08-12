import { describe, expect, it } from "vitest";
import type { TestExecutionResult } from "../types.js";
import { localModelTests } from "./local-models.js";

const taskTest = localModelTests[0]!;
const skillTest = localModelTests[1]!;

function execution(
  model: string,
  options: {
    taskStatus?: "running" | "complete";
    terminalOutcome?: "success" | "tool_error";
    childHeading?: string;
    finalText?: string;
    finalHeading?: string;
    taskChannelId?: string;
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
          subagent: {
            agentKind: "pi",
            launchConfig: { model },
            ...(options.taskChannelId ? { taskChannelId: options.taskChannelId } : {}),
          },
        },
      },
      {
        id: "final",
        senderId: "agent",
        senderMetadata: { type: "agent" },
        kind: "message" as const,
        complete: true,
        content: options.finalText ?? `The README heading is ${options.finalHeading ?? heading}.`,
      },
    ],
  } as unknown as TestExecutionResult;
}

describe("local model task evidence", () => {
  it("requires lifecycle inspection and an exact local-model child", () => {
    expect(taskTest.validation).toBe("agent-evidence");
    expect(taskTest.validate(execution("local:lfm2.5-2.6b"))).toEqual({
      passed: true,
      reason: undefined,
    });
  });

  it("rejects a child launched on a hosted model", () => {
    expect(taskTest.validate(execution("openai-codex:gpt-5.3-codex-spark"))).toMatchObject({
      passed: false,
    });
  });

  it("rejects a local child that has not completed successfully", () => {
    expect(
      taskTest.validate(execution("local:lfm2.5-2.6b", { taskStatus: "running" }))
    ).toMatchObject({ passed: false });
    expect(
      taskTest.validate(execution("local:lfm2.5-2.6b", { terminalOutcome: "tool_error" }))
    ).toMatchObject({ passed: false });
  });

  it("requires the parent to report the local child's observed heading", () => {
    expect(
      taskTest.validate(
        execution("local:lfm2.5-2.6b", {
          finalHeading: "system-test-local-model-download-and-task-deadbeef",
        })
      )
    ).toMatchObject({ passed: false });
  });
});

describe("local model skill evidence", () => {
  const model = "local:lfm2.5-2.6b";

  function validExecution(options?: {
    loadRoute?: "read" | "docs";
    readStatus?: "complete" | "error";
    readPath?: string;
    final?: string;
    modelEvidence?: unknown;
    subject?: Record<string, unknown>;
  }): TestExecutionResult {
    const readStatus = options?.readStatus ?? "complete";
    return {
      duration: 1,
      messages: [
        {
          id: "read-skill",
          senderId: "agent",
          kind: "message",
          contentType: "invocation",
          complete: true,
          content: "",
          invocation: {
            id: "read-skill",
            name: options?.loadRoute === "docs" ? "docs_open" : "read",
            arguments: {
              ...(options?.loadRoute === "docs"
                ? { id: "server-logs" }
                : { path: options?.readPath ?? "skills/server-logs/SKILL.md" }),
            },
            execution: {
              status: readStatus,
              description: "",
              isError: readStatus === "error",
            },
          },
        },
        {
          id: "final",
          senderId: "agent",
          senderMetadata: { type: "agent" },
          kind: "message",
          complete: true,
          content:
            options?.final ??
            "Use a bounded server-log tail or query with an explicit limit; keep boot and sequence coordinates.",
          model: { ref: model },
        },
      ],
      diagnostics: {
        localModelSubject: options?.subject ?? {
          direct: true,
          model,
          setupCompleted: true,
        },
      },
      modelExecutionEvidence: options?.modelEvidence ?? {
        attempts: [{ provider: "local", model: "lfm2.5-2.6b" }],
      },
    } as unknown as TestExecutionResult;
  }

  it("requires the prepared local model itself to load the relevant skill", () => {
    expect(skillTest.orchestrate).toBeTypeOf("function");
    expect(skillTest.validation).toBe("agent-evidence");
    expect(skillTest.validate(validExecution())).toEqual({ passed: true, reason: undefined });
    expect(skillTest.validate(validExecution({ loadRoute: "docs" }))).toEqual({
      passed: true,
      reason: undefined,
    });
  });

  it("rejects hosted execution or a supervisor standing in for the model subject", () => {
    expect(
      skillTest.validate(
        validExecution({
          modelEvidence: {
            attempts: [{ provider: "openai-codex", model: "gpt-5.3-codex-spark" }],
          },
        })
      )
    ).toMatchObject({ passed: false });
    expect(
      skillTest.validate(
        validExecution({
          subject: { direct: false, model, setupCompleted: true },
        })
      )
    ).toMatchObject({ passed: false });
  });

  it("does not count another file or a failed read as skill evidence", () => {
    expect(
      skillTest.validate(validExecution({ readPath: "skills/local-models/SKILL.md" }))
    ).toMatchObject({ passed: false });
    expect(skillTest.validate(validExecution({ readStatus: "error" }))).toMatchObject({
      passed: false,
    });
  });

  it("requires bounded server-log guidance in the local model's answer", () => {
    expect(skillTest.validate(validExecution({ final: "The server logs exist." }))).toMatchObject({
      passed: false,
    });
  });
});
