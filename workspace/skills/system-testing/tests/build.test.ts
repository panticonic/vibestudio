import { describe, expect, it } from "vitest";

import type { ChatMessage } from "@workspace/agentic-core";
import type { TestExecutionResult } from "../types.js";
import { buildTests } from "./build.js";

const npmTest = buildTests.find((test) => test.name === "build-npm-package")!;

describe("build npm package validation", () => {
  it("rejects confident prose when the npm eval failed", () => {
    const result = execution([
      evalInvocation("error", true),
      finalAgentMessage("The dependency loaded correctly and returned a padded value."),
    ]);

    expect(npmTest.validate(result)).toMatchObject({
      passed: false,
      reason: "Unexpected failed tool calls: eval",
    });
  });

  it("accepts a successful npm import and observable result with natural prose", () => {
    const result = execution([
      evalInvocation("complete", false, "007"),
      finalAgentMessage("The package loaded and padded 7 to three characters: 007."),
    ]);

    expect(npmTest.validate(result)).toEqual({ passed: true, reason: undefined });
  });

  it("rejects a recovered result when the trajectory still contains a failed tool call", () => {
    const result = execution([
      evalInvocation("error", true),
      evalInvocation("complete", false, "007"),
      finalAgentMessage("A later attempt worked and produced 007."),
    ]);

    expect(npmTest.validate(result)).toMatchObject({ passed: false });
  });

  it("rejects success prose without a canonical returned value", () => {
    const result = execution([
      evalInvocation("complete", false),
      finalAgentMessage("The package definitely worked."),
    ]);

    expect(npmTest.validate(result)).toMatchObject({
      passed: false,
      reason: "The npm import produced no observable result",
    });
  });
});

function evalInvocation(
  status: "complete" | "error",
  isError: boolean,
  returnValue?: unknown
): ChatMessage {
  return {
    id: `eval-${status}-${isError}-${String(returnValue)}`,
    kind: "message",
    senderId: "agent",
    complete: true,
    contentType: "invocation",
    content: JSON.stringify({
      id: `call-eval-${status}-${isError}-${String(returnValue)}`,
      name: "eval",
      arguments: {
        imports: { "left-pad": "npm:1.3.0" },
        code: 'import leftPad from "left-pad"; return leftPad("7", 3, "0");',
      },
      execution: {
        status,
        terminalOutcome: isError ? "tool_error" : "success",
        isError,
        result: returnValue === undefined ? undefined : { details: { returnValue } },
      },
    }),
  };
}

function finalAgentMessage(content: string): ChatMessage {
  return {
    id: "final-agent-message",
    kind: "message",
    senderId: "agent",
    complete: true,
    content,
  };
}

function execution(messages: ChatMessage[]): TestExecutionResult {
  return {
    duration: 0,
    messages: [
      {
        id: "prompt",
        kind: "message",
        senderId: "user",
        complete: true,
        content: "Exercise an npm package.",
      },
      ...messages,
    ],
  } as TestExecutionResult;
}
