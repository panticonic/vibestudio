import { describe, expect, it } from "vitest";
import type { TestExecutionResult } from "../types.js";
import { vcsTests } from "./vcs.js";

function invocation(
  id: string,
  name: string,
  args: Record<string, unknown>,
  details: Record<string, unknown>
) {
  return {
    kind: "message" as const,
    senderId: "agent",
    complete: true,
    contentType: "invocation" as const,
    invocation: {
      id,
      name,
      arguments: args,
      execution: {
        status: "complete",
        isError: false,
        result: { protocolContent: [], details },
      },
    },
  };
}

function execution(final: string, calls: ReturnType<typeof invocation>[]): TestExecutionResult {
  return {
    duration: 0,
    messages: [
      { kind: "message", senderId: "user", complete: true, content: "prompt" },
      ...calls,
      { kind: "message", senderId: "agent", complete: true, content: final },
    ],
  } as TestExecutionResult;
}

function mutation(applicationId: string, changeId: string) {
  return {
    storage: "vcs",
    vcsResult: {
      contextId: "context:test",
      workUnitId: `work:${applicationId}`,
      applicationId,
      changeCount: 1,
      changeIds: [changeId],
      incorporatedChangeCount: 0,
      incorporatedChangeIds: [],
      workingHead: { kind: "application", applicationId },
    },
  };
}

function commit(eventId: string, applicationIds: string[], sourceEventId: string | null = null) {
  return {
    result: {
      contextId: "context:test",
      event: { kind: "event", eventId },
      committedApplicationIds: applicationIds,
      integrationSourceEventId: sourceEventId,
    },
  };
}

function status(eventId: string) {
  return {
    operation: "status",
    result: {
      contextId: "context:test",
      committed: { kind: "event", eventId },
      workingHead: { kind: "event", eventId },
      clean: true,
      mainEventId: "event:main",
      mainRelation: "ahead",
      workingCounts: { applications: 0, workUnits: 0, changes: 0 },
    },
  };
}

describe("joined VCS scenario validators", () => {
  it("joins two application results through the whole-chain commit and final clean status", () => {
    const test = vcsTests.find(({ name }) => name === "vcs-edit-whole-chain-commit")!;
    const eventId = "event:whole-chain";
    const calls = [
      invocation(
        "edit:1",
        "edit",
        { path: "projects/demo/a.ts" },
        mutation("application:1", "change:1")
      ),
      invocation(
        "edit:2",
        "edit",
        { path: "projects/demo/a.ts" },
        mutation("application:2", "change:2")
      ),
      invocation(
        "commit",
        "commit",
        { message: "Two steps" },
        commit(eventId, ["application:1", "application:2"])
      ),
      invocation("status", "vcs", { operation: "status" }, status(eventId)),
    ];
    const final = `VCS_COMMIT_OK changes:2 event:${eventId} clean:true`;
    expect(test.validate(execution(final, calls))).toEqual({ passed: true, reason: undefined });

    const fabricated = [...calls];
    fabricated[2] = invocation(
      "commit",
      "commit",
      { message: "Two steps" },
      commit(eventId, ["application:1", "application:unrelated"])
    );
    expect(test.validate(execution(final, fabricated)).passed).toBe(false);
  });

  it("rejects publication evidence whose protected-main identity is not the committed event", () => {
    const test = vcsTests.find(({ name }) => name === "vcs-push")!;
    const eventId = "event:published";
    const calls = [
      invocation(
        "edit",
        "write",
        { path: "projects/demo/a.ts" },
        mutation("application:push", "change:push")
      ),
      invocation("commit", "commit", { message: "Publish" }, commit(eventId, ["application:push"])),
      invocation(
        "push",
        "vcs",
        { operation: "push" },
        {
          operation: "push",
          result: { eventId, mainEventId: eventId },
        }
      ),
    ];
    const final = `VCS_PUSH_OK event:${eventId} main:${eventId} match:true`;
    expect(test.validate(execution(final, calls))).toEqual({ passed: true, reason: undefined });

    const unjoined = [...calls];
    unjoined[2] = invocation(
      "push",
      "vcs",
      { operation: "push" },
      {
        operation: "push",
        result: { eventId, mainEventId: "event:other" },
      }
    );
    expect(test.validate(execution(final, unjoined)).passed).toBe(false);
  });

  it("joins source publication, decision, accounted compare, commit parent, and final push", () => {
    const test = vcsTests.find(({ name }) => name === "vcs-incremental-integration")!;
    const sourceEventId = "event:source";
    const integratedEventId = "event:integrated";
    const sourceChangeId = "change:source";
    const decisionId = "decision:source";
    const applicationId = "application:integration";
    const calls = [
      invocation(
        "source-push",
        "vcs",
        { operation: "push" },
        {
          operation: "push",
          result: { eventId: sourceEventId, mainEventId: sourceEventId },
        }
      ),
      invocation(
        "compare-open",
        "vcs",
        { operation: "compare", sourceEventId },
        {
          operation: "compare",
          result: {
            sourceEventId,
            target: { kind: "event", eventId: "event:local" },
            counts: { actionable: 1, conflicting: 0, blocked: 0 },
            changes: [
              {
                changeId: sourceChangeId,
                disposition: { status: "actionable", applicability: "applicable" },
              },
            ],
          },
        }
      ),
      invocation(
        "integrate",
        "vcs",
        {
          operation: "integrate",
          sourceEventId,
          decision: { kind: "adopted", sourceChangeIds: [sourceChangeId] },
        },
        {
          operation: "integrate",
          result: {
            applicationId,
            decisionId,
            workingHead: { kind: "application", applicationId },
          },
        }
      ),
      invocation(
        "compare-accounted",
        "vcs",
        { operation: "compare", sourceEventId },
        {
          operation: "compare",
          result: {
            sourceEventId,
            target: { kind: "application", applicationId },
            counts: { actionable: 0, conflicting: 0, blocked: 0 },
            changes: [
              {
                changeId: sourceChangeId,
                disposition: { status: "accounted", decisionIds: [decisionId] },
              },
            ],
          },
        }
      ),
      invocation(
        "commit",
        "commit",
        { message: "Integrate", integratesEventId: sourceEventId },
        commit(integratedEventId, [applicationId], sourceEventId)
      ),
      invocation(
        "push",
        "vcs",
        { operation: "push" },
        {
          operation: "push",
          result: { eventId: integratedEventId, mainEventId: integratedEventId },
        }
      ),
    ];
    const final = `VCS_INTEGRATE_OK incoming:accounted local:preserved pushed:true event:${integratedEventId}`;
    expect(test.validate(execution(final, calls))).toEqual({ passed: true, reason: undefined });

    const fabricated = structuredClone(calls);
    const details = (
      fabricated[3]!.invocation.execution.result as { details: Record<string, unknown> }
    ).details;
    const result = details["result"] as {
      changes: Array<{ disposition: { decisionIds: string[] } }>;
    };
    result.changes[0]!.disposition.decisionIds = ["decision:unrelated"];
    expect(test.validate(execution(final, fabricated)).passed).toBe(false);
  });
});
