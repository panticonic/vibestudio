import { describe, expect, it } from "vitest";

import type { TestExecutionResult } from "../types.js";
import { gitInteropTests } from "./git-interop.js";

function invocation(id: string, name: string, args: Record<string, unknown>, result: unknown) {
  return {
    kind: "message" as const,
    senderId: "agent",
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
      { kind: "message", senderId: "agent", complete: true, content: final },
    ],
  } as TestExecutionResult;
}

describe("Git interop agentic validators", () => {
  it("requires an exact unpublished Git candidate joined to its semantic import boundary", () => {
    const test = gitInteropTests.find(({ name }) => name === "git-import-project")!;
    expect(test.prompt).toBe(
      "Can you bring a small credential-free Git project into this workspace and tell me where it landed and whether it is already published? Finish with GIT_IMPORT_OK."
    );
    expect(test.prompt).not.toMatch(
      /importProject|upstreamStatus|candidate|contextId|eventId|importSnapshot|provenance/iu
    );

    const imported = {
      path: "projects/example",
      remote: { name: "origin", url: "https://example.test/import.git", branch: "main" },
      candidate: {
        contextId: "git-bridge:projects/example",
        eventId: "event:git-import",
        changed: true,
      },
    };
    const status = {
      repoPath: imported.path,
      remote: "origin",
      branch: "main",
      autoPush: false,
      state: "integration-required",
      aheadBy: 0,
      behindBy: 0,
      candidate: {
        contextId: imported.candidate.contextId,
        eventId: imported.candidate.eventId,
      },
    };
    const snapshot = {
      sourceKind: "git",
      sourceUri: imported.remote.url,
      snapshotRevision: "a".repeat(40),
      snapshotDigest: `snapshot:${"b".repeat(64)}`,
      targetRepositoryIds: ["repository:git-import"],
    };
    const gitCall = invocation(
      "git-import",
      "eval",
      {
        code: "const imported = await git.importProject(request); const status = await git.upstreamStatus([imported.path]); return { imported, status };",
      },
      { imported, status: [status] }
    );
    const inspections = [
      invocation(
        "inspect-event",
        "provenance",
        {},
        {
          node: {
            kind: "event",
            value: {
              eventId: imported.candidate.eventId,
              kind: "commit",
              commandId: "command:git-import",
              applicationIds: ["application:git-import"],
            },
          },
        }
      ),
      invocation(
        "inspect-application",
        "provenance",
        {},
        {
          node: {
            kind: "application",
            value: {
              applicationId: "application:git-import",
              workUnitId: "work-unit:git-import",
            },
          },
        }
      ),
      invocation(
        "inspect-work",
        "provenance",
        {},
        {
          node: {
            kind: "work-unit",
            value: {
              workUnitId: "work-unit:git-import",
              commandId: "command:git-import",
              kind: "import",
              intentSummary: "Import the requested Git project",
              externalSnapshot: snapshot,
            },
          },
        }
      ),
    ];
    const final = `GIT_IMPORT_OK ${imported.path} candidate ${imported.candidate.eventId} is unpublished`;

    expect(test.validate(execution(final, [gitCall, ...inspections]))).toEqual({
      passed: true,
      reason: undefined,
    });
    expect(
      test.validate(
        execution(final, [
          invocation(
            "source-token-only",
            "eval",
            {
              code: "await git.importProject(request); await git.upstreamStatus([]);",
            },
            { imported: true }
          ),
          ...inspections,
        ])
      ).passed
    ).toBe(false);
    expect(test.validate(execution(final, [gitCall])).passed).toBe(false);

    const mismatchedStatus = structuredClone(status);
    mismatchedStatus.candidate.eventId = "event:other";
    expect(
      test.validate(
        execution(final, [
          {
            ...gitCall,
            invocation: {
              ...gitCall.invocation,
              execution: {
                ...gitCall.invocation.execution,
                result: { imported, status: [mismatchedStatus] },
              },
            },
          },
          ...inspections,
        ])
      ).passed
    ).toBe(false);

    const wrongWork = structuredClone(inspections);
    const workResult = wrongWork[2]!.invocation.execution.result as {
      node: { value: { externalSnapshot: typeof snapshot } };
    };
    workResult.node.value.externalSnapshot.sourceKind = "generated";
    expect(test.validate(execution(final, [gitCall, ...wrongWork])).passed).toBe(false);
    expect(test.validate(execution("GIT_IMPORT_UNAVAILABLE local import unavailable")).passed).toBe(
      false
    );
  });
});
