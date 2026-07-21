import { describe, expect, it } from "vitest";

import type { TestExecutionResult } from "../types.js";
import { smokeTests } from "./smoke.js";

function execution(readPath = "notes/marker.txt"): TestExecutionResult {
  const invocations = [
    {
      id: "write",
      name: "write",
      status: "complete",
      isError: false,
      arguments: {
        path: "notes/marker.txt",
        content: "agentic-file-tools-smoke",
      },
      result: { ok: true },
    },
    {
      id: "find",
      name: "find",
      status: "complete",
      isError: false,
      arguments: { path: ".", name: "marker.txt" },
      result: { paths: ["notes/marker.txt"] },
    },
    {
      id: "grep",
      name: "grep",
      status: "complete",
      isError: false,
      arguments: { path: ".", pattern: "agentic-file-tools-smoke" },
      result: { matches: ["notes/marker.txt:1"] },
    },
    {
      id: "read",
      name: "read",
      status: "complete",
      isError: false,
      arguments: { path: readPath },
      result: { text: "agentic-file-tools-smoke" },
    },
  ];
  return {
    duration: 0,
    messages: [
      { kind: "message", senderId: "user", complete: true, content: "prompt" },
      ...invocations.map((invocation) => ({
        kind: "message" as const,
        senderId: "agent",
        complete: true,
        contentType: "invocation" as const,
        invocation,
      })),
      {
        kind: "message",
        senderId: "agent",
        complete: true,
        content: "I found the note again and its contents matched.",
      },
    ],
  } as TestExecutionResult;
}

describe("smoke validators", () => {
  const test = smokeTests.find((candidate) => candidate.name === "file-search-read-tools")!;

  it("accepts natural reporting backed by an exact write/search/read chain", () => {
    expect(test.prompt).not.toMatch(/finish with|FIND_OK|GREP_OK|READ_OK/i);
    expect(test.validate(execution())).toEqual({ passed: true, reason: undefined });
  });

  it("rejects a read that is not joined to the written path", () => {
    expect(test.validate(execution("notes/unrelated.txt")).passed).toBe(false);
  });

  it("requires the factorial claim to agree with the canonical runtime result", () => {
    const factorial = smokeTests.find((candidate) => candidate.name === "eval-return-value")!;
    const result = {
      duration: 0,
      messages: [
        { kind: "message", senderId: "user", complete: true, content: "prompt" },
        {
          kind: "message",
          senderId: "agent",
          complete: true,
          contentType: "invocation",
          invocation: {
            id: "eval",
            name: "eval",
            status: "complete",
            isError: false,
            arguments: { code: "return [1, 2, 3, 4, 5].reduce((a, b) => a * b, 1)" },
            result: { details: { returnValue: 120 } },
          },
        },
        { kind: "message", senderId: "agent", complete: true, content: "The result is 120." },
      ],
    } as TestExecutionResult;

    expect(factorial.prompt).not.toMatch(/use eval/i);
    expect(factorial.validate(result).passed).toBe(true);
    result.messages.at(-1)!.content = "The result is 24.";
    expect(factorial.validate(result).passed).toBe(false);
  });
});
