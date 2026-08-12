import { describe, expect, it } from "vitest";
import type { TestExecutionResult } from "../types.js";
import { trustedUnitAuthoringTests } from "./trusted-unit-authoring.js";

interface Operation {
  name: string;
  arguments: Record<string, unknown>;
  details: unknown;
  status?: string;
  isError?: boolean;
}

function execution(operations: Operation[]) {
  return {
    duration: 1,
    messages: operations.map((operation, index) => ({
      id: `call-${index}`,
      senderId: "agent",
      kind: "message" as const,
      contentType: "invocation" as const,
      complete: true,
      content: "",
      invocation: {
        id: `call-${index}`,
        name: operation.name,
        arguments: operation.arguments,
        execution: {
          status: operation.status ?? "complete",
          isError: operation.isError ?? false,
          result: { details: operation.details },
        },
      },
    })),
  } as unknown as TestExecutionResult;
}

function mutation(unit: string, applicationId: string, contextId = "context:task"): Operation {
  return {
    name: "edit",
    arguments: { path: `${unit}/index.ts`, oldText: "before", newText: "after" },
    details: {
      storage: "vcs",
      vcsResult: {
        contextId,
        applicationId,
        changeCount: 1,
        changeIds: [`change:${applicationId}`],
        workingHead: { kind: "application", applicationId },
      },
    },
  };
}

function atomicMutation(
  unit: string,
  applicationId: string,
  contextId = "context:task"
): Operation {
  return {
    name: "apply_patch",
    arguments: {
      operations: [
        { kind: "replace", path: `${unit}/index.ts` },
        { kind: "replace", path: `${unit}/index.test.ts` },
      ],
    },
    details: {
      status: "applied",
      paths: [`${unit}/index.ts`, `${unit}/index.test.ts`],
      vcsResult: {
        contextId,
        applicationId,
        changeCount: 2,
        changeIds: [`change:${applicationId}:1`, `change:${applicationId}:2`],
        workingHead: { kind: "application", applicationId },
      },
    },
  };
}

function testVerification(unit: string, contextId = "context:task"): Operation {
  return {
    name: "verify",
    arguments: { operation: "test", target: unit },
    details: {
      operation: "test",
      target: unit,
      status: "passed",
      report: { contextId, target: unit, total: 1, passed: 1, failed: 0 },
    },
  };
}

function buildVerification(unit: string, contextId = "context:task"): Operation {
  return {
    name: "verify",
    arguments: { operation: "build", target: unit },
    details: {
      operation: "build",
      target: unit,
      status: "ok",
      receipt: {
        protocol: "build-verification-receipt.v1",
        contextId,
        ref: `ctx:${contextId}`,
        target: unit,
        status: "ok",
        unit: { repoPath: unit, kind: "fixture" },
      },
    },
  };
}

function commit(
  applicationIds: string[],
  contextId = "context:task",
  eventId = "event:repair"
): Operation {
  return {
    name: "vcs",
    arguments: { operation: "commit", message: "Repair the trusted unit" },
    details: {
      operation: "commit",
      result: {
        contextId,
        event: { kind: "event", eventId },
        committedApplicationIds: applicationIds,
      },
      status: {
        contextId,
        clean: true,
        committed: { kind: "event", eventId },
        workingHead: { kind: "event", eventId },
        workingCounts: { applications: 0, workUnits: 0, changes: 0 },
      },
    },
  };
}

function repairOperations(unit: string): Operation[] {
  return [
    mutation(unit, "application:repair"),
    testVerification(unit),
    buildVerification(unit),
    commit(["application:repair"]),
  ];
}

describe("trusted unit authoring evidence", () => {
  it("keeps the prompts user-level while causally proving extension and app repairs", () => {
    const [extension, app] = trustedUnitAuthoringTests;

    expect(extension!.validation).toBe("agent-evidence");
    expect(app!.validation).toBe("agent-evidence");
    expect(extension!.prompt).not.toMatch(/\b(?:build|commit|test|tool)\b/i);
    expect(app!.prompt).not.toMatch(/\b(?:build|commit|test|tool)\b/i);
    expect(extension!.validate(execution(repairOperations("extensions/example")))).toEqual({
      passed: true,
      reason: undefined,
    });
    expect(app!.validate(execution(repairOperations("apps/example")))).toEqual({
      passed: true,
      reason: undefined,
    });
  });

  it("accepts an atomic multi-file application and either verification order", () => {
    const unit = "extensions/example";
    const result = execution([
      atomicMutation(unit, "application:atomic"),
      buildVerification(unit),
      testVerification(unit),
      commit(["application:atomic"]),
    ]);

    expect(trustedUnitAuthoringTests[0]!.validate(result)).toEqual({
      passed: true,
      reason: undefined,
    });
  });

  it("rejects verification that preceded the repair mutation", () => {
    const unit = "extensions/example";
    const result = execution([
      testVerification(unit),
      buildVerification(unit),
      mutation(unit, "application:repair"),
      commit(["application:repair"]),
    ]);

    expect(trustedUnitAuthoringTests[0]!.validate(result)).toMatchObject({ passed: false });
  });

  it("rejects verification assembled across units or contexts", () => {
    const unit = "extensions/example";
    const wrongUnit = execution([
      mutation(unit, "application:repair"),
      testVerification("extensions/other"),
      buildVerification(unit),
      commit(["application:repair"]),
    ]);
    const wrongContext = execution([
      mutation(unit, "application:repair"),
      testVerification(unit, "context:other"),
      buildVerification(unit),
      commit(["application:repair"]),
    ]);

    expect(trustedUnitAuthoringTests[0]!.validate(wrongUnit)).toMatchObject({ passed: false });
    expect(trustedUnitAuthoringTests[0]!.validate(wrongContext)).toMatchObject({ passed: false });
  });

  it("requires the commit to consume the complete observed application chain in order", () => {
    const unit = "extensions/example";
    const operations = [
      mutation(unit, "application:first"),
      mutation(unit, "application:second"),
      testVerification(unit),
      buildVerification(unit),
    ];

    const omitted = execution([...operations, commit(["application:second"])]);
    const reordered = execution([
      ...operations,
      commit(["application:second", "application:first"]),
    ]);

    expect(trustedUnitAuthoringTests[0]!.validate(omitted)).toMatchObject({ passed: false });
    expect(trustedUnitAuthoringTests[0]!.validate(reordered)).toMatchObject({ passed: false });
  });

  it("requires the commit receipt itself to prove its exact clean event", () => {
    const unit = "extensions/example";
    const uncleanCommit = commit(["application:repair"]);
    (uncleanCommit.details as { status: Record<string, unknown> }).status["clean"] = false;
    const unrelatedCleanStatus: Operation = {
      name: "vcs",
      arguments: { operation: "status" },
      details: {
        operation: "status",
        result: {
          contextId: "context:task",
          clean: true,
          committed: { kind: "event", eventId: "event:repair" },
          workingHead: { kind: "event", eventId: "event:repair" },
          workingCounts: { applications: 0, workUnits: 0, changes: 0 },
        },
      },
    };
    const result = execution([
      mutation(unit, "application:repair"),
      testVerification(unit),
      buildVerification(unit),
      uncleanCommit,
      unrelatedCleanStatus,
    ]);

    expect(trustedUnitAuthoringTests[0]!.validate(result)).toMatchObject({ passed: false });
  });
});
