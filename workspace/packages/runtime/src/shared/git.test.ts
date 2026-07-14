import { describe, expect, it, vi } from "vitest";
import { gitInteropMethods } from "@vibestudio/service-schemas/gitInterop";
import { createGitClient } from "./git.js";

describe("runtime Git client", () => {
  it("is exactly the canonical gitInterop service surface", () => {
    const rpc = { call: vi.fn() };
    const client = createGitClient(rpc as never);

    expect(Object.keys(client)).toEqual(Object.keys(gitInteropMethods));
  });

  it("routes every method through gitInterop with unchanged arguments and results", async () => {
    const results: Record<string, unknown> = {
      setSharedRemote: {},
      removeSharedRemote: {},
      setUpstream: {},
      removeUpstream: {},
      setAutoPush: {},
      upstreamStatus: [],
      pushUpstream: {
        exported: 0,
        headCommit: null,
        pushed: false,
        status: "in-sync",
      },
      pullUpstream: {
        behindBy: 0,
        aheadBy: 0,
        remoteBranchExists: false,
        incoming: [],
      },
      publishRepo: {
        repoPath: "projects/demo",
        provider: "github",
        remote: "origin",
        branch: "main",
        remoteUrl: "https://github.com/octo/demo.git",
        webUrl: "https://github.com/octo/demo",
        owner: "octo",
        exported: 0,
        headCommit: null,
        pushed: true,
      },
      pushDisposableRemote: {
        repoPath: "projects/demo",
        branch: "main",
        exported: 0,
        pushed: true,
        commitCount: 0,
        headCommit: null,
      },
      importProject: {
        operationId: "00000000-0000-4000-8000-000000000001",
        phase: "complete",
        path: "projects/demo",
        remote: {
          name: "origin",
          urlIdentity: "https://github.com/octo/demo",
          branch: "main",
        },
        stateHash: `state:${"a".repeat(64)}`,
        gitCommitSha: "b".repeat(40),
        changed: true,
        adoptedContextId: "ctx:imported",
      },
      completeWorkspaceDependencies: { imported: [], skipped: [], failed: [] },
    };
    const rpc = {
      call: vi.fn(async (_target: string, method: string) => {
        const name = method.slice("gitInterop.".length);
        return results[name];
      }),
    };
    const client = createGitClient(rpc as never) as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    const invocations: Array<[string, unknown[]]> = [
      [
        "setSharedRemote",
        ["projects/demo", { name: "origin", url: "https://github.com/octo/demo.git" }],
      ],
      ["removeSharedRemote", ["projects/demo", "origin"]],
      ["setUpstream", ["projects/demo", { remote: "origin", autoPush: true }]],
      ["removeUpstream", ["projects/demo"]],
      ["setAutoPush", ["projects/demo", false]],
      ["upstreamStatus", [["projects/demo"], { fetch: true }]],
      ["pushUpstream", ["projects/demo", { force: true }]],
      ["pullUpstream", ["projects/demo", { dryRun: true }]],
      ["publishRepo", [{ repoPath: "projects/demo", provider: "github", autoPush: true }]],
      [
        "pushDisposableRemote",
        [
          "projects/demo",
          "http://vibestudio.local/_disposable-git/id/demo.git",
          "main",
        ],
      ],
      [
        "importProject",
        [
          {
            path: "projects/demo",
            remote: { name: "origin", url: "https://github.com/octo/demo.git" },
          },
        ],
      ],
      ["completeWorkspaceDependencies", []],
    ];

    for (const [method, args] of invocations) {
      await expect(client[method]!(...args)).resolves.toEqual(results[method]);
      expect(rpc.call).toHaveBeenLastCalledWith("main", `gitInterop.${method}`, args);
    }
  });

  it("preserves the canonical status row array and one-object publish shape", async () => {
    const statusRows = [
      {
        repoPath: "projects/demo",
        autoPush: false,
        state: "behind",
        aheadBy: 0,
        behindBy: 2,
      },
    ];
    const publishInput = {
      repoPath: "projects/demo",
      provider: "github",
      name: "demo",
      autoPush: true,
    };
    const rpc = {
      call: vi
        .fn()
        .mockResolvedValueOnce(statusRows)
        .mockResolvedValueOnce({
          repoPath: "projects/demo",
          provider: "github",
          remote: "origin",
          branch: "main",
          remoteUrl: "https://github.com/octo/demo.git",
          webUrl: "https://github.com/octo/demo",
          owner: "octo",
          exported: 1,
          headCommit: "abc123",
          pushed: true,
        }),
    };
    const client = createGitClient(rpc as never);

    await expect(client.upstreamStatus(["projects/demo"], { fetch: false })).resolves.toEqual(
      statusRows
    );
    await client.publishRepo(publishInput);

    expect(rpc.call).toHaveBeenNthCalledWith(1, "main", "gitInterop.upstreamStatus", [
      ["projects/demo"],
      { fetch: false },
    ]);
    expect(rpc.call).toHaveBeenNthCalledWith(2, "main", "gitInterop.publishRepo", [publishInput]);
  });
});
