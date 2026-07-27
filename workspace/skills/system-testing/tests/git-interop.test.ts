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
    expect(
      test.validate(
        execution("One tracked repository: projects/example is ahead of origin by 2 commits.", [
          call,
        ])
      )
    ).toEqual({ passed: true });
    expect(test.validate(execution("1 repository is in sync.", [call])).passed).toBe(false);
  });

  it("requires two managed publications, two Git pushes, remote advancement, and cleanup", () => {
    const test = gitInteropTests.find(({ name }) => name === "git-publish-local-remote")!;
    expect(test.orchestrate).toBeTypeOf("function");
    expect(test.workspaceRepoFixture).toMatchObject({
      kind: "buildable-package",
      section: "packages",
    });
    expect(test.authorityPolicy?.authority).toContainEqual({
      ruleId: "publish-git-config",
      capability: "workspace-main-advance",
      resource: {
        kind: "exact",
        key: "workspace-source-change:meta:main",
      },
      tier: "gated",
      decision: "once",
    });
    const remote = {
      id: "remote:test",
      name: "follow-up",
      url: "http://127.0.0.1/git/remote:test",
      branch: "main",
      expiresAt: Date.now() + 60_000,
    };
    const first = { ...remote, commitCount: 1, headCommit: "abc123" };
    const second = { ...remote, commitCount: 2, headCommit: "def456" };
    const firstGit = invocation(
      "first-git-push",
      "eval",
      {
        code: [
          "const remote = await rpc.call('main', 'gitInterop.createDisposableRemote', [request]);",
          "await rpc.call('main', 'gitInterop.setSharedRemote', [repo, config]);",
          "await rpc.call('main', 'gitInterop.setUpstream', [repo, upstream]);",
          "await rpc.call('main', 'gitInterop.pushUpstream', [repo]);",
          "const inspected = await rpc.call('main', 'gitInterop.inspectDisposableRemote', [remote.id]);",
          "return { remote, inspected };",
        ].join(" "),
      },
      { details: { returnValue: { remote, inspected: first } } }
    );
    const secondGit = invocation(
      "second-git-push",
      "eval",
      {
        code: [
          "await rpc.call('main', 'gitInterop.pushUpstream', [repo]);",
          "const inspected = await rpc.call('main', 'gitInterop.inspectDisposableRemote', [remote.id]);",
          "await rpc.call('main', 'gitInterop.detachUpstream', [repo, { forgetRemote: true }]);",
          "const removed = await rpc.call('main', 'gitInterop.removeDisposableRemote', [remote.id]);",
          "return { inspected, removed };",
        ].join(" "),
      },
      { details: { returnValue: { inspected: second } } }
    );
    const managedCalls = [
      invocation("edit-1", "edit", { path: "packages/example/src/index.ts" }, {}),
      invocation("commit-1", "commit", { message: "first" }, {}),
      invocation("gad-push-1", "vcs", { operation: "push" }, {}),
      firstGit,
      invocation("edit-2", "edit", { path: "packages/example/src/index.ts" }, {}),
      invocation("commit-2", "commit", { message: "second" }, {}),
      invocation("gad-push-2", "vcs", { operation: "push" }, {}),
      secondGit,
    ];
    const final = "After the push, the disposable remote was at def456 and was cleaned up.";
    expect(test.validate(execution(final, managedCalls))).toEqual({
      passed: true,
      reason: undefined,
    });
    expect(test.validate(execution(final, managedCalls.slice(0, -1)))).toMatchObject({
      passed: false,
    });
  });

  it("identity-joins semantic events to external Git commits", () => {
    const test = gitInteropTests.find(({ name }) => name === "git-commit-mapping")!;
    expect(test.orchestrate).toBeTypeOf("function");
    expect(test.workspaceRepoFixture).toMatchObject({
      kind: "buildable-package",
      section: "packages",
    });
    const rows = [{ gitSha: "abc123", eventId: "event:one", summary: "Initial export" }];
    const published = {
      repoPath: "packages/example",
      branch: "main",
      exported: 1,
      pushed: true,
      commitCount: 1,
      headCommit: "abc123",
    };
    const publish = invocation(
      "publish",
      "eval",
      { code: "return await git.publishToDisposableRemote('packages/example');" },
      { details: { returnValue: published } }
    );
    const mapping = invocation(
      "mapping",
      "eval",
      { code: "return await git.commitMapping('projects/example');" },
      { details: { returnValue: rows } }
    );
    const managed = [
      invocation("edit", "edit", { path: "packages/example/src/index.ts" }, {}),
      invocation("commit", "commit", { message: "mapping milestone" }, {}),
      invocation("gad-push", "vcs", { operation: "push" }, {}),
      publish,
      mapping,
    ];
    expect(
      test.validate(
        execution(
          "There is 1 mapping: workspace event event:one maps to Git commit abc123.",
          managed
        )
      )
    ).toEqual({ passed: true });
    expect(test.validate(execution("There is 1 mapping.", managed)).passed).toBe(false);
    expect(test.validate(execution("There is 1 mapping.", [mapping])).passed).toBe(false);
    const projected = invocation(
      "projected-mapping",
      "eval",
      {
        code: [
          "const published = await git.publishToDisposableRemote('packages/example');",
          "const mapping = await git.commitMapping('packages/example');",
          "return { published, mappingCount: mapping.length, firstMapping: mapping[0] };",
        ].join(" "),
      },
      {
        details: {
          returnValue: {
            published,
            mappingCount: 1,
            firstMapping: rows[0],
          },
        },
      }
    );
    expect(
      test.validate(
        execution(
          "There is 1 mapping: workspace event event:one maps to Git commit abc123.",
          [...managed.slice(0, 3), projected]
        )
      )
    ).toEqual({ passed: true });
  });

  it("requires an exact unpublished Git candidate joined to its semantic import boundary", () => {
    const test = gitInteropTests.find(({ name }) => name === "git-import-project")!;
    expect(test.prompt).toBe(
      "Can you bring a small credential-free Git project into this workspace and tell me where it landed and whether it is already published?"
    );
    expect(test.prompt).not.toMatch(
      /importProject|upstreamStatus|candidate|contextId|eventId|importSnapshot|provenance/iu
    );
    expect(test.expectedToolFailures).toEqual([
      { name: "web_search", errorIncludes: "DDG_BLOCKED" },
    ]);

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
    const selfVerifiedImport = {
      ...structuredClone(imported),
      candidate: {
        ...structuredClone(imported.candidate),
        semanticEvidence: {
          applicationId: "application:git-import",
          workUnitId: "work-unit:git-import",
          externalSnapshot: snapshot,
        },
      },
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
    const selfVerifiedGitCall = invocation(
      "git-import-self-verified",
      "eval",
      {
        code: "const imported = await git.importProject(request); const status = await git.upstreamStatus([imported.path]); return { imported, status };",
      },
      { imported: selfVerifiedImport, status: [status] }
    );
    expect(test.validate(execution(final, [selfVerifiedGitCall]))).toEqual({
      passed: true,
      reason: undefined,
    });
    const rawRpcGitCall = invocation(
      "git-import-raw-rpc",
      "eval",
      {
        code: [
          "const imported = await rpc.call('main', 'gitInterop.importProject', [request]);",
          "const status = await rpc.call('main', 'gitInterop.upstreamStatus', [[imported.path]]);",
          "return { imported, status };",
        ].join(" "),
      },
      { imported, status: [status] }
    );
    expect(test.validate(execution(final, [rawRpcGitCall, ...inspections]))).toEqual({
      passed: true,
      reason: undefined,
    });
    expect(
      test.validate(
        execution(
          `The Git project landed at ${imported.path}; its imported candidate is not yet published.`,
          [gitCall, ...inspections]
        )
      ).passed
    ).toBe(false);
    expect(
      test.validate(
        execution(
          `The Git project landed at ${imported.path}; its imported candidate event:other is not yet published.`,
          [gitCall, ...inspections]
        )
      ).passed
    ).toBe(false);
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
