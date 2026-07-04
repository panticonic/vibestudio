/**
 * DiskProjector — the P5c host disk-projection FOLLOWER. Verifies the narrow
 * entry points project content-addressed states onto working trees without
 * any VCS semantics of their own: `project` (editable checkout at a given
 * state, incremental + clean modes, main vs ctx layout), `removeRepo`, and
 * `writeConflictSummary` (pending-merge data in, worktree file out).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { mirrorWorktreeTree, putBytes } from "../services/blobstoreService.js";
import { MERGE_CONFLICTS_FILE, VCS_MAIN_HEAD, vcsContextHead } from "./paths.js";

const CTX_HEAD = vcsContextHead("work");
import { WorktreeStore } from "./worktreeStore.js";
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
    // The projector is a pure content-store→disk follower: the WorktreeStore it uses
    // must never need the gad DO for states that are mirrored (all handed-out
    // states are, by invariant) — a throwing caller enforces that here.
    const vcs = new WorktreeStore({
      blobsDir,
      gad: {
        call: () => {
          throw new Error("the projection follower must not consult the gad store");
        },
      },
    });
    projector = new DiskProjector({
      worktrees: vcs,
      workspaceRoot: path.join(root, "workspace"),
      contextsRoot: path.join(root, ".contexts"),
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
    // NOT reachable via dirForRepoHead(main).
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

  it("projects context heads under .contexts/<id>/<repo>; main has no checkout; removeRepo drops the source subtree", async () => {
    const s = await mintState([{ path: "x.txt", text: "X\n" }]);
    await projector.project({ repoPath: REPO, head: CTX_HEAD, stateHash: s });
    const ctxFile = path.join(root, ".contexts", "work", ...REPO.split("/"), "x.txt");
    expect(await fsp.readFile(ctxFile, "utf8")).toBe("X\n");
    expect(() => projector.dirForRepoHead(REPO, "state:abc")).toThrow(/No working tree/);
    // `main` is a pure ref (D1): it has no checkout, so asking for its dir throws.
    expect(() => projector.dirForRepoHead(REPO, VCS_MAIN_HEAD)).toThrow(/main is a pure ref/);

    // removeRepo drops the repo's subtree from the source dir (the export
    // counterpart), regardless of any context checkout.
    await projector.exportMainToSource(REPO, s);
    await projector.removeRepo(REPO);
    await expect(fsp.access(path.join(root, "workspace", ...REPO.split("/")))).rejects.toThrow();
  });

  it("rejects context heads that would escape the contexts root", () => {
    expect(() => projector.dirForRepoHead(REPO, "ctx:../../outside")).toThrow(
      /Invalid VCS context id/
    );
    expect(() => projector.dirForRepoHead(REPO, "ctx:/tmp/outside")).toThrow(
      /Invalid VCS context id/
    );
  });

  it("bestEffort swallows projection failures; strict mode throws", async () => {
    const missing = `state:${"0".repeat(64)}`;
    await expect(
      projector.project({ repoPath: REPO, head: CTX_HEAD, stateHash: missing })
    ).rejects.toThrow();
    await expect(
      projector.project({
        repoPath: REPO,
        head: CTX_HEAD,
        stateHash: missing,
        bestEffort: true,
      })
    ).resolves.toBeUndefined();
  });

  it("writes and removes the worktree conflict summary from pending data", async () => {
    const s = await mintState([{ path: "a.txt", text: "A\n" }]);
    await projector.project({ repoPath: REPO, head: CTX_HEAD, stateHash: s });
    await projector.writeConflictSummary({
      repoPath: REPO,
      head: CTX_HEAD,
      pending: {
        theirsHead: "ctx:other",
        conflicts: [
          { path: "a.txt", kind: "content" },
          { path: "img.png", kind: "binary" },
        ],
      },
    });
    const file = path.join(root, ".contexts", "work", ...REPO.split("/"), MERGE_CONFLICTS_FILE);
    const text = await fsp.readFile(file, "utf8");
    expect(text).toContain("Merging `ctx:other`");
    expect(text).toContain("**content** `a.txt`");
    expect(text).toContain("**binary** `img.png`");

    await projector.writeConflictSummary({
      repoPath: REPO,
      head: CTX_HEAD,
      pending: null,
    });
    await expect(fsp.access(file)).rejects.toThrow();
  });
});
