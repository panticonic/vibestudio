import { describe, expect, it } from "vitest";
import type { TestExecutionResult } from "../types.js";
import { localModelTests } from "./local-models.js";

const test = localModelTests[0]!;

function execution(model: string): TestExecutionResult {
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
      id: `${name}-call`,
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
});
