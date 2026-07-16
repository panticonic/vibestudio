import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { treeHashDigest } from "@vibestudio/shared/contentTree/treeObjects";
import {
  blobPath,
  ensureLayout,
  hasTreeObject,
  mirrorWorktreeTree,
  putBytes,
  resolveTreePath,
} from "../services/blobstoreService.js";
import { collectTreeFiles } from "./contentProjectionStore.js";
import { WorkspaceRepositories } from "./workspaceRepositories.js";

describe("WorkspaceRepositories Merkle composition", () => {
  let root: string;
  let blobsDir: string;
  let mains: Array<{ repoPath: string; contentRoot: string }>;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "workspace-repositories-"));
    blobsDir = path.join(root, "blobs");
    ensureLayout(blobsDir);
    mains = [];
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  async function stateWithFile(filePath: string, text: string): Promise<string> {
    const blob = await putBytes(blobsDir, Buffer.from(text));
    return (
      await mirrorWorktreeTree(blobsDir, [
        { path: filePath, contentHash: blob.digest, mode: 33188 },
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
  ): WorkspaceRepositories {
    return new WorkspaceRepositories({
      blobsDir,
      refs: { listMains: () => mains as never },
      contentProjection: { ensureStateMirrored: async () => undefined },
      discoverGraph: async () => graph as never,
    });
  }

  it("composes protected roots into one walkable view and derives the repository catalog", async () => {
    mains = [
      { repoPath: "packages/core", contentRoot: await stateWithFile("index.ts", "core") },
      { repoPath: "meta", contentRoot: await stateWithFile("vibestudio.yml", "id: test") },
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

  it("builds exact candidate sets without mutating protected refs", async () => {
    const original = await stateWithFile("old.ts", "old");
    const replacement = await stateWithFile("new.ts", "new");
    mains = [{ repoPath: "packages/core", contentRoot: original }];
    const repositories = createRepositories();

    const candidate = await repositories.workspaceViewWithReposAt([
      { repoPath: "packages/core", stateHash: replacement },
    ]);

    expect((await collectTreeFiles(blobsDir, candidate))?.map((file) => file.path)).toEqual([
      "packages/core/new.ts",
    ]);
    expect(mains).toEqual([{ repoPath: "packages/core", contentRoot: original }]);
  });

  it("reports direct reverse-dependency repositories for deletion approval", async () => {
    mains = [{ repoPath: "packages/core", contentRoot: await stateWithFile("index.ts", "core") }];
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

  it("makes semantic-only working-state changes an exact state-pointer lookup", async () => {
    const digest = (await putBytes(blobsDir, Buffer.from("export const value = 1;\n"))).digest;
    const repository = await mirrorWorktreeTree(blobsDir, [
      { path: "src/index.ts", contentHash: digest, mode: 33188 },
    ]);
    const ensureStateMirrored = vi.fn(async (stateHash: string) => {
      if (!(await hasTreeObject(blobsDir, stateHash))) throw new Error("missing state");
    });
    const repositories = new WorkspaceRepositories({
      blobsDir,
      refs: { listMains: () => [] },
      contentProjection: { ensureStateMirrored },
      discoverGraph: vi.fn(),
    });
    const exactSet = [{ repoPath: "packages/app", stateHash: repository.stateHash }];

    const first = await repositories.contentView(exactSet);
    const second = await repositories.contentView(exactSet);

    expect(second).toEqual(first);
    expect(ensureStateMirrored).toHaveBeenCalledTimes(1);
    await expect(resolveTreePath(blobsDir, first.stateHash, "packages/app")).resolves.toEqual({
      kind: "dir",
      treeHash: repository.treeHash,
    });
  });

  it("rebuilds only the Merkle scaffold when a cached composed pointer disappears", async () => {
    const digest = (await putBytes(blobsDir, Buffer.from("content\n"))).digest;
    const repository = await mirrorWorktreeTree(blobsDir, [
      { path: "file.txt", contentHash: digest, mode: 33188 },
    ]);
    const ensureStateMirrored = vi.fn(async () => undefined);
    const repositories = new WorkspaceRepositories({
      blobsDir,
      refs: { listMains: () => [] },
      contentProjection: { ensureStateMirrored },
      discoverGraph: vi.fn(),
    });
    const exactSet = [{ repoPath: "projects/example", stateHash: repository.stateHash }];
    const first = await repositories.contentView(exactSet);
    await fsp.rm(blobPath(blobsDir, treeHashDigest(first.stateHash)), { force: true });

    const rebuilt = await repositories.contentView(exactSet);

    expect(rebuilt).toEqual(first);
    expect(await hasTreeObject(blobsDir, rebuilt.stateHash)).toBe(true);
    expect(ensureStateMirrored).toHaveBeenCalledTimes(2);
  });
});
