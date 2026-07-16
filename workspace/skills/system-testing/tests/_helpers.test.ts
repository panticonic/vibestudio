import { describe, expect, it } from "vitest";

import type { TestExecutionResult } from "../types.js";
import {
  completedToolNames,
  failedToolCalls,
  finalMessageHasField,
  finalMessageHasMarkerCount,
  finalMessageHasNumericField,
  incompleteToolCalls,
  noFailedInvocations,
  requireEvalResultEvidence,
  requireVcsEvidence,
} from "./_helpers.js";

function executionWithProjectedInvocation(
  status: string,
  terminalOutcome?: string,
  isError?: boolean
): TestExecutionResult {
  return {
    duration: 0,
    messages: [
      { kind: "message", senderId: "user", complete: true, content: "prompt" },
      {
        kind: "message",
        senderId: "agent",
        complete: true,
        contentType: "invocation",
        invocation: {
          id: "call-projected",
          name: "eval",
          status,
          terminalOutcome,
          isError,
          arguments: { code: "return true" },
        },
      },
    ],
  } as TestExecutionResult;
}

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

function executionWithInvocationResult(
  status: string,
  result: unknown,
  isError?: boolean
): TestExecutionResult {
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
          name: "eval",
          execution: {
            status,
            result,
            isError,
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

  it("normalizes flattened completed invocation cards", () => {
    const result = executionWithProjectedInvocation("complete", "success", false);
    expect(incompleteToolCalls(result)).toEqual([]);
    expect(completedToolNames(result)).toEqual(new Set(["eval"]));
  });

  it("normalizes flattened failed invocation cards", () => {
    const result = executionWithProjectedInvocation("error", "tool_error", true);
    expect(incompleteToolCalls(result)).toEqual([]);
    expect(failedToolCalls(result).map((call) => call.name)).toEqual(["eval"]);
  });

  it("accepts focused agent VCS tools as canonical operation evidence", () => {
    const result = executionWithProjectedInvocation("complete", "success", false);
    const invocation = result.messages[1]!.invocation!;
    invocation.name = "vcs";
    invocation.arguments = { operation: "compare", sourceEventId: "event:source" };
    expect(requireVcsEvidence(result, ["vcs.compare"])).toEqual({
      passed: true,
      reason: undefined,
    });
    expect(requireVcsEvidence(result, ["vcs.integrate"]).passed).toBe(false);

    invocation.name = "provenance";
    invocation.arguments = { target: "command:1" };
    expect(requireVcsEvidence(result, ["vcs.inspect", "vcs.neighbors"])).toEqual({
      passed: true,
      reason: undefined,
    });
  });

  it("classifies pending invocations as incomplete", () => {
    expect(
      incompleteToolCalls(executionWithInvocation("pending")).map((call) => call.name)
    ).toEqual(["grep"]);
  });

  it("accepts marker followed by numeric count", () => {
    expect(
      finalMessageHasMarkerCount(
        executionWithFinalAgentMessage("WORKER_LIST_OK: 0"),
        "WORKER_LIST_OK"
      )
    ).toEqual({
      passed: true,
      reason: undefined,
    });
  });

  it("accepts marker followed by literal count and numeric count", () => {
    expect(
      finalMessageHasMarkerCount(
        executionWithFinalAgentMessage("WORKER_SOURCES_OK count 30"),
        "WORKER_SOURCES_OK"
      )
    ).toEqual({
      passed: true,
      reason: undefined,
    });
  });

  it("rejects marker count values that are not numeric", () => {
    expect(
      finalMessageHasMarkerCount(
        executionWithFinalAgentMessage("OAUTH_PROVIDERS_OK count=unknown"),
        "OAUTH_PROVIDERS_OK"
      ).passed
    ).toBe(false);
  });

  it("accepts explicit field values in final messages", () => {
    expect(
      finalMessageHasField(executionWithFinalAgentMessage("PANEL_OPEN_OK handle=slot-1"), "handle")
    ).toEqual({
      passed: true,
      reason: undefined,
    });
  });

  it("accepts explicit numeric fields in final messages", () => {
    expect(
      finalMessageHasNumericField(
        executionWithFinalAgentMessage("PANEL_SCREENSHOT_OK bytes=135731"),
        "bytes"
      )
    ).toEqual({
      passed: true,
      reason: undefined,
    });
  });

  it("reports failed invocation cards even when a final marker exists", () => {
    expect(
      failedToolCalls(
        executionWithInvocationResult("error", { error: "No CDP-capable host is available" }, true)
      ).map((call) => call.name)
    ).toEqual(["eval"]);
  });

  it("does not make settled tool failures fatal to validation", () => {
    expect(
      noFailedInvocations(
        executionWithInvocationResult("error", { error: "No CDP-capable host is available" }, true)
      )
    ).toEqual({
      passed: true,
      reason: "Observed failed tool calls: eval:No CDP-capable host is available",
    });
  });

  it("requires protocol evidence from successful eval results", () => {
    const result = executionWithInvocationResult("complete", {
      kind: "mutated",
      decisionIds: ["decision-1"],
    });

    expect(requireEvalResultEvidence(result, ["mutated", "decisionIds"])).toEqual({
      passed: true,
      reason: undefined,
    });
    expect(requireEvalResultEvidence(result, ["sourceBasis"]).passed).toBe(false);
  });
});
