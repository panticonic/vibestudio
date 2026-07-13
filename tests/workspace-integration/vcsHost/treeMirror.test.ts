/**
 * The content-store mirroring invariant (blob-addressed-cleanly step 4):
 * ANY state hash the system hands out can be resolved to a full tree in the
 * content store before it is published. There is one authority and no
 * reconstruction path from GAD manifests when that canonical tree is absent.
 *
 * Verified here against the REAL gad-store DO (workerd test-utils), matching
 * the store.test.ts / workspaceVcs.*.test.ts patterns:
 *  (a) ingest a directory → getTree/listTree of the state hash works;
 *  (b) the edit → commit → push path mirrors every state it hands out;
 *  (c) ensureStateMirrored rejects a deliberately-unmirrored DO state;
 *  (d) mirroring is idempotent.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { GadWorkspaceDO } from "../../../workspace/workers/gad-store/index.js";
import {
  getTree,
  hasTreeObject,
  listTree,
  materializeTree,
  putBytes,
  readFileAtTree,
} from "../../../src/server/services/blobstoreService.js";
import { EMPTY_STATE_HASH } from "@vibestudio/shared/contentTree/worktreeHash";
import { VCS_MAIN_HEAD, vcsContextHead } from "../../../src/server/vcsHost/paths.js";
import { WorktreeStore } from "../../../src/server/vcsHost/worktreeStore.js";
import { createProtectedRefStore } from "../../../src/server/services/protectedRefStore.js";
import {
  attachLocalHostBridges,
  pushToMain,
  type GadCaller,
} from "../../../src/server/vcsHost/testSupport.js";
import { WorkspaceVcs } from "../../../src/server/vcsHost/workspaceVcs.js";

type TestGad = Awaited<ReturnType<typeof createTestDO<GadWorkspaceDO>>>;

const FIXTURE_LOG = "vcs:workspace";
const USER = { id: "user", kind: "user" };
const text = (value: string) => ({ kind: "text" as const, text: value });

function callerFor(gad: TestGad): GadCaller {
  return {
    async call<T>(method: string, input: unknown): Promise<T> {
      const instance = gad.instance as unknown as Record<string, (arg: unknown) => unknown>;
      const fn = instance[method];
      if (typeof fn !== "function") throw new Error(`no such gad method: ${method}`);
      return (await fn.call(gad.instance, input)) as T;
    },
  };
}

async function writeTree(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split("/"));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content);
  }
}

/** Canonical content-store files in the WorktreeStore listing shape. */
async function treeFiles(
  blobsDir: string,
  stateHash: string
): Promise<Array<{ path: string; content_hash: string; mode: number }>> {
  const listing = await listTree(blobsDir, stateHash);
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

describe("WorktreeStore eager mirroring (scan/ingest)", () => {
  let root: string;
  let blobsDir: string;
  let gad: TestGad;
  let vcs: WorktreeStore;
  let workDir: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "treemirror-"));
    blobsDir = path.join(root, "blobs");
    workDir = path.join(root, "work");
    await fsp.mkdir(workDir);
    gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad" });
    vcs = new WorktreeStore({ blobsDir, gad: callerFor(gad) });
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("snapshotDir mirrors the complete tree into the canonical content store", async () => {
    await writeTree(workDir, {
      "README.md": "# hello\n",
      "src/index.ts": "export const x = 1;\n",
      "src/deep/util.ts": "export const y = 2;\n",
    });
    const snap = await vcs.snapshotDir(workDir, { logId: FIXTURE_LOG, summary: "initial" });
    expect(snap.unchanged).toBe(false);

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

  it("mirroring is idempotent across repeated snapshots (unchanged fast path included)", async () => {
    await writeTree(workDir, { "a.txt": "one" });
    const first = await vcs.snapshotDir(workDir, { logId: FIXTURE_LOG });
    const second = await vcs.snapshotDir(workDir, { logId: FIXTURE_LOG });
    expect(second.unchanged).toBe(true);
    expect(second.stateHash).toBe(first.stateHash);
    expect((await treeFiles(blobsDir, first.stateHash)).map((file) => file.path)).toEqual([
      "a.txt",
    ]);
  });

  describe("ensureStateMirrored (strict invariant)", () => {
    it("rejects a DO-minted state that was never mirrored", async () => {
      // Mint a state INSIDE the DO (staged value) — the server-side mirror
      // paths never see this file list.
      const a = await putBytes(blobsDir, Buffer.from("lazy-a\n", "utf8"));
      const b = await putBytes(blobsDir, Buffer.from("lazy-b\n", "utf8"));
      const staged = gad.instance.stageWorktreeState({
        files: [
          { path: "pkg/a.txt", contentHash: a.digest, mode: 33188 },
          { path: "pkg/bin/run.sh", contentHash: b.digest, mode: 33261 },
        ],
        summary: "DO-only state",
      });
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
      expect(await listTree(blobsDir, EMPTY_STATE_HASH)).toEqual([]);
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

describe("WorkspaceVcs eager mirroring (edit → commit → push, composed views)", () => {
  const REPO = "packages/mirrored";
  const CTX_HEAD = vcsContextHead("work");

  let root: string;
  let blobsDir: string;
  let workspaceRoot: string;
  let vcs: WorkspaceVcs;
  let gad: TestGad;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "treemirror-wv-"));
    blobsDir = path.join(root, "blobs");
    workspaceRoot = path.join(root, "workspace");
    await fsp.mkdir(workspaceRoot);
    gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad" });
    const refs = createProtectedRefStore({
      statePath: path.join(root, "refs"),
      gate: async () => {},
    });
    attachLocalHostBridges(gad.instance, { blobsDir, refs });
    vcs = new WorkspaceVcs({
      workspaceId: "test-ws",
      blobsDir,
      workspaceRoot,
      contextsRoot: path.join(root, ".contexts"),
      buildSourcesRoot: path.join(root, "build-sources"),
      refs,
    });
    await vcs.attachGad(callerFor(gad));
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("edit → commit → push mirrors every handed-out state (working, commit, main, workspace view)", async () => {
    // Uncommitted working edit: the staged working state is mirrored.
    const edit = await vcs.recordEdit({
      head: CTX_HEAD,
      repoPath: REPO,
      actor: USER,
      edits: [
        { kind: "create", path: "index.ts", content: text("export const one = 1;\n") },
        { kind: "create", path: "lib/util.ts", content: text("export const u = 0;\n") },
      ],
    });
    expect(await hasTreeObject(blobsDir, edit.stateHash)).toBe(true);
    expect((await treeFiles(blobsDir, edit.stateHash)).map((file) => file.path)).toEqual([
      "index.ts",
      "lib/util.ts",
    ]);

    // Commit: the ctx-head commit state is mirrored.
    const committed = await vcs.commit({
      head: CTX_HEAD,
      repoPath: REPO,
      message: "initial",
      actor: USER,
    });
    expect(committed.status).toBe("committed");
    expect(await hasTreeObject(blobsDir, committed.stateHash)).toBe(true);
    expect((await treeFiles(blobsDir, committed.stateHash)).map((file) => file.path)).toEqual([
      "index.ts",
      "lib/util.ts",
    ]);

    // Push: the advanced main state is mirrored (repo-rooted).
    const pushed = await pushToMain(gad, { repoPaths: [REPO], sourceHead: CTX_HEAD, actor: USER });
    expect(pushed.status).toBe("pushed");
    const main = await vcs.resolveHead(VCS_MAIN_HEAD, REPO);
    expect(main).not.toBeNull();
    expect(await hasTreeObject(blobsDir, main!)).toBe(true);
    expect((await treeFiles(blobsDir, main!)).map((file) => file.path)).toEqual([
      "index.ts",
      "lib/util.ts",
    ]);

    // Composed workspace view (SERVER-minted, P5a): mirrored eagerly by the
    // local composition.
    const view = await vcs.repositories.workspaceView();
    expect(await hasTreeObject(blobsDir, view.stateHash)).toBe(true);
    const composed = await treeFiles(blobsDir, view.stateHash);
    // The composed view re-roots the repo's files under its repoPath.
    expect(composed.map((f) => f.path)).toEqual([`${REPO}/index.ts`, `${REPO}/lib/util.ts`]);
  });

  it("a follow-up edit over an existing base keeps every new state mirrored", async () => {
    await vcs.recordEdit({
      head: CTX_HEAD,
      repoPath: REPO,
      actor: USER,
      edits: [{ kind: "create", path: "a.txt", content: text("v1\n") }],
    });
    await vcs.commit({ head: CTX_HEAD, repoPath: REPO, message: "seed", actor: USER });
    const edited = await vcs.recordEdit({
      head: CTX_HEAD,
      repoPath: REPO,
      actor: USER,
      edits: [{ kind: "write", path: "a.txt", content: text("v2\n") }],
    });
    expect(await hasTreeObject(blobsDir, edited.stateHash)).toBe(true);
    const second = await vcs.commit({
      head: CTX_HEAD,
      repoPath: REPO,
      message: "v2",
      actor: USER,
    });
    expect(await hasTreeObject(blobsDir, second.stateHash)).toBe(true);
    expect(await vcs.readFile(second.stateHash, "a.txt")).toMatchObject({
      content: { kind: "text", text: "v2\n" },
    });
  });
});
