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
    operation: "commit",
    result: {
      contextId: "context:test",
      event: { kind: "event", eventId },
      committedApplicationIds: applicationIds,
      integrationSourceEventIds: [sourceEventId],
    },
    status: status(eventId).result,
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
      integrating: [],
    },
  };
}

describe("joined VCS scenario validators", () => {
  it("accepts natural status reporting only when backed by a canonical read-only status", () => {
    const test = vcsTests.find(({ name }) => name === "vcs-status-orientation")!;
    const call = invocation("status", "vcs", { operation: "status" }, status("event:current"));
    const report =
      "The context is clean and ahead of protected main event:main; both its committed and working identity are event:current.";

    expect(test.prompt).not.toMatch(/VCS_STATUS_OK|clean:|committed:|working:|relation:/u);
    expect(test.validate(execution(report, [call]))).toEqual({ passed: true });

    const mutating = invocation(
      "write",
      "write",
      { path: "projects/demo/a.ts" },
      mutation("application:unexpected", "change:unexpected")
    );
    expect(test.validate(execution(report, [call, mutating])).passed).toBe(false);
  });

  it("requires a true working-application comparison without an intervening commit", () => {
    const test = vcsTests.find(({ name }) => name === "vcs-local-working-compare")!;
    const compared = invocation(
      "compare:local",
      "vcs",
      { operation: "compare", view: "local" },
      {
        operation: "compare",
        result: {
          target: { kind: "event", eventId: "event:main" },
          source: { kind: "application", applicationId: "application:working" },
          coordinates: [{ coordinate: { kind: "file", id: "file:one" } }],
          intents: [{ intent: { tier: "stated", text: "Update the fixture" } }],
        },
      }
    );

    expect(test.validate(execution("The local comparison found the intended file update.", [compared])))
      .toEqual({ passed: true });
    const committed = invocation(
      "commit",
      "vcs",
      { operation: "commit", message: "Too early" },
      commit("event:committed", ["application:working"])
    );
    expect(
      test.validate(execution("The local comparison found the intended file update.", [committed, compared]))
        .passed
    ).toBe(false);
  });

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
        "vcs",
        { operation: "commit", message: "Two steps" },
        commit(eventId, ["application:1", "application:2"])
      ),
    ];
    const final = `Both related edits are now one clean milestone at ${eventId}.`;
    expect(test.validate(execution(final, calls))).toEqual({ passed: true, reason: undefined });

    // The clean state is canonical tool evidence, not a prose claim. A model
    // may summarize it naturally while the commit's atomic post-status still
    // proves the exact committed event is clean.
    const naturalFinal = `The complete two-step chain is committed at ${eventId}; the working tree is clean.`;
    expect(test.validate(execution(naturalFinal, calls))).toEqual({
      passed: true,
      reason: undefined,
    });

    const dirtyCalls = [...calls];
    dirtyCalls[2] = invocation(
      "commit",
      "vcs",
      { operation: "commit", message: "Two steps" },
      {
        ...commit(eventId, ["application:1", "application:2"]),
        status: {
          ...status(eventId).result,
          clean: false,
          workingCounts: { applications: 1, workUnits: 1, changes: 1 },
          integrating: [],
        },
      }
    );
    expect(test.validate(execution(naturalFinal, dirtyCalls)).passed).toBe(false);

    const fabricated = [...calls];
    fabricated[2] = invocation(
      "commit",
      "vcs",
      { operation: "commit", message: "Two steps" },
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
      invocation(
        "commit",
        "vcs",
        { operation: "commit", message: "Publish" },
        commit(eventId, ["application:push"])
      ),
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
    const final = `The committed milestone ${eventId} is now protected main.`;
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

  it("joins source publication, adopted identity, complete compare, commit parent, and final push", () => {
    const test = vcsTests.find(({ name }) => name === "vcs-incremental-integration")!;
    const sourceEventId = "event:source";
    const integratedEventId = "event:integrated";
    const sourceChangeId = "change:source";
    const decisionId = "decision:source";
    const applicationId = "application:integration";
    const calls = [
      invocation(
        "local-commit",
        "vcs",
        { operation: "commit", message: "Compatible local milestone" },
        commit("event:local", ["application:local"])
      ),
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
            source: { kind: "event", eventId: sourceEventId },
            target: { kind: "event", eventId: "event:local" },
            resolution: { complete: false, remainingCoordinateCount: 1, concluded: false },
            counts: { adopt: 1, convergent: 0, composed: 0, conflict: 0, resolved: 0 },
            coordinates: [
              {
                coordinate: { kind: "file", id: "file:source", paths: {} },
                status: "adopt",
                attribution: {
                  ours: [],
                  theirs: [{ changeId: sourceChangeId, workUnitId: "work:source" }],
                },
              },
            ],
          },
        }
      ),
      invocation(
        "merge",
        "vcs",
        {
          operation: "merge",
          sourceEventId,
        },
        {
          operation: "merge",
          result: {
            applicationId,
            decisionId,
            workingHead: { kind: "application", applicationId },
          },
        }
      ),
      invocation(
        "compare-complete",
        "vcs",
        { operation: "compare", sourceEventId },
        {
          operation: "compare",
          result: {
            source: { kind: "event", eventId: sourceEventId },
            target: { kind: "application", applicationId },
            resolution: { complete: true, remainingCoordinateCount: 0, concluded: true },
            counts: { adopt: 0, convergent: 0, composed: 0, conflict: 0, resolved: 1 },
            coordinates: [],
          },
        }
      ),
      invocation(
        "commit",
        "vcs",
        { operation: "commit", message: "Integrate" },
        commit(integratedEventId, [applicationId], sourceEventId)
      ),
      invocation("status", "vcs", { operation: "status" }, status(integratedEventId)),
      invocation(
        "push",
        "vcs",
        { operation: "push" },
        {
          operation: "push",
          result: { eventId: integratedEventId, mainEventId: integratedEventId },
        }
      ),
      invocation(
        "fresh-read",
        "read",
        { path: "projects/demo/collaborator.md" },
        {
          provenance: {
            status: "attached",
            episodes: [
              {
                arrival: {
                  mode: "arrived",
                  decision: { kind: "decision", decisionId },
                  parentIntents: [
                    {
                      workUnitId: "work:source",
                      role: "source",
                      intent: { tier: "stated", text: "Add collaborator note" },
                    },
                  ],
                },
              },
            ],
          },
        }
      ),
    ];
    const final =
      "The incoming and local compatible changes are both present in the clean published result.";
    expect(test.validate(execution(final, calls))).toEqual({ passed: true, reason: undefined });

    const fabricated = structuredClone(calls);
    const details = (
      fabricated[4]!.invocation.execution.result as { details: Record<string, unknown> }
    ).details;
    const result = details["result"] as { source: { eventId: string } };
    result.source.eventId = "event:unrelated";
    expect(test.validate(execution(final, fabricated)).passed).toBe(false);

    const unrelatedLocalTarget = structuredClone(calls);
    const compareDetails = (
      unrelatedLocalTarget[2]!.invocation.execution.result as { details: Record<string, unknown> }
    ).details;
    (compareDetails["result"] as { target: unknown }).target = {
      kind: "event",
      eventId: "event:not-a-local-commit",
    };
    expect(test.validate(execution(final, unrelatedLocalTarget)).passed).toBe(false);

    const dirty = structuredClone(calls);
    const statusDetails = (
      dirty[6]!.invocation.execution.result as { details: Record<string, unknown> }
    ).details;
    const statusResult = statusDetails["result"] as {
      clean: boolean;
      workingCounts: Record<string, number>;
    };
    statusResult.clean = false;
    statusResult.workingCounts = { applications: 1, workUnits: 1, changes: 1 };
    expect(test.validate(execution(final, dirty)).passed).toBe(false);
  });
});
