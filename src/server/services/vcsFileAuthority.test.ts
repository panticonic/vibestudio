import { describe, expect, it } from "vitest";
import { vcsFileSelections } from "./vcsFileAuthority.js";

const state = { kind: "event", eventId: "event:one" } as const;
function metadata() {
  return async <T>(method: string, input: unknown): Promise<T> => {
    const request = input as { path?: string; cursor?: string; node?: { kind: string } };
    if (method === "vcsListDirectory")
      return {
        entries:
          request.path === ""
            ? [{ kind: "directory", path: "projects" }]
            : [
                {
                  kind: "directory",
                  path: "projects/demo",
                  repositoryRoot: true,
                  repositoryId: "repo:one",
                },
              ],
        nextCursor: null,
      } as T;
    if (method === "vcsListFiles")
      return {
        files: request.cursor ? [{ fileId: "file:one", path: "src/file.txt" }] : [],
        nextCursor: request.cursor ? null : "next",
      } as T;
    if (method === "vcsInspect")
      return {
        node: { kind: "repository", value: { kind: "present", repoPath: "projects/demo" } },
      } as T;
    throw new Error(`Unexpected metadata read ${method}`);
  };
}
const scopes = (selections: Awaited<ReturnType<typeof vcsFileSelections>>) =>
  selections.map(({ capability, resource }) => ({ capability, resource }));

describe("website semantic file consent", () => {
  it("separates workspace structure from file contents", async () => {
    expect(scopes(await vcsFileSelections("mainState", undefined, metadata()))).toEqual([
      { capability: "filesystem.list", resource: { kind: "prefix", prefix: "workspace-path/" } },
    ]);
    expect(
      scopes(
        await vcsFileSelections(
          "readFile",
          { state, repositoryId: "repo:one", file: { kind: "id", fileId: "file:one" } },
          metadata()
        )
      )
    ).toEqual([
      {
        capability: "filesystem.read",
        resource: { kind: "exact", key: "workspace-path/projects/demo/src/file.txt" },
      },
    ]);
  });
  it("preserves absent file and repository lookups through metadata consent", async () => {
    expect(
      scopes(
        await vcsFileSelections(
          "readFile",
          { state, repositoryId: "repo:one", file: { kind: "id", fileId: "missing" } },
          metadata()
        )
      )
    ).toEqual([
      {
        capability: "filesystem.list",
        resource: { kind: "prefix", prefix: "workspace-path/projects/demo/" },
      },
    ]);
    expect(
      scopes(
        await vcsFileSelections(
          "readFile",
          { state, repositoryId: "missing", file: { kind: "path", path: "file.txt" } },
          metadata()
        )
      )
    ).toEqual([
      { capability: "filesystem.list", resource: { kind: "prefix", prefix: "workspace-path/" } },
    ]);
  });
  it("covers all lexical prefix matches with their containing folder", async () => {
    expect(
      scopes(
        await vcsFileSelections(
          "listFiles",
          { state, repositoryId: "repo:one", prefix: "src/a" },
          metadata()
        )
      )
    ).toEqual([
      {
        capability: "filesystem.list",
        resource: { kind: "prefix", prefix: "workspace-path/projects/demo/src/" },
      },
    ]);
  });
  it("derives write scopes from every page of comparison coordinates", async () => {
    let calls = 0;
    const read = async <T>(_method: string, input: unknown): Promise<T> => {
      calls++;
      const { cursor } = input as { cursor?: string };
      return {
        coordinates: [
          {
            coordinate: {
              kind: "file",
              id: cursor ? "two" : "one",
              paths: cursor ? { theirs: "projects/demo/b.txt" } : { ours: "projects/demo/a.txt" },
            },
          },
        ],
        nextCursor: cursor ? null : "next",
      } as T;
    };
    expect(
      scopes(
        await vcsFileSelections(
          "push",
          {
            commandId: "command:one",
            contextId: "context:one",
            expectedMainEventId: "event:main",
            expectedCommittedEventId: "event:committed",
          },
          read
        )
      )
    ).toEqual([
      {
        capability: "filesystem.write",
        resource: { kind: "exact", key: "workspace-path/projects/demo/a.txt" },
      },
      {
        capability: "filesystem.write",
        resource: { kind: "exact", key: "workspace-path/projects/demo/b.txt" },
      },
    ]);
    expect(calls).toBe(2);
  });
  it("resolves restored repository paths across all reverted changes", async () => {
    const read = async <T>(_method: string, input: unknown): Promise<T> => {
      const { node } = input as { node: { changeId: string } };
      const effects =
        node.changeId === "change:repo"
          ? [
              {
                kind: "repository-placement",
                repositoryId: "repo:one",
                beforePath: "projects/demo",
                afterPath: null,
              },
            ]
          : [
              {
                kind: "placement",
                fileId: "file:one",
                before: { repositoryId: "repo:one", path: "a.txt" },
                after: null,
              },
            ];
      return { node: { kind: "change", value: { effects } } } as T;
    };
    expect(
      scopes(
        await vcsFileSelections(
          "revert",
          {
            commandId: "command:one",
            contextId: "context:one",
            expectedWorkingHead: state,
            changeIds: ["change:repo", "change:file"],
          },
          read
        )
      )
    ).toEqual([
      {
        capability: "filesystem.write",
        resource: { kind: "prefix", prefix: "workspace-path/projects/demo/" },
      },
    ]);
  });
});
