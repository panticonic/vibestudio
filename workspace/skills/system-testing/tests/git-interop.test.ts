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
    const boundedProjection = invocation(
      "bounded-status",
      "eval",
      {
        code:
          "const statuses = await git.upstreamStatus([]); return statuses.map(s => ({ repo: s.repoPath, state: s.state, remote: s.remote, branch: s.branch }));",
      },
      {
        details: {
          returnValue: [
            {
              repo: "projects/example",
              state: "not-materialized",
              remote: "origin",
              branch: "main",
            },
          ],
        },
      }
    );
    expect(
      test.validate(
        execution("1 tracked repository: projects/example is not-materialized.", [
          boundedProjection,
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
    const authorityPolicy = test.authorityPolicy;
    if (!authorityPolicy || typeof authorityPolicy === "function") {
      throw new Error("expected a static Git publication authority policy");
    }
    expect(authorityPolicy.authority).toContainEqual({
      ruleId: "publish-git-config",
      capability: { kind: "exact", key: "workspace-main-advance" },
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
      invocation("commit-1", "vcs", { operation: "commit", message: "first" }, {}),
      invocation("gad-push-1", "vcs", { operation: "push" }, {}),
      firstGit,
      invocation("edit-2", "edit", { path: "packages/example/src/index.ts" }, {}),
      invocation("commit-2", "vcs", { operation: "commit", message: "second" }, {}),
      invocation("gad-push-2", "vcs", { operation: "push" }, {}),
      secondGit,
    ];
    const final = "After the push, the disposable remote was at def456 and was cleaned up.";
    expect(test.validate(execution(final, managedCalls))).toEqual({
      passed: true,
      reason: undefined,
    });
    expect(
      test.validate(
        execution(
          "After the push, the same remote advanced to def456 and the repository is local-only.",
          managedCalls
        )
      )
    ).toEqual({
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
      invocation("commit", "vcs", { operation: "commit", message: "mapping milestone" }, {}),
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
        execution("There is 1 mapping: workspace event event:one maps to Git commit abc123.", [
          ...managed.slice(0, 3),
          projected,
        ])
      )
    ).toEqual({ passed: true });

    const consoleObserved = invocation(
      "console-mapping",
      "eval",
      {
        code: [
          "const published = await git.publishToDisposableRemote('packages/example');",
          "const mapping = await git.commitMapping('packages/example');",
          'console.log("PUBLISH_OK", JSON.stringify(published));',
          'console.log("MAPPING_JSON", JSON.stringify(mapping));',
        ].join(" "),
      },
      {
        details: {
          success: true,
          console: [
            `PUBLISH_OK ${JSON.stringify(published)}`,
            `MAPPING_JSON ${JSON.stringify(rows)}`,
          ].join("\n"),
        },
      }
    );
    expect(
      test.validate(
        execution("There is 1 mapping: workspace event event:one maps to Git commit abc123.", [
          ...managed.slice(0, 3),
          consoleObserved,
        ])
      )
    ).toEqual({ passed: true });
    const naturallyProjected = invocation(
      "naturally-projected-mapping",
      "eval",
      {
        code: [
          "const published = await git.publishToDisposableRemote('packages/example');",
          "const mapping = await git.commitMapping('packages/example');",
          "return { published, count: mapping.length, first: mapping[0] };",
        ].join(" "),
      },
      {
        details: {
          returnValue: {
            published,
            count: 1,
            first: rows[0],
          },
        },
      }
    );
    expect(
      test.validate(
        execution(
          "There is 1 mapping: workspace event event:one maps to Git commit abc123.",
          [...managed.slice(0, 3), naturallyProjected]
        )
      )
    ).toEqual({ passed: true });
    const headedProjection = invocation(
      "headed-mapping",
      "eval",
      {
        code: [
          "const published = await git.publishToDisposableRemote('packages/example');",
          "const mapping = await git.commitMapping('packages/example');",
          "return { published, mappingCount: mapping.length, head: mapping[0] };",
        ].join(" "),
      },
      {
        details: {
          returnValue: {
            published,
            mappingCount: 1,
            head: rows[0],
          },
        },
      }
    );
    expect(
      test.validate(
        execution(
          "There is 1 mapping: workspace event event:one maps to Git commit abc123.",
          [...managed.slice(0, 3), headedProjection]
        )
      )
    ).toEqual({ passed: true });
    expect(
      test.validate(
        execution(
          "There is 1 mapping: workspace event event:one maps to Git commit abc123.",
          [
            managed[0]!,
            invocation("commit-shorthand", "vcs", { message: "mapping milestone" }, {}),
            ...managed.slice(2),
          ]
        )
      )
    ).toEqual({ passed: true });
  });

  it("requires an exact unpublished Git candidate joined to its semantic import boundary", () => {
    const test = gitInteropTests.find(({ name }) => name === "git-import-project")!;
    expect(test.orchestrate).toBeTypeOf("function");
    expect(test.workspaceRepoFixture).toMatchObject({
      kind: "buildable-package",
      section: "packages",
    });
    expect(test.expectedToolFailures).toBeUndefined();

    const remote = {
      id: "remote:import",
      name: "import-fixture",
      url: "https://example.test/import.git",
      branch: "main",
      expiresAt: Date.now() + 60_000,
    };
    const inspected = { ...remote, headCommit: "abc123", commitCount: 1 };
    const imported = {
      path: "projects/example",
      remote: { name: "origin", url: remote.url, branch: remote.branch },
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
    const managed = [
      invocation("edit", "edit", { path: "packages/example/src/index.ts" }, {}),
      invocation("commit", "vcs", { message: "generated import fixture" }, {}),
      invocation("gad-push", "vcs", { operation: "push" }, {}),
    ];
    const lifecycleCode = [
      "const remote = await git.createDisposableRemote({ name: 'import-fixture' });",
      "await git.pushDisposableRemote(sourcePath, remote.url, remote.branch);",
      "const inspected = await git.inspectDisposableRemote(remote.url);",
      "const imported = await git.importProject(request);",
      "const status = await git.upstreamStatus([imported.path], { fetch: false });",
      "await git.detachUpstream(imported.path, { forgetRemote: true });",
      "const removed = await git.removeDisposableRemote(remote.url);",
      "return { remote, inspected, imported, status, removed };",
    ].join(" ");
    const lifecycleResult = {
      remote,
      inspected,
      imported,
      status: [status],
      removed: { removed: true },
    };
    const selfVerifiedLifecycleResult = {
      ...lifecycleResult,
      imported: selfVerifiedImport,
    };

    const lifecycleCall = invocation(
      "git-import",
      "eval",
      { code: lifecycleCode },
      { details: { returnValue: lifecycleResult } }
    );
    const unrelatedEarlierRemote = invocation(
      "earlier-disposable",
      "eval",
      { code: "return await git.createDisposableRemote();" },
      {
        details: {
          returnValue: {
            ...remote,
            id: "remote:unrelated",
            url: "https://example.test/unrelated.git",
          },
        },
      }
    );
    expect(
      test.validate(
        execution(final, [...managed, unrelatedEarlierRemote, lifecycleCall, ...inspections])
      )
    ).toEqual({
      passed: true,
      reason: undefined,
    });
    expect(
      test.validate(
        execution(
          `Imported path: \`${imported.path}\`\nCandidate event ID: \`${imported.candidate.eventId}\`\nPublished: **No**`,
          [...managed, lifecycleCall, ...inspections]
        )
      )
    ).toEqual({
      passed: true,
      reason: undefined,
    });
    expect(
      test.validate(
        execution(
          `Imported path: \`${imported.path}\`\nCandidate event ID: \`${imported.candidate.eventId}\`\n**Published?** No`,
          [...managed, lifecycleCall, ...inspections]
        )
      )
    ).toEqual({
      passed: true,
      reason: undefined,
    });
    const selfVerifiedGitCall = invocation(
      "git-import-self-verified",
      "eval",
      { code: lifecycleCode },
      { details: { returnValue: selfVerifiedLifecycleResult } }
    );
    expect(test.validate(execution(final, [...managed, selfVerifiedGitCall]))).toEqual({
      passed: true,
      reason: undefined,
    });
    const rawRpcGitCall = invocation(
      "git-import-raw-rpc",
      "eval",
      {
        code: [
          "const remote = await rpc.call('main', 'gitInterop.createDisposableRemote', [options]);",
          "await rpc.call('main', 'gitInterop.pushDisposableRemote', [sourcePath, remote.url, remote.branch]);",
          "const inspected = await rpc.call('main', 'gitInterop.inspectDisposableRemote', [remote.url]);",
          "const imported = await rpc.call('main', 'gitInterop.importProject', [request]);",
          "const status = await rpc.call('main', 'gitInterop.upstreamStatus', [[imported.path]]);",
          "await rpc.call('main', 'gitInterop.detachUpstream', [imported.path, { forgetRemote: true }]);",
          "const removed = await rpc.call('main', 'gitInterop.removeDisposableRemote', [remote.url]);",
          "return { remote, inspected, imported, status, removed };",
        ].join(" "),
      },
      { details: { returnValue: lifecycleResult } }
    );
    expect(test.validate(execution(final, [...managed, rawRpcGitCall, ...inspections]))).toEqual({
      passed: true,
      reason: undefined,
    });
    expect(
      test.validate(
        execution(
          `The Git project landed at ${imported.path}; its imported candidate is not yet published.`,
          [...managed, lifecycleCall, ...inspections]
        )
      ).passed
    ).toBe(false);
    expect(
      test.validate(
        execution(
          `The Git project landed at ${imported.path}; its imported candidate event:other is not yet published.`,
          [...managed, lifecycleCall, ...inspections]
        )
      ).passed
    ).toBe(false);
    expect(
      test.validate(
        execution(final, [
          ...managed,
          invocation("source-token-only", "eval", { code: lifecycleCode }, {
            details: {
              returnValue: {
                remote,
                inspected,
                imported: true,
                removed: { removed: true },
              },
            },
          }),
          ...inspections,
        ])
      ).passed
    ).toBe(false);
    expect(test.validate(execution(final, [...managed, lifecycleCall])).passed).toBe(false);

    const mismatchedStatus = structuredClone(status);
    mismatchedStatus.candidate.eventId = "event:other";
    expect(
      test.validate(
        execution(final, [
          ...managed,
          {
            ...lifecycleCall,
            invocation: {
              ...lifecycleCall.invocation,
              execution: {
                ...lifecycleCall.invocation.execution,
                result: {
                  details: {
                    returnValue: { ...lifecycleResult, status: [mismatchedStatus] },
                  },
                },
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
    expect(
      test.validate(execution(final, [...managed, lifecycleCall, ...wrongWork])).passed
    ).toBe(false);
    expect(
      test.validate(execution("The Git import is unavailable in this deployment.")).passed
    ).toBe(false);
  });
});
