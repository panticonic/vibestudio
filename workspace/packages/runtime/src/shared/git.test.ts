import { describe, expect, it, vi } from "vitest";
import { gitInteropMethods } from "@vibestudio/shared/serviceSchemas/gitInterop";
import { createGitClient } from "./git.js";

describe("runtime Git client", () => {
  it("is exactly the canonical gitInterop service surface", () => {
    const rpc = { call: vi.fn() };
    const client = createGitClient(rpc as never);

    expect(Object.keys(client)).toEqual(Object.keys(gitInteropMethods));
  });

  it("routes every method through gitInterop with unchanged arguments and results", async () => {
    const rpc = {
      call: vi.fn(async (_target: string, method: string, args: unknown[]) => ({ method, args })),
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
      await expect(client[method]!(...args)).resolves.toEqual({
        method: `gitInterop.${method}`,
        args,
      });
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
        .mockResolvedValueOnce({ repoPath: "projects/demo", pushed: true }),
    };
    const client = createGitClient(rpc as never);

    await expect(client.upstreamStatus(["projects/demo"], { fetch: false })).resolves.toBe(
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
