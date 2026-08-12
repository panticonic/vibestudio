import { describe, expect, it } from "vitest";

import type { ChatMessage } from "@workspace/agentic-core";
import type { TestExecutionResult } from "../types.js";
import { buildTests } from "./build.js";

const npmTest = buildTests.find((test) => test.name === "build-npm-package")!;
const performanceTest = buildTests.find((test) => test.name === "build-performance-profile")!;
const optimizationTest = buildTests.find((test) => test.name === "panel-performance-optimize")!;

describe("build performance validation", () => {
  it("gates the vague task on one causal measured optimization episode", () => {
    const result = optimizationExecution();

    expect(optimizationTest.validation).toBe("agent-evidence");
    expect(optimizationTest.validate(result)).toEqual({ passed: true, reason: undefined });
  });

  it("rejects profiles from another unit or context and profiles with no payload improvement", () => {
    expect(
      optimizationTest.validate(optimizationExecution({ afterUnit: "panels/other" }))
    ).toMatchObject({ passed: false });
    expect(
      optimizationTest.validate(optimizationExecution({ afterContextId: "context:other" }))
    ).toMatchObject({ passed: false });
    expect(
      optimizationTest.validate(optimizationExecution({ beforeBytes: 4_096, afterBytes: 4_096 }))
    ).toMatchObject({ passed: false });
  });

  it("rejects profiling or final build evidence observed in the wrong order", () => {
    const profiledAfterTheEdit = optimizationExecution();
    const [baseline] = profiledAfterTheEdit.messages.splice(1, 1);
    profiledAfterTheEdit.messages.splice(3, 0, baseline!);

    const buildBeforeTheFinalProfile = optimizationExecution();
    const [build] = buildBeforeTheFinalProfile.messages.splice(4, 1);
    buildBeforeTheFinalProfile.messages.splice(3, 0, build!);

    expect(optimizationTest.validate(profiledAfterTheEdit)).toMatchObject({ passed: false });
    expect(optimizationTest.validate(buildBeforeTheFinalProfile)).toMatchObject({ passed: false });
  });

  it("requires the commit to consume the mutation and the later clean status to match its event", () => {
    const wrongCommit = optimizationExecution({ committedApplicationIds: ["application:other"] });
    const wrongStatus = optimizationExecution({ statusEventId: "event:other" });
    const statusBeforeCommit = optimizationExecution();
    const [status] = statusBeforeCommit.messages.splice(6, 1);
    statusBeforeCommit.messages.splice(5, 0, status!);

    expect(optimizationTest.validate(wrongCommit)).toMatchObject({ passed: false });
    expect(optimizationTest.validate(wrongStatus)).toMatchObject({ passed: false });
    expect(optimizationTest.validate(statusBeforeCommit)).toMatchObject({ passed: false });
  });

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

function performanceEvalInvocation(returnValue: unknown, id = "performance"): ChatMessage {
  return {
    id: `eval-${id}`,
    kind: "message",
    senderId: "agent",
    senderMetadata: { type: "agent" },
    complete: true,
    contentType: "invocation",
    content: JSON.stringify({
      id: `call-eval-${id}`,
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

const OPTIMIZATION_UNIT = "panels/example";
const OPTIMIZATION_CONTEXT = "context:task";
const OPTIMIZATION_APPLICATION = "application:optimization";
const OPTIMIZATION_EVENT = "event:optimization";

function performanceProfile(
  bytes: number,
  unit = OPTIMIZATION_UNIT,
  contextId = OPTIMIZATION_CONTEXT
): Record<string, unknown> {
  return {
    version: 1,
    source: unit,
    ref: `ctx:${contextId}`,
    firstRun: { elapsedMs: 20, cacheState: "built-during-profile" },
    verifiedCacheRun: { elapsedMs: 2, sameBuildKeys: true },
    report: { repoPath: unit, status: "ok", builds: [{ target: "runtime" }] },
    targets: [
      {
        target: "runtime",
        buildKey: `build:${bytes}`,
        artifactBytes: bytes + 200,
        executableModuleCount: 1,
        executableSourceBytes: bytes + 100,
        bundleReport: {
          initial: { requests: 1, bytes, jsBytes: bytes, cssBytes: 0 },
        },
      },
    ],
  };
}

function managedOptimization(
  unit = OPTIMIZATION_UNIT,
  contextId = OPTIMIZATION_CONTEXT,
  applicationId = OPTIMIZATION_APPLICATION
): ChatMessage {
  return completedInvocation(
    "edit",
    { path: `${unit}/index.tsx`, oldText: "waste", newText: "concise" },
    {
      storage: "vcs",
      vcsResult: {
        contextId,
        applicationId,
        changeCount: 1,
        changeIds: ["change:optimization"],
        workingHead: { kind: "application", applicationId },
      },
    }
  );
}

function finalBuild(unit = OPTIMIZATION_UNIT, contextId = OPTIMIZATION_CONTEXT): ChatMessage {
  return completedInvocation(
    "verify",
    { operation: "build", target: unit },
    {
      operation: "build",
      target: unit,
      status: "ok",
      receipt: {
        protocol: "build-verification-receipt.v1",
        contextId,
        ref: `ctx:${contextId}`,
        target: unit,
        status: "ok",
        unit: { repoPath: unit, kind: "panel" },
      },
    }
  );
}

function optimizationCommit(
  applicationIds: string[] = [OPTIMIZATION_APPLICATION],
  contextId = OPTIMIZATION_CONTEXT,
  eventId = OPTIMIZATION_EVENT
): ChatMessage {
  return completedInvocation(
    "vcs",
    { operation: "commit", message: "Remove measured panel bundle waste" },
    {
      operation: "commit",
      result: {
        contextId,
        event: { kind: "event", eventId },
        committedApplicationIds: applicationIds,
      },
    }
  );
}

function finalCleanStatus(
  contextId = OPTIMIZATION_CONTEXT,
  eventId = OPTIMIZATION_EVENT
): ChatMessage {
  return completedInvocation(
    "vcs",
    { operation: "status" },
    {
      operation: "status",
      result: {
        contextId,
        clean: true,
        committed: { kind: "event", eventId },
        workingHead: { kind: "event", eventId },
        workingCounts: { applications: 0, workUnits: 0, changes: 0 },
      },
    }
  );
}

function optimizationExecution(
  options: {
    beforeBytes?: number;
    afterBytes?: number;
    afterUnit?: string;
    afterContextId?: string;
    committedApplicationIds?: string[];
    statusEventId?: string;
  } = {}
): TestExecutionResult {
  return execution([
    performanceEvalInvocation(
      performanceProfile(options.beforeBytes ?? 8_192),
      "optimization-before"
    ),
    managedOptimization(),
    performanceEvalInvocation(
      performanceProfile(options.afterBytes ?? 2_048, options.afterUnit, options.afterContextId),
      "optimization-after"
    ),
    finalBuild(),
    optimizationCommit(options.committedApplicationIds),
    finalCleanStatus(OPTIMIZATION_CONTEXT, options.statusEventId),
    finalAgentMessage("The panel now has the same visible output with less initial bundle waste."),
  ]);
}

function completedInvocation(
  name: string,
  arguments_: Record<string, unknown>,
  details: Record<string, unknown>
): ChatMessage {
  return {
    id: `${name}-${JSON.stringify(arguments_)}`,
    kind: "message",
    senderId: "agent",
    senderMetadata: { type: "agent" },
    complete: true,
    contentType: "invocation",
    content: JSON.stringify({
      id: `${name}-${JSON.stringify(arguments_)}`,
      name,
      arguments: arguments_,
      execution: {
        status: "complete",
        terminalOutcome: "success",
        isError: false,
        result: { details },
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
