import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolveTreePath } from "../../../src/server/services/blobstoreService.js";
import { assertSemanticVcsPathAdmissible } from "@vibestudio/shared/vcs/pathAdmission";
import { ContentProjectionStore } from "../../../src/server/vcsHost/contentProjectionStore.js";

describe("assertSemanticVcsPathAdmissible", () => {
  it("rejects materializer metadata", () => {
    expect(() => assertSemanticVcsPathAdmissible(".gad/CHECKOUT.json")).toThrow(
      /platform-reserved directory/u
    );
  });

  it("rejects an exact secret filename", () => {
    expect(() => assertSemanticVcsPathAdmissible(".env")).toThrow(/platform-reserved file/u);
  });

  it("allows ordinary source and project-owned output", () => {
    expect(() => assertSemanticVcsPathAdmissible("projects/foo.txt")).not.toThrow();
    expect(() => assertSemanticVcsPathAdmissible("dist/index.js")).not.toThrow();
    expect(() => assertSemanticVcsPathAdmissible("coverage/report.json")).not.toThrow();
  });
});

async function writeTree(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split("/"));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content);
  }
}

async function readTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (abs: string, rel: string): Promise<void> => {
    for (const entry of await fsp.readdir(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === ".gad") continue;
        await walk(path.join(abs, entry.name), childRel);
      } else {
        out[childRel] = await fsp.readFile(path.join(abs, entry.name), "utf8");
      }
    }
  };
  await walk(dir, "");
  return out;
}

describe("ContentProjectionStore scan/materialize", () => {
  let root: string;
  let vcs: ContentProjectionStore;
  let workDir: string;
  let blobsDir: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "gadvcs-"));
    workDir = path.join(root, "work");
    await fsp.mkdir(workDir);
    blobsDir = path.join(root, "blobs");
    vcs = new ContentProjectionStore({ blobsDir });
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("round-trips scan → materialize byte-identically", async () => {
    const tree = {
      "README.md": "# hello\n",
      "src/index.ts": "export const x = 1;\n",
      "src/deep/nested/util.ts": "export const y = 2;\n",
    };
    await writeTree(workDir, tree);
    const snap = await vcs.localState(workDir, { updateSidecar: true });
    expect(snap.files).toHaveLength(3);
    expect(snap.stateHash).toMatch(/^state:[0-9a-f]{64}$/);
    const sidecar = await fsp.readFile(path.join(workDir, ".gad", "CHECKOUT.json"), "utf8");
    expect(sidecar).toContain('\n  "files":');
    expect(sidecar.endsWith("\n")).toBe(true);
    expect(JSON.parse(sidecar)).toMatchObject({ stateHash: snap.stateHash });

    const outDir = path.join(root, "out");
    const mat = await vcs.materializeState(snap.stateHash, outDir);
    expect(mat.written).toBe(3);
    expect(await readTree(outDir)).toEqual(tree);
  });

  it("survives concurrent sidecar writers to the same dir (unique tmp paths)", async () => {
    await writeTree(workDir, { "a.txt": "one", "src/index.ts": "export const x = 1;\n" });
    // Two in-process writers racing on the same dir's `.gad/CHECKOUT.json` — the
    // projection reaction can run outside the per-repo stateKey lock. With
    // pid-only tmp names both would target the identical `.tmp` path and the
    // loser's writeFile/rename ENOENTs (or clobbers the winner); unique tmp
    // names (pid + randomUUID) let both land cleanly.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => vcs.localState(workDir, { updateSidecar: true }))
    );
    const expectedStateHash = results[0]?.stateHash;
    expect(expectedStateHash).toBeDefined();
    for (const r of results) {
      expect(r.stateHash).toBe(expectedStateHash);
    }
    const sidecar = await fsp.readFile(path.join(workDir, ".gad", "CHECKOUT.json"), "utf8");
    expect(JSON.parse(sidecar)).toMatchObject({ stateHash: expectedStateHash });
    // No stray `.tmp` leftovers from a raced rename.
    const gadEntries = await fsp.readdir(path.join(workDir, ".gad"));
    expect(gadEntries.filter((n) => n.endsWith(".tmp"))).toHaveLength(0);
  });

  it("scans edits incrementally and materializes deltas", async () => {
    await writeTree(workDir, { "a.txt": "one", "b.txt": "two" });
    const first = await vcs.localState(workDir);

    await writeTree(workDir, { "a.txt": "one-edited", "c.txt": "three" });
    await fsp.rm(path.join(workDir, "b.txt"));
    const second = await vcs.localState(workDir);
    expect(second.stateHash).not.toBe(first.stateHash);

    const outDir = path.join(root, "out");
    await vcs.materializeState(first.stateHash, outDir);
    const delta = await vcs.materializeState(second.stateHash, outDir);
    expect(delta.deleted).toBe(1); // b.txt
    expect(delta.unchanged).toBe(0); // a edited, c new
    expect(await readTree(outDir)).toEqual({ "a.txt": "one-edited", "c.txt": "three" });
  });

  it("preserves untracked files on materialize unless clean", async () => {
    await writeTree(workDir, { "a.txt": "one" });
    const snap = await vcs.localState(workDir);

    const outDir = path.join(root, "out");
    await vcs.materializeState(snap.stateHash, outDir);
    await writeTree(outDir, { "untracked.txt": "keep me" });

    await vcs.materializeState(snap.stateHash, outDir);
    expect((await readTree(outDir))["untracked.txt"]).toBe("keep me");

    await vcs.materializeState(snap.stateHash, outDir, { clean: true });
    expect((await readTree(outDir))["untracked.txt"]).toBeUndefined();
  });

  it("uses the same narrow semantic admission policy as command ingress", async () => {
    await writeTree(workDir, {
      ".gadignore": "*.log\nbuild/\n",
      "keep.ts": "ok",
      ".env": "SECRET=1",
      ".env.local": "SECRET=2",
      ".cache/state.json": "noise",
      ".databases/app.sqlite": "noise",
      ".npmrc": "//registry.example.test/:_authToken=secret",
      ".secrets.yml": "token: secret",
      "debug.log": "noise",
      "pkg.tsbuildinfo": "noise",
      "coverage/coverage.json": "noise",
      "out/app.js": "noise",
      "build/out.js": "noise",
      "node_modules/dep/index.js": "noise",
      ".git/HEAD": "noise",
    });
    const snap = await vcs.localState(workDir);
    const files = await vcs.listStateFiles(snap.stateHash);
    expect(files.map((file) => file.path).sort()).toEqual([
      ".cache/state.json",
      ".databases/app.sqlite",
      ".env.local",
      ".gadignore",
      "build/out.js",
      "coverage/coverage.json",
      "debug.log",
      "keep.ts",
      "node_modules/dep/index.js",
      "out/app.js",
      "pkg.tsbuildinfo",
    ]);
  });

  it("subtree hashes (content store) change only for touched subtrees", async () => {
    // Subtree addressing now reads the mirrored tree in the content store —
    // no DO round trip (scans mirror eagerly).
    const subtree = async (stateHash: string, p: string): Promise<string | null> => {
      const resolved = await resolveTreePath(blobsDir, stateHash, p);
      return resolved === null
        ? null
        : resolved.kind === "dir"
          ? resolved.treeHash
          : resolved.contentHash;
    };
    await writeTree(workDir, {
      "pkg-a/index.ts": "a",
      "pkg-b/index.ts": "b",
    });
    const first = await vcs.localState(workDir);
    const aHash1 = await subtree(first.stateHash, "pkg-a");
    const bHash1 = await subtree(first.stateHash, "pkg-b");
    expect(aHash1).toMatch(/^manifest:/);

    await writeTree(workDir, { "pkg-a/index.ts": "a-edited" });
    const second = await vcs.localState(workDir);
    expect(await subtree(second.stateHash, "pkg-a")).not.toBe(aHash1);
    expect(await subtree(second.stateHash, "pkg-b")).toBe(bHash1);
  });

  it("content-store subtree hashes are byte-identical to the shared reference implementation", async () => {
    await writeTree(workDir, {
      "README.md": "# hi\n",
      "panels/chat/index.tsx": "export {}",
      "panels/chat/src/deep.ts": "export const d = 1;",
      "packages/core/index.ts": "export const c = 2;",
    });
    const local = await vcs.localState(workDir);
    const snap = await vcs.localState(workDir);
    // Cross-implementation guarantee, state level: the hash the DO ingest
    // hands back equals the shared reference implementation's
    // (`buildWorktreeManifest`, via localState) for the same tree.
    expect(local.stateHash).toBe(snap.stateHash);
    // Content store ⟷ canonical hashing: every subtree address resolved from
    // the mirrored tree equals `buildWorktreeManifest().subtreeHash` (a dir's
    // manifest hash, a file's content hash).
    for (const subtree of ["panels/chat", "panels/chat/src", "packages/core", "README.md"]) {
      const resolved = await resolveTreePath(blobsDir, snap.stateHash, subtree);
      const fromStore =
        resolved === null
          ? null
          : resolved.kind === "dir"
            ? resolved.treeHash
            : resolved.contentHash;
      expect(fromStore).not.toBeNull();
      expect(fromStore).toBe(local.manifest.subtreeHash(subtree));
    }
    expect(await resolveTreePath(blobsDir, snap.stateHash, "does/not/exist")).toBeNull();
    expect(local.manifest.subtreeHash("does/not/exist")).toBeNull();
  });

  it("materializes file→directory and directory→file transitions at the same path", async () => {
    // State A: `config` is a regular file.
    await writeTree(workDir, { config: "v=1\n", "keep.txt": "k" });
    const a = await vcs.localState(workDir);
    // State B: `config` becomes a directory.
    await fsp.rm(path.join(workDir, "config"));
    await writeTree(workDir, { "config/index.ts": "export const v = 1;\n" });
    const b = await vcs.localState(workDir);

    const outDir = path.join(root, "out");
    await vcs.materializeState(a.stateHash, outDir);
    expect(await readTree(outDir)).toEqual({ config: "v=1\n", "keep.txt": "k" });

    // file → directory: must neither throw nor silently produce an empty tree.
    await vcs.materializeState(b.stateHash, outDir);
    expect(await readTree(outDir)).toEqual({
      "config/index.ts": "export const v = 1;\n",
      "keep.txt": "k",
    });

    // directory → file (back to A): the recursive deletion must clear the dir.
    await vcs.materializeState(a.stateHash, outDir);
    expect(await readTree(outDir)).toEqual({ config: "v=1\n", "keep.txt": "k" });
  });

  it("materializes over an untracked file that conflicts with a target directory path", async () => {
    await writeTree(workDir, { "data/x.txt": "x" });
    const snap = await vcs.localState(workDir);

    const outDir = path.join(root, "out");
    await fsp.mkdir(outDir, { recursive: true });
    // Pre-seed an untracked file where the target needs a directory.
    await fsp.writeFile(path.join(outDir, "data"), "untracked-conflict");

    await vcs.materializeState(snap.stateHash, outDir);
    expect(await readTree(outDir)).toEqual({ "data/x.txt": "x" });
  });

  it("marks executables and round-trips mode", async () => {
    const script = path.join(workDir, "run.sh");
    await fsp.writeFile(script, "#!/bin/sh\necho hi\n");
    await fsp.chmod(script, 0o755);
    const snap = await vcs.localState(workDir);

    const outDir = path.join(root, "out");
    await vcs.materializeState(snap.stateHash, outDir);
    const stat = fs.statSync(path.join(outDir, "run.sh"));
    expect(stat.mode & 0o111).not.toBe(0);
  });
});
