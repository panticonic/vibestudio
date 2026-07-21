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

  it("accepts the self-cleaning disposable publish result and rejects claims without it", () => {
    const test = gitInteropTests.find(({ name }) => name === "git-publish-local-remote")!;
    const published = {
      repoPath: "projects/example",
      branch: "main",
      exported: 2,
      pushed: true,
      commitCount: 2,
      headCommit: "abc123",
    };
    const call = invocation(
      "publish",
      "eval",
      { code: "return await git.publishToDisposableRemote('projects/example');" },
      { details: { returnValue: published } }
    );
    const final =
      "Published and pushed projects/example to the disposable remote; it received 2 commits and the one-call operation cleaned it up.";
    expect(test.validate(execution(final, [call]))).toEqual({ passed: true });
    expect(test.validate(execution(final))).toMatchObject({ passed: false });
  });

  it("identity-joins semantic events to external Git commits", () => {
    const test = gitInteropTests.find(({ name }) => name === "git-commit-mapping")!;
    const rows = [{ gitSha: "abc123", eventId: "event:one", summary: "Initial export" }];
    const call = invocation(
      "mapping",
      "eval",
      { code: "return await git.commitMapping('projects/example');" },
      { details: { returnValue: rows } }
    );
    expect(
      test.validate(
        execution("There is 1 mapping: workspace event event:one maps to Git commit abc123.", [
          call,
        ])
      )
    ).toEqual({ passed: true });
    expect(test.validate(execution("There is 1 mapping.", [call])).passed).toBe(false);
  });

  it("requires an exact unpublished Git candidate joined to its semantic import boundary", () => {
    const test = gitInteropTests.find(({ name }) => name === "git-import-project")!;
    expect(test.prompt).toBe(
      "Can you bring a small credential-free Git project into this workspace and tell me where it landed and whether it is already published?"
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
    const final = `The Git project landed at ${imported.path}; its imported candidate ${imported.candidate.eventId} is not yet published.`;

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
    expect(
      test.validate(execution("The Git import is unavailable in this deployment.")).passed
    ).toBe(false);
  });
});
