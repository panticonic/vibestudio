import { describe, expect, it } from "vitest";

import type { ChatMessage } from "@workspace/agentic-core";
import type { TestExecutionResult } from "../types.js";
import { buildTests } from "./build.js";

const npmTest = buildTests.find((test) => test.name === "build-npm-package")!;

describe("build npm package validation", () => {
  it("rejects a success marker when the npm eval failed", () => {
    const result = execution([
      evalInvocation("error", true),
      finalAgentMessage("The npm install failed.\n\nBUILD_NPM_OK"),
    ]);

    expect(npmTest.validate(result)).toEqual({
      passed: false,
      reason: "Expected a successful eval invocation with an npm import-map entry",
    });
  });

  it("accepts a successful npm import eval", () => {
    const result = execution([
      evalInvocation("complete", false),
      finalAgentMessage("left-pad executed successfully.\n\nBUILD_NPM_OK"),
    ]);

    expect(npmTest.validate(result)).toEqual({ passed: true, reason: undefined });
  });

  it("allows an initial tool failure when a later npm eval succeeds", () => {
    const result = execution([
      evalInvocation("error", true),
      evalInvocation("complete", false),
      finalAgentMessage("Recovered and executed left-pad.\n\nBUILD_NPM_OK"),
    ]);

    expect(npmTest.validate(result)).toEqual({ passed: true, reason: undefined });
  });
});

function evalInvocation(status: "complete" | "error", isError: boolean): ChatMessage {
  return {
    id: `eval-${status}-${isError}`,
    kind: "message",
    senderId: "agent",
    complete: true,
    contentType: "invocation",
    content: JSON.stringify({
      id: `call-eval-${status}-${isError}`,
      name: "eval",
      arguments: {
        imports: { "left-pad": "npm:1.3.0" },
        code: 'import leftPad from "left-pad"; return leftPad("7", 3, "0");',
      },
      execution: {
        status,
        terminalOutcome: isError ? "tool_error" : "success",
        isError,
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
