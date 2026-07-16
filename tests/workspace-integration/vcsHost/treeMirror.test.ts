/**
 * The content-store mirroring invariant:
 * ANY state hash the system hands out can be resolved to a full tree in the
 * content store before it is published. There is one authority and no
 * reconstruction path from GAD manifests when that canonical tree is absent.
 *
 * Verified against the real content-addressed store and worktree scanner:
 * local scans mirror complete trees, strict checks reject unmirrored states,
 * and repeated mirroring is idempotent.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  collectExactTreeListing,
  getTree,
  hasTreeObject,
  materializeTree,
  putBytes,
  readFileAtTree,
} from "../../../src/server/services/blobstoreService.js";
import {
  buildWorktreeManifest,
  EMPTY_STATE_HASH,
} from "@vibestudio/content-addressing";
import { ContentProjectionStore } from "../../../src/server/vcsHost/contentProjectionStore.js";

async function writeTree(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split("/"));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content);
  }
}

/** Canonical content-store files in the ContentProjectionStore listing shape. */
async function treeFiles(
  blobsDir: string,
  stateHash: string
): Promise<Array<{ path: string; content_hash: string; mode: number }>> {
  const listing = await collectExactTreeListing(blobsDir, stateHash);
  if (!listing) throw new Error(`tree not in content store: ${stateHash}`);
  return listing
    .filter((entry) => entry.kind === "file")
    .map((entry) => ({
      path: entry.path,
      content_hash: (entry as { contentHash: string }).contentHash,
      mode: (entry as { mode: number }).mode,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

describe("ContentProjectionStore eager mirroring (scan/ingest)", () => {
  let root: string;
  let blobsDir: string;
  let vcs: ContentProjectionStore;
  let workDir: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "treemirror-"));
    blobsDir = path.join(root, "blobs");
    workDir = path.join(root, "work");
    await fsp.mkdir(workDir);
    vcs = new ContentProjectionStore({ blobsDir });
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("localState mirrors the complete tree into the canonical content store", async () => {
    await writeTree(workDir, {
      "README.md": "# hello\n",
      "src/index.ts": "export const x = 1;\n",
      "src/deep/util.ts": "export const y = 2;\n",
    });
    const snap = await vcs.localState(workDir);

    // The state (and its root tree) resolve in the content store.
    expect(await hasTreeObject(blobsDir, snap.stateHash)).toBe(true);
    const rootEntries = await getTree(blobsDir, snap.stateHash);
    expect(rootEntries?.map((entry) => entry.name)).toEqual(["README.md", "src"]);

    expect((await treeFiles(blobsDir, snap.stateHash)).map((file) => file.path)).toEqual([
      "README.md",
      "src/deep/util.ts",
      "src/index.ts",
    ]);

    // Path reads and materialization work straight off the content store.
    const meta = await readFileAtTree(blobsDir, snap.stateHash, "src/deep/util.ts");
    expect(meta).not.toBeNull();
    const outDir = path.join(root, "mat");
    await materializeTree(blobsDir, snap.stateHash, outDir);
    expect(await fsp.readFile(path.join(outDir, "src", "deep", "util.ts"), "utf8")).toBe(
      "export const y = 2;\n"
    );
  });

  it("localState (bootstrap, no ingest) also mirrors", async () => {
    await writeTree(workDir, { "a.txt": "bootstrap\n" });
    const local = await vcs.localState(workDir);
    expect(await hasTreeObject(blobsDir, local.stateHash)).toBe(true);
    expect((await treeFiles(blobsDir, local.stateHash)).map((f) => f.path)).toEqual(["a.txt"]);
  });

  it("mirroring is idempotent across repeated local scans", async () => {
    await writeTree(workDir, { "a.txt": "one" });
    const first = await vcs.localState(workDir);
    const second = await vcs.localState(workDir);
    expect(second.stateHash).toBe(first.stateHash);
    expect((await treeFiles(blobsDir, first.stateHash)).map((file) => file.path)).toEqual([
      "a.txt",
    ]);
  });

  describe("ensureStateMirrored (strict invariant)", () => {
    it("rejects a DO-minted state that was never mirrored", async () => {
      // Compute a canonical state identity without persisting its tree. The
      // strict mirror check must not reconstruct missing content implicitly.
      const a = await putBytes(blobsDir, Buffer.from("lazy-a\n", "utf8"));
      const b = await putBytes(blobsDir, Buffer.from("lazy-b\n", "utf8"));
      const staged = buildWorktreeManifest([
        { path: "pkg/a.txt", contentHash: a.digest, mode: 33188 },
        { path: "pkg/bin/run.sh", contentHash: b.digest, mode: 33261 },
      ]);
      expect(await hasTreeObject(blobsDir, staged.stateHash)).toBe(false);

      await expect(vcs.ensureStateMirrored(staged.stateHash)).rejects.toThrow(
        /missing its canonical content-store tree/
      );
      expect(await hasTreeObject(blobsDir, staged.stateHash)).toBe(false);
    });

    it("mirrors the empty state without a DO round trip", async () => {
      expect(await hasTreeObject(blobsDir, EMPTY_STATE_HASH)).toBe(false);
      await vcs.ensureStateMirrored(EMPTY_STATE_HASH);
      expect(await hasTreeObject(blobsDir, EMPTY_STATE_HASH)).toBe(true);
      expect(await collectExactTreeListing(blobsDir, EMPTY_STATE_HASH)).toEqual([]);
    });

    it("accepts an already-mirrored state idempotently", async () => {
      await writeTree(workDir, { "canonical.txt": "present\n" });
      const state = await vcs.localState(workDir);
      await vcs.ensureStateMirrored(state.stateHash);
      await vcs.ensureStateMirrored(state.stateHash);
      expect((await treeFiles(blobsDir, state.stateHash)).map((file) => file.path)).toEqual([
        "canonical.txt",
      ]);
    });
  });
});
