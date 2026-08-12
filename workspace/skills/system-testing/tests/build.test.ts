import { describe, expect, it } from "vitest";

import type { ChatMessage } from "@workspace/agentic-core";
import type { TestExecutionResult } from "../types.js";
import { buildTests } from "./build.js";

const npmTest = buildTests.find((test) => test.name === "build-npm-package")!;
const performanceTest = buildTests.find((test) => test.name === "build-performance-profile")!;

describe("build performance validation", () => {
  it("accepts a bounded exact-build profile with verified cache evidence", () => {
    const result = execution([
      performanceEvalInvocation({
        version: 1,
        source: "panels/example",
        ref: "ctx:context-1",
        firstRun: { elapsedMs: 21, cacheState: "preexisting" },
        verifiedCacheRun: { elapsedMs: 2, sameBuildKeys: true },
        targets: [
          {
            buildKey: "build-key",
            artifactBytes: 1_024,
            executableModuleCount: 3,
            executableSourceBytes: 2_048,
          },
        ],
      }),
      finalAgentMessage("The first observed path took 21 ms and the verified cache took 2 ms."),
    ]);

    expect(performanceTest.validate(result)).toEqual({ passed: true, reason: undefined });
  });

  it("rejects prose or partial timing without the bounded attribution record", () => {
    const result = execution([
      performanceEvalInvocation({ elapsedMs: 2, sameBuildKeys: true }),
      finalAgentMessage("The cached build was fast and all keys matched."),
    ]);

    expect(performanceTest.validate(result)).toMatchObject({ passed: false });
  });
});

describe("build npm package validation", () => {
  it("pregrants the expected npm dependency inspection prompt", () => {
    expect(npmTest.authorityPolicy).toEqual({
      authority: [
        {
          ruleId: "inspect-npm-dependency",
          capability: { kind: "exact", key: "workspace.dependencies.inspect" },
          resource: { kind: "exact", key: "workspace.dependencies.inspect" },
          tier: "gated",
          decision: "once",
        },
      ],
    });
  });

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
    senderMetadata: { type: "agent" },
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

function performanceEvalInvocation(returnValue: unknown): ChatMessage {
  return {
    id: "eval-performance",
    kind: "message",
    senderId: "agent",
    senderMetadata: { type: "agent" },
    complete: true,
    contentType: "invocation",
    content: JSON.stringify({
      id: "call-eval-performance",
      name: "eval",
      arguments: {
        code: `
          import { profileBuild } from "@workspace/testkit";
          return await profileBuild("panels/example", { verifyCache: true });
        `,
      },
      execution: {
        status: "complete",
        terminalOutcome: "success",
        isError: false,
        result: { details: { returnValue } },
      },
    }),
  };
}

function finalAgentMessage(content: string): ChatMessage {
  return {
    id: "final-agent-message",
    kind: "message",
    senderId: "agent",
    senderMetadata: { type: "agent" },
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
