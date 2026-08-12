import { describe, expect, it } from "vitest";
import type { ValidationTrajectoryEvent } from "../runner.js";
import type { TestExecutionResult } from "../types.js";
import { localModelTests, summarizeLocalSkillTrajectory } from "./local-models.js";

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

function trajectoryEvent(
  kind: ValidationTrajectoryEvent["kind"],
  seq: number,
  invocationId: string,
  payload: Record<string, unknown>
): ValidationTrajectoryEvent {
  return {
    kind,
    seq,
    causality: { invocationId },
    payload,
  } as unknown as ValidationTrajectoryEvent;
}

describe("local model skill evidence", () => {
  const model = "local:lfm2.5-2.6b";
  const taskChannelId = "task-local-skill";
  const events = [
    trajectoryEvent("invocation.started", 2, "read-skill", {
      name: "read",
      request: { path: "skills/server-logs/SKILL.md" },
    }),
    trajectoryEvent("invocation.completed", 3, "read-skill", {
      terminalOutcome: "success",
    }),
    trajectoryEvent("invocation.started", 4, "inspect-logs", {
      name: "eval",
      request: {
        code: "return services.serverLog.query({ level: 'warn', limit: 20 });",
      },
    }),
    trajectoryEvent("invocation.completed", 5, "inspect-logs", {
      terminalOutcome: "success",
    }),
  ];

  function validExecution(): TestExecutionResult {
    const result = execution(model, {
      taskChannelId,
      finalText: "The local check found no recent warnings in the server logs.",
    });
    result.diagnostics = {
      localSkillTrajectory: summarizeLocalSkillTrajectory(events, {
        model,
        report: "No recent warnings.",
        runId: "spawn-local-model",
        taskChannelId,
      }),
    };
    return result;
  }

  it("requires a successful skill read before a successful service inspection", () => {
    expect(skillTest.orchestrate).toBeTypeOf("function");
    expect(skillTest.validation).toBe("agent-evidence");
    expect(skillTest.validate(validExecution())).toEqual({ passed: true, reason: undefined });
  });

  it("rejects missing or reversed child-trajectory evidence", () => {
    const missing = validExecution();
    missing.diagnostics = {
      localSkillTrajectory: {
        eventCount: 2,
        model,
        serverLogInspectionSeq: 4,
        serverLogSkillReadSeq: null,
        taskChannelId,
      },
    };
    expect(skillTest.validate(missing)).toMatchObject({ passed: false });

    const reversed = validExecution();
    reversed.diagnostics = {
      localSkillTrajectory: {
        eventCount: 4,
        model,
        serverLogInspectionSeq: 2,
        serverLogSkillReadSeq: 4,
        taskChannelId,
      },
    };
    expect(skillTest.validate(reversed)).toMatchObject({ passed: false });
  });

  it("does not count failed skill or service calls as evidence", () => {
    const failed = events.filter(
      (event) =>
        event.kind !== "invocation.completed" || event.causality?.invocationId !== "read-skill"
    );
    expect(
      summarizeLocalSkillTrajectory(failed, {
        model,
        report: "No recent warnings.",
        runId: "spawn-local-model",
        taskChannelId,
      })
    ).toMatchObject({ serverLogSkillReadSeq: null, serverLogInspectionSeq: 4 });
  });
});
