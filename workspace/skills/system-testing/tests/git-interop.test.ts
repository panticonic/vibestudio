import { describe, expect, it } from "vitest";

import type { TestExecutionResult } from "../types.js";
import { gitInteropTests } from "./git-interop.js";

function invocation(id: string, name: string, args: Record<string, unknown>, result: unknown) {
  return {
    kind: "message" as const,
    senderId: "agent",
    senderMetadata: { type: "agent" },
    complete: true,
    contentType: "invocation" as const,
    invocation: {
      id,
      name,
      arguments: args,
      execution: { status: "complete", isError: false, result },
    },
  };
}

function execution(
  final: string,
  calls: ReturnType<typeof invocation>[] = []
): TestExecutionResult {
  return {
    duration: 0,
    messages: [
      { kind: "message", senderId: "user", complete: true, content: "prompt" },
      ...calls,
      {
        kind: "message",
        senderId: "agent",
        senderMetadata: { type: "agent" },
        complete: true,
        content: final,
      },
    ],
  } as TestExecutionResult;
}

describe("Git interop agentic validators", () => {
  it("requires upstream prose to cite the canonical status rows", () => {
    const test = gitInteropTests.find(({ name }) => name === "git-upstream-status")!;
    const rows = [
      {
        repoPath: "projects/example",
        remote: "origin",
        branch: "main",
        autoPush: false,
        state: "ahead",
        aheadBy: 2,
        behindBy: 0,
      },
    ];
    const call = invocation(
      "status",
      "eval",
      { code: "return await git.upstreamStatus([]);" },
      { details: { returnValue: rows } }
    );
    expect(
      test.validate(
        execution("1 tracked repository: projects/example is ahead of origin by 2 commits.", [call])
      )
    ).toEqual({ passed: true });
    expect(test.validate(execution("1 repository is in sync.", [call])).passed).toBe(false);
  });
});
