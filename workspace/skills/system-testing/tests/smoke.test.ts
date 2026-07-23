import { describe, expect, it } from "vitest";

import type { TestExecutionResult } from "../types.js";
import { smokeTests } from "./smoke.js";

function execution(
  readPath: string | null = "notes/marker.txt",
  searchRoot = ".",
  writtenContent = "agentic-file-tools-smoke"
): TestExecutionResult {
  const reportedPath = searchRoot === "notes" ? "marker.txt" : "notes/marker.txt";
  const invocations = [
    {
      id: "write",
      name: "write",
      status: "complete",
      isError: false,
      arguments: {
        path: "notes/marker.txt",
        content: writtenContent,
      },
      result: { ok: true },
    },
    {
      id: "grep",
      name: "grep",
      status: "complete",
      isError: false,
      arguments: { path: searchRoot, pattern: "agentic-file-tools-smoke" },
      result: { matches: [`${reportedPath}:1: agentic-file-tools-smoke`] },
    },
    ...(readPath === null
      ? []
      : [
          {
            id: "read",
            name: "read",
            status: "complete",
            isError: false,
            arguments: { path: readPath },
            result: { text: "agentic-file-tools-smoke" },
          },
        ]),
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

  it("accepts search paths reported relative to a scoped search root", () => {
    expect(test.validate(execution("notes/marker.txt", "notes")).passed).toBe(true);
  });

  it("accepts an exact write joined to exact grep evidence without a redundant read", () => {
    expect(test.validate(execution(null)).passed).toBe(true);
  });

  it("accepts a descriptive note when canonical grep evidence contains the marker", () => {
    expect(test.validate(execution(null, ".", "prefix agentic-file-tools-smoke suffix")).passed).toBe(
      true
    );
  });

  it("rejects content search evidence that does not identify the written path", () => {
    const result = execution();
    const grep = result.messages.find((message) => message.invocation?.name === "grep")?.invocation;
    if (grep) {
      (grep as unknown as { result: unknown }).result = {
        matches: ["notes/unrelated.txt:1"],
      };
    }
    expect(test.validate(result).passed).toBe(false);
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

  it("accepts static runtime imports as package-load evidence", () => {
    const buildService = smokeTests.find((candidate) => candidate.name === "build-service")!;
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
            arguments: {
              code: 'import * as runtime from "@workspace/runtime"; return Object.keys(runtime)',
            },
            result: { details: { success: true, returnValue: ["workers", "rpc"] } },
          },
        },
        {
          kind: "message",
          senderId: "agent",
          complete: true,
          content: "The module exports workers and rpc at runtime.",
        },
      ],
    } as TestExecutionResult;

    expect(buildService.validate(result)).toEqual({ passed: true, reason: undefined });
  });
});
