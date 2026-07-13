import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectTreeFiles } from "./worktreeStore.js";
import { ensureLayout, mirrorWorktreeTree, putBytes } from "../services/blobstoreService.js";
import { WorkspaceRepositories } from "./workspaceRepositories.js";

const FILE_MODE = 0o100644;

describe("WorkspaceRepositories", () => {
  let blobsDir: string;
  let mains: Array<{ repoPath: string; stateHash: string }>;

  beforeEach(async () => {
    blobsDir = await mkdtemp(join(tmpdir(), "workspace-repositories-"));
    ensureLayout(blobsDir);
    mains = [];
  });

  afterEach(async () => {
    await rm(blobsDir, { recursive: true, force: true });
  });

  async function stateWithFile(filePath: string, text: string): Promise<string> {
    const blob = await putBytes(blobsDir, Buffer.from(text));
    return (
      await mirrorWorktreeTree(blobsDir, [
        { path: filePath, contentHash: blob.digest, mode: FILE_MODE },
      ])
    ).stateHash;
  }

  function createRepositories(
    graph: {
      allNodes(): Array<{ name: string; relativePath: string }>;
      getReverseDeps(name: string): string[];
      tryGet(name: string): { relativePath: string } | undefined;
    } = {
      allNodes: () => [],
      getReverseDeps: () => [],
      tryGet: () => undefined,
    }
  ) {
    return new WorkspaceRepositories({
      blobsDir,
      refs: { listMains: () => mains as never },
      worktrees: { ensureStateMirrored: async () => {} },
      discoverGraph: async () => graph as never,
    });
  }

  it("composes repo-rooted mains into one workspace view and derives the catalog", async () => {
    mains = [
      { repoPath: "packages/core", stateHash: await stateWithFile("index.ts", "core") },
      { repoPath: "meta", stateHash: await stateWithFile("vibestudio.yml", "name: test") },
    ];
    const repositories = createRepositories();

    const view = await repositories.workspaceView();
    const files = await collectTreeFiles(blobsDir, view.stateHash);

    expect(files?.map((file) => file.path)).toEqual([
      "meta/vibestudio.yml",
      "packages/core/index.ts",
    ]);
    await expect(repositories.discover()).resolves.toEqual([
      { repoPath: "meta", kind: "meta" },
      { repoPath: "packages/core", kind: "build-unit" },
    ]);
  });

  it("builds candidate views without mutating refs", async () => {
    const original = await stateWithFile("old.ts", "old");
    const replacement = await stateWithFile("new.ts", "new");
    mains = [{ repoPath: "packages/core", stateHash: original }];
    const repositories = createRepositories();

    const candidate = await repositories.workspaceViewWithRepoAt("packages/core", replacement);
    expect((await collectTreeFiles(blobsDir, candidate))?.map((file) => file.path)).toEqual([
      "packages/core/new.ts",
    ]);
    expect(mains).toEqual([{ repoPath: "packages/core", stateHash: original }]);
  });

  it("reports direct reverse-dependency repositories for deletion approval", async () => {
    mains = [{ repoPath: "packages/core", stateHash: await stateWithFile("index.ts", "core") }];
    const nodes = new Map([
      ["core", { name: "core", relativePath: "packages/core" }],
      ["app", { name: "app", relativePath: "apps/app" }],
      ["panel", { name: "panel", relativePath: "panels/panel" }],
    ]);
    const repositories = createRepositories({
      allNodes: () => [...nodes.values()],
      getReverseDeps: (name) => (name === "core" ? ["panel", "app"] : []),
      tryGet: (name) => nodes.get(name),
    });

    await expect(repositories.deletionDependents("packages/core")).resolves.toEqual([
      "apps/app",
      "panels/panel",
    ]);
  });
});
