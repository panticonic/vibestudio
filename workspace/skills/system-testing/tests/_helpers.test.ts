import { describe, expect, it } from "vitest";

import type { TestExecutionResult } from "../types.js";
import { finalMessageHasMarkerCount, incompleteToolCalls } from "./_helpers.js";

function executionWithInvocation(status: string, terminalOutcome?: string): TestExecutionResult {
  return {
    duration: 0,
    messages: [
      {
        kind: "message",
        senderId: "user",
        complete: true,
        content: "prompt",
      },
      {
        kind: "message",
        senderId: "agent",
        complete: true,
        contentType: "invocation",
        content: JSON.stringify({
          id: "call-1",
          name: "grep",
          execution: {
            status,
            terminalOutcome,
          },
        }),
      },
    ],
  } as TestExecutionResult;
}

function executionWithFinalAgentMessage(content: string): TestExecutionResult {
  return {
    duration: 0,
    messages: [
      {
        kind: "message",
        senderId: "user",
        complete: true,
        content: "prompt",
      },
      {
        kind: "message",
        senderId: "agent",
        complete: true,
        content,
      },
    ],
  } as TestExecutionResult;
}

describe("system-testing validation helpers", () => {
  it("does not classify terminal tool errors as incomplete invocations", () => {
    expect(incompleteToolCalls(executionWithInvocation("error", "tool_error"))).toEqual([]);
  });

  it("does not classify completed invocations as incomplete", () => {
    expect(incompleteToolCalls(executionWithInvocation("complete", "success"))).toEqual([]);
  });

  it("classifies pending invocations as incomplete", () => {
    expect(incompleteToolCalls(executionWithInvocation("pending")).map((call) => call.name)).toEqual([
      "grep",
    ]);
  });

  it("accepts marker followed by numeric count", () => {
    expect(
      finalMessageHasMarkerCount(
        executionWithFinalAgentMessage("WORKER_LIST_OK: 0"),
        "WORKER_LIST_OK",
      ),
    ).toEqual({
      passed: true,
      reason: undefined,
    });
  });

  it("accepts marker followed by literal count and numeric count", () => {
    expect(
      finalMessageHasMarkerCount(
        executionWithFinalAgentMessage("WORKER_SOURCES_OK count 30"),
        "WORKER_SOURCES_OK",
      ),
    ).toEqual({
      passed: true,
      reason: undefined,
    });
  });
});
