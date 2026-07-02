import { describe, expect, it } from "vitest";

import type { ChatMessage } from "@workspace/agentic-core";
import type { TestExecutionResult } from "../types.js";
import { smokeTests } from "./smoke.js";

function invocationMessage(name: string, status: string, isError = false): ChatMessage {
  return {
    id: `invocation-message-${name}-${status}-${isError ? "error" : "ok"}`,
    kind: "message",
    senderId: "agent",
    complete: true,
    contentType: "invocation",
    content: JSON.stringify({
      id: `call-${name}-${status}-${isError ? "error" : "ok"}`,
      name,
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
    id: `final-agent-message-${content.slice(0, 24).replace(/\W+/g, "-")}`,
    kind: "message",
    senderId: "agent",
    complete: true,
    content,
  };
}

function execution(messages: TestExecutionResult["messages"]): TestExecutionResult {
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
    toolFailures: [
      {
        name: "write",
        status: "error",
        terminalOutcome: "tool_error",
        error: "recovered write failure",
        source: "message",
      },
    ],
  } as TestExecutionResult;
}

describe("smoke test validation", () => {
  it("allows recovered tool failures in the file write/read smoke", () => {
    const test = smokeTests.find((entry) => entry.name === "fs-write-read");

    expect(
      test?.validate(
        execution([
          invocationMessage("write", "error", true),
          invocationMessage("write", "complete"),
          invocationMessage("read", "complete"),
          finalAgentMessage("Basic file write/read round-trip succeeded."),
        ])
      )
    ).toEqual({ passed: true, reason: undefined });
  });

  it("allows recovered tool failures in the file search/read smoke", () => {
    const test = smokeTests.find((entry) => entry.name === "file-search-read-tools");

    expect(
      test?.validate(
        execution([
          invocationMessage("write", "error", true),
          invocationMessage("write", "complete"),
          invocationMessage("find", "complete"),
          invocationMessage("grep", "complete"),
          invocationMessage("read", "complete"),
          finalAgentMessage("FIND_OK GREP_OK READ_OK agentic-file-tools-smoke"),
        ])
      )
    ).toEqual({ passed: true, reason: undefined });
  });
});
