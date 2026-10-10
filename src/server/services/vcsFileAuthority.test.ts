import { describe, expect, it } from "vitest";
import { vcsFileSelections, type SemanticReads } from "./vcsFileAuthority.js";
import { vcsMethods, type VcsChange, type VcsInspectResult } from "@vibestudio/service-schemas/vcs";

const state = { kind: "event", eventId: "event:one" } as const;
type RawRead = (method: string, input: unknown) => Promise<unknown>;
function metadata(): RawRead {
  return async (method: string, input: unknown): Promise<unknown> => {
    const request = input as {
      path?: string;
      cursor?: string;
      state?: typeof state;
      node?: { kind: string; state?: typeof state; repositoryId?: string; fileId?: string };
    };
    if (method === "vcsListDirectory")
      return vcsMethods.listDirectory.returns.parse({
        state: request.state,
        path: request.path ?? "",
        entries:
          request.path === ""
            ? [
                {
                  name: "projects",
                  path: "projects",
                  kind: "directory",
                  identity: "directory:projects",
                  repositoryId: null,
                  repositoryRoot: false,
                  fileId: null,
                  lineage: {
                    authoredChangeId: null,
                    authoredByWorkUnitId: "work-unit:one",
                    contentClass: "internal",
                    externalKeys: [],
                  },
                },
              ]
            : [
                {
                  name: "demo",
                  path: "projects/demo",
                  kind: "directory",
                  identity: "repository:one",
                  repositoryId: "repo:one",
                  repositoryRoot: true,
                  fileId: null,
                  lineage: {
                    authoredChangeId: null,
                    authoredByWorkUnitId: "work-unit:one",
                    contentClass: "internal",
                    externalKeys: [],
                  },
                },
              ],
        nextCursor: null,
      });
    if (method === "vcsListFiles")
      return vcsMethods.listFiles.returns.parse({
        state: request.state,
        repositoryId: "repo:one",
        files: request.cursor
          ? [
              {
                fileId: "file:one",
                path: "src/file.txt",
                contentHash: "hash:content",
                authoredChangeId: "change:one",
                authoredByWorkUnitId: "work-unit:one",
                contentClass: "internal",
                externalKeys: [],
                mode: 0o644,
                contentKind: "text",
                byteLength: 0,
                coordinateExtent: 0,
              },
            ]
          : [],
        nextCursor: request.cursor ? null : "next",
      });
    if (method === "vcsInspect") {
      const node = request.node!;
      const inspected =
        node.kind === "repository"
          ? {
              kind: "repository",
              state: node.state,
              value: {
                kind: "present",
                repositoryId: node.repositoryId ?? "repo:one",
                repoPath: "projects/demo",
                manifestId: "manifest:one",
              },
            }
          : {
              kind: "file",
              state: node.state,
              value: {
                kind: "placed",
                fileId: node.fileId ?? "file:one",
                repositoryId: "repo:one",
                path: "src/file.txt",
                contentHash: "hash:content",
                mode: 0o644,
                contentKind: "text",
                byteLength: 0,
                coordinateExtent: 0,
              },
            };
      return vcsMethods.inspect.returns.parse({
        root: node,
        node: inspected,
        edges: [],
        hasMoreEdges: false,
      });
    }
    throw new Error(`Unexpected metadata read ${method}`);
  };
}
function typedReads(read: RawRead): SemanticReads {
  return {
    inspect: async (input) => vcsMethods.inspect.returns.parse(await read("vcsInspect", input)),
    compare: async (input) => vcsMethods.compare.returns.parse(await read("vcsCompare", input)),
    status: async (input) => vcsMethods.status.returns.parse(await read("vcsStatus", input)),
    listDirectory: async (input) =>
      vcsMethods.listDirectory.returns.parse(await read("vcsListDirectory", input)),
    listFiles: async (input) =>
      vcsMethods.listFiles.returns.parse(await read("vcsListFiles", input)),
  };
}
const scopes = (selections: Awaited<ReturnType<typeof vcsFileSelections>>) =>
  selections.map(({ capability, resource }) => ({ capability, resource }));

describe("website semantic file consent", () => {
  it("authorizes every batch selector while sharing exact-state repository discovery", async () => {
    const calls: string[] = [];
    const source = metadata();
    const read: RawRead = async (method, input) => {
      calls.push(method);
      return source(method, input);
    };
    const selected = scopes(
      await vcsFileSelections(
        "readFiles",
        {
          state,
          files: [
            { repositoryId: "repo:one", file: { kind: "path", path: "a.txt" } },
            { repositoryId: "repo:one", file: { kind: "path", path: "b.txt" } },
            { repositoryId: "missing", file: { kind: "path", path: "secret.txt" } },
          ],
        },
        typedReads(read)
      )
    );
    expect(selected).toContainEqual({
      capability: "filesystem.read",
      resource: { kind: "exact", key: "workspace-path/projects/demo/a.txt" },
    });
    expect(selected).toContainEqual({
      capability: "filesystem.read",
      resource: { kind: "exact", key: "workspace-path/projects/demo/b.txt" },
    });
    expect(selected).toContainEqual({
      capability: "filesystem.list",
      resource: { kind: "prefix", prefix: "workspace-path/" },
    });
    expect(calls.filter((method) => method === "vcsListDirectory")).toHaveLength(2);
  });
  it("separates workspace structure from file contents", async () => {
    expect(scopes(await vcsFileSelections("mainState", undefined, typedReads(metadata())))).toEqual(
      [{ capability: "filesystem.list", resource: { kind: "prefix", prefix: "workspace-path/" } }]
    );
    expect(
      scopes(
        await vcsFileSelections(
          "readFile",
          { state, repositoryId: "repo:one", file: { kind: "id", fileId: "file:one" } },
          typedReads(metadata())
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
          typedReads(metadata())
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
          typedReads(metadata())
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
          typedReads(metadata())
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
    const read: RawRead = async (_method: string, input: unknown) => {
      calls++;
      const { cursor } = input as { cursor?: string };
      return vcsMethods.compare.returns.parse({
        target: state,
        source: { kind: "event", eventId: "event:committed" },
        base: state,
        resolution: { complete: true, remainingCoordinateCount: 0, concluded: true },
        counts: { adopt: 0, convergent: 0, composed: 0, conflict: 0, resolved: 0 },
        intentCounts: { merged: 0, settled: 0, split: 0, contested: 0, pending: 0 },
        coordinates: [
          {
            coordinate: {
              kind: "file",
              id: cursor ? "two" : "one",
              paths: cursor ? { theirs: "projects/demo/b.txt" } : { ours: "projects/demo/a.txt" },
            },
            status: "adopt",
            aspects: [{ aspect: "content", base: null, ours: null, theirs: null, status: "adopt" }],
            attribution: { ours: [], theirs: [] },
            resolutions: [],
            summary: "fixture",
          },
        ],
        intents: [],
        intentsTruncated: false,
        nextCursor: cursor ? null : "next",
      });
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
          typedReads(read)
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
    const read: RawRead = async (_method: string, input: unknown) => {
      const { node } = input as { node: { changeId: string } };
      const effects: VcsChange["effects"] =
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
      const change: VcsChange = {
        changeId: node.changeId,
        authoredByWorkUnitId: "work-unit:one",
        operation: 0,
        kind: "repository-delete",
        effects,
        counteractsChangeIds: [],
        effectDigest: "digest:one",
        normalizationProtocol: "v1",
      };
      const inspected: VcsInspectResult = {
        root: { kind: "change", changeId: node.changeId },
        node: { kind: "change", value: change },
        edges: [],
        hasMoreEdges: false,
      };
      return inspected;
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
          typedReads(read)
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
