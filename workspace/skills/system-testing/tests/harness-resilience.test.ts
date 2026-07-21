import { describe, expect, it } from "vitest";

import type { ChatMessage } from "@workspace/agentic-core";
import type { TestExecutionResult } from "../types.js";
import { harnessResilienceTests } from "./harness-resilience.js";

const thrownRecovery = harnessResilienceTests.find(
  (test) => test.name === "eval-thrown-error-then-continues"
)!;
const invalidArgsRecovery = harnessResilienceTests.find(
  (test) => test.name === "invalid-tool-args-visible-retry"
)!;

describe("harness resilience validation", () => {
  it("requires the intentional thrown eval to precede its successful recovery", () => {
    expect(
      thrownRecovery.validate(
        execution([
          invocation("eval", "error", true, "intentional failure"),
          invocation("eval", "complete", false, { recovered: true }),
          finalMessage("The deliberate error was visible, and the later evaluation succeeded."),
        ])
      )
    ).toEqual({ passed: true, reason: undefined });

    expect(
      thrownRecovery.validate(
        execution([
          invocation("eval", "complete", false, { recovered: true }),
          invocation("eval", "error", true, "intentional failure"),
          finalMessage("The deliberate error was visible, but no later evaluation succeeded."),
        ])
      ).passed
    ).toBe(false);
  });

  it("requires an invalid tool call to be followed by a successful tool call", () => {
    expect(
      invalidArgsRecovery.validate(
        execution([
          invocation("vcs", "error", true, "arguments failed schema validation"),
          invocation("vcs", "complete", false, { ok: true }),
          finalMessage("The invalid request was rejected and the corrected request succeeded."),
        ])
      )
    ).toEqual({ passed: true, reason: undefined });

    expect(
      invalidArgsRecovery.validate(
        execution([
          invocation("vcs", "error", true, "arguments failed schema validation"),
          finalMessage("The invalid request was rejected."),
        ])
      ).passed
    ).toBe(false);
  });
});

function invocation(
  name: string,
  status: "complete" | "error",
  isError: boolean,
  result: unknown
): ChatMessage {
  const arguments_ =
    name === "eval" && status === "error"
      ? { code: 'throw new Error("intentional failure")' }
      : name === "eval"
        ? { code: "return { recovered: true };" }
        : undefined;
  return {
    id: `${name}-${status}-${String(isError)}`,
    kind: "message",
    senderId: "agent",
    complete: true,
    contentType: "invocation",
    content: JSON.stringify({
      id: `call-${name}-${status}-${String(isError)}`,
      name,
      arguments: arguments_,
      execution: {
        status,
        terminalOutcome: isError ? "tool_error" : "success",
        isError,
        result:
          name === "eval" && status === "complete" ? { details: { returnValue: result } } : result,
      },
    }),
  };
}

function finalMessage(content: string): ChatMessage {
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
        content: "prompt",
      },
      ...messages,
    ],
  } as TestExecutionResult;
}
