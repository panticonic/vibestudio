/**
 * DiskProjector — the P5c host disk-projection FOLLOWER. Verifies the narrow
 * entry points project content-addressed states onto disk without VCS
 * semantics of their own: an explicit context/repository/state projection,
 * the one-way source export, and source-repository removal.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { mirrorWorktreeTree, putBytes } from "../services/blobstoreService.js";
import { ContentProjectionStore } from "./contentProjectionStore.js";
import { DiskProjector } from "./diskProjector.js";

const REPO = "packages/demo";

describe("DiskProjector (P5c disk-projection follower)", () => {
  let root: string;
  let blobsDir: string;
  let projector: DiskProjector;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "disk-projector-"));
    blobsDir = path.join(root, "blobs");
    await fsp.mkdir(path.join(root, "workspace"), { recursive: true });
    // The projector is a pure content-store→disk follower. ContentProjectionStore has no
    // semantic-authority dependency to consult.
    const contentProjection = new ContentProjectionStore({ blobsDir });
    projector = new DiskProjector({
      contentProjection,
      workspaceRoot: path.join(root, "workspace"),
      contextProjectionsRoot: path.join(root, ".context-projections", "v5"),
    });
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  async function mintState(files: Array<{ path: string; text: string }>): Promise<string> {
    const entries = [];
    for (const file of files) {
      const { digest } = await putBytes(blobsDir, Buffer.from(file.text, "utf8"));
      entries.push({ path: file.path, contentHash: digest, mode: 33188 });
    }
    return (await mirrorWorktreeTree(blobsDir, entries)).stateHash;
  }

  it("exportMainToSource writes a repo's main state OUT to the source dir (write-only, clean)", async () => {
    // §3: `main` has no checkout; the only main→disk effect is the write-only
    // export to the source dir (`workspaceRoot/{repoPath}`), a dedicated path
    // structurally separate from semantic context projection.
    const s1 = await mintState([
      { path: "a.txt", text: "A\n" },
      { path: "sub/b.txt", text: "B\n" },
    ]);
    await projector.exportMainToSource(REPO, s1);
    const repoDir = path.join(root, "workspace", ...REPO.split("/"));
    expect(await fsp.readFile(path.join(repoDir, "a.txt"), "utf8")).toBe("A\n");
    expect(await fsp.readFile(path.join(repoDir, "sub/b.txt"), "utf8")).toBe("B\n");

    // The export is clean: an untracked scratch file and stale tracked files are
    // both removed so the source dir mirrors main exactly.
    await fsp.writeFile(path.join(repoDir, "scratch.txt"), "untracked\n");
    const s2 = await mintState([{ path: "a.txt", text: "A2\n" }]);
    await projector.exportMainToSource(REPO, s2);
    expect(await fsp.readFile(path.join(repoDir, "a.txt"), "utf8")).toBe("A2\n");
    await expect(fsp.access(path.join(repoDir, "sub/b.txt"))).rejects.toThrow(); // stale, removed
    await expect(fsp.access(path.join(repoDir, "scratch.txt"))).rejects.toThrow(); // untracked, removed
  });

  it("projects an explicit context repository and removes source exports separately", async () => {
    const s = await mintState([{ path: "x.txt", text: "X\n" }]);
    await projector.projectContextRepository({
      contextId: "work",
      repoPath: REPO,
      stateHash: s,
    });
    const ctxFile = path.join(
      root,
      ".context-projections",
      "v5",
      "work",
      ...REPO.split("/"),
      "x.txt"
    );
    expect(await fsp.readFile(ctxFile, "utf8")).toBe("X\n");
    expect(projector.contextRepositoryDir("work", REPO)).toBe(
      path.join(root, ".context-projections", "v5", "work", ...REPO.split("/"))
    );

    // removeRepo drops the repo's subtree from the source dir (the export
    // counterpart), regardless of any context checkout.
    await projector.exportMainToSource(REPO, s);
    await projector.removeRepo(REPO);
    await expect(fsp.access(path.join(root, "workspace", ...REPO.split("/")))).rejects.toThrow();
  });

  it("rejects context ids that would escape the contexts root", () => {
    expect(() => projector.contextRepositoryDir("../../outside", REPO)).toThrow(
      /Invalid VCS context id/
    );
    expect(() => projector.contextRepositoryDir("/tmp/outside", REPO)).toThrow(
      /Invalid VCS context id/
    );
  });

  it("surfaces projection failures for semantic effect replay", async () => {
    const missing = `state:${"0".repeat(64)}`;
    await expect(
      projector.projectContextRepository({ contextId: "work", repoPath: REPO, stateHash: missing })
    ).rejects.toThrow();
  });
});
