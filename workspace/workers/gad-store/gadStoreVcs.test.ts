/**
 * P5c — the edit/commit/revert COMPOSITION runs inside this DO, end-to-end
 * against the real GadWorkspaceDO with in-memory host bridges:
 *
 *  - `contentStore()` (production: host `blobstore.*` RPC) → an in-memory
 *    blob + tree store using the SHARED canonical hashing, so the DO's
 *    mirror-verification tripwire (`putTree(root).stateHash === staged`)
 *    genuinely exercises hash agreement;
 *  - `refsStore()` (production: host `refs.*` RPC) → an in-memory ref map.
 *
 * Covers: applyEditOps (compose + engine ops + provenance hunks + CAS guard +
 * mirroring), commitWorking (compose + exclude + re-key + vcs log),
 * revertWorking (inverse patch as working ops), resolveWorkingState
 * (absent vs composed), compose-base fallbacks (protected main ref via the
 * refs bridge; pinned-base slice via the content store), and the userland
 * `vcs*` read surface (camelCase rows, positional args).
 */
import { describe, expect, it, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { manifestHashForEntries, stateHashForRoot } from "@workspace/agentic-protocol";
import { GadWorkspaceDO } from "./index.js";

type TestGad = Awaited<ReturnType<typeof createTestDO<GadWorkspaceDO>>>;

type TreeEntry =
  | { name: string; kind: "file"; contentHash: string; mode: number }
  | { name: string; kind: "dir"; childHash: string };

const REPO = "packages/demo";
const LOG = `vcs:repo:${REPO}`;
const CTX = "ctx:t1";
const ACTOR = { kind: "agent" as const, id: "agent-1" };
const ACTOR_JSON = JSON.stringify(ACTOR);

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** In-memory host content store over the shared canonical tree hashing. */
function createMemoryHostStore() {
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, TreeEntry[]>();
  const states = new Map<string, string>(); // state:… → manifest:…

  const resolveRoot = (ref: string): string | null =>
    ref.startsWith("state:") ? (states.get(ref) ?? null) : ref;

  const walk = (
    manifestHash: string,
    prefix: string,
    out: Array<{ path: string; kind: string; contentHash?: string; mode?: number }>
  ): void => {
    const entries = trees.get(manifestHash);
    if (!entries) throw new Error(`memory store: missing interior tree ${manifestHash}`);
    for (const entry of entries) {
      const p = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.kind === "file") {
        out.push({ path: p, kind: "file", contentHash: entry.contentHash, mode: entry.mode });
      } else {
        out.push({ path: p, kind: "dir" });
        walk(entry.childHash, p, out);
      }
    }
  };

  const store = {
    async listTree(ref: string, opts?: { prefix?: string; limit?: number }) {
      const root = resolveRoot(ref);
      if (root === null || !trees.has(root)) return null;
      const out: Array<{ path: string; kind: string; contentHash?: string; mode?: number }> = [];
      walk(root, "", out);
      const prefix = opts?.prefix;
      return prefix ? out.filter((e) => e.path === prefix || e.path.startsWith(`${prefix}/`)) : out;
    },
    async getTree(ref: string) {
      const root = resolveRoot(ref);
      return root !== null && trees.has(root) ? trees.get(root)! : null;
    },
    async getBase64(digest: string) {
      const bytes = blobs.get(digest);
      return bytes ? bytes.toString("base64") : null;
    },
    async putBase64(bytesBase64: string) {
      const bytes = Buffer.from(bytesBase64, "base64");
      const digest = sha256Hex(bytes);
      blobs.set(digest, bytes);
      return { digest, size: bytes.length };
    },
    async putTree(entries: TreeEntry[], opts?: { root?: boolean }) {
      const treeHash = manifestHashForEntries(entries);
      trees.set(treeHash, entries);
      if (!opts?.root) return { treeHash };
      const stateHash = stateHashForRoot(treeHash);
      states.set(stateHash, treeHash);
      return { treeHash, stateHash };
    },
  };
  return { store, blobs, trees, states };
}

function createMemoryRefs() {
  const values = new Map<string, string>(); // repoPath → main state
  return {
    set(repo: string, _ref: string, value: string) {
      values.set(repo, value);
    },
    bridge: {
      async readMain(repoPath: string): Promise<{ stateHash: string } | null> {
        const stateHash = values.get(repoPath);
        return stateHash ? { stateHash } : null;
      },
      async listMains(): Promise<Array<{ repoPath: string; stateHash: string }>> {
        return [...values.entries()].map(([repoPath, stateHash]) => ({ repoPath, stateHash }));
      },
    },
  };
}

describe("GadWorkspaceDO — P5c edit/commit composition (real DO, memory bridges)", () => {
  let gad: TestGad;
  let doi: GadWorkspaceDO;
  let mem: ReturnType<typeof createMemoryHostStore>;
  let refs: ReturnType<typeof createMemoryRefs>;

  beforeEach(async () => {
    gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad-vcs" });
    doi = gad.instance;
    mem = createMemoryHostStore();
    refs = createMemoryRefs();
    Object.defineProperty(doi, "contentStore", { value: () => mem.store });
    Object.defineProperty(doi, "refsStore", { value: () => refs.bridge });
  });

  async function blobText(digest: string): Promise<string> {
    const b64 = await mem.store.getBase64(digest);
    if (b64 === null) throw new Error(`missing blob ${digest}`);
    return Buffer.from(b64, "base64").toString("utf8");
  }

  async function fileAt(stateHash: string, path: string): Promise<string> {
    const listing = await mem.store.listTree(stateHash);
    const entry = listing?.find((e) => e.path === path && e.kind === "file");
    if (!entry?.contentHash) throw new Error(`no ${path} at ${stateHash}`);
    return blobText(entry.contentHash);
  }

  function bindRuntimeCaller(callerKind: string, callerContextId?: string): void {
    const runtime = doi as unknown as {
      _currentVerifiedCaller: { callerId: string; callerKind: string } | null;
      _currentRpcCallerId: string | null;
      _currentRpcCallerKind: string | null;
      _currentCallerContextId: string | undefined;
    };
    runtime._currentVerifiedCaller = { callerId: `${callerKind}:test`, callerKind };
    runtime._currentRpcCallerId = `${callerKind}:test`;
    runtime._currentRpcCallerKind = callerKind;
    runtime._currentCallerContextId = callerContextId;
  }

  it("rejects non-canonical repo path aliases on the vcs surface", () => {
    // The DO's normalizeRepoPathArg must agree with the host's
    // normalizeRepoPathForLog / refService.validateRepoPath: `.`/`..`/empty
    // segments are rejected, not silently canonicalized, so one string backs
    // the `vcs:repo:<path>` log id and the on-disk projection.
    for (const bad of [
      "packages/./demo",
      "packages//demo",
      "./packages/demo",
      "packages/demo/",
      "/packages/demo",
      "..",
      "a/../b",
    ]) {
      expect(() => doi.vcsLog(bad), bad).toThrow(/Invalid workspace repo path/);
    }
    // The canonical form is accepted (empty log, but no throw).
    expect(doi.vcsLog(REPO)).toEqual([]);
  });

  it("applyEditOps composes the working state internally and mirrors it", async () => {
    const r1 = await doi.applyEditOps({
      logId: LOG,
      head: CTX,
      actorId: ACTOR.id,
      actorJson: ACTOR_JSON,
      edits: [
        { kind: "create", path: "a.txt", content: { kind: "text", text: "hello world\n" } },
        {
          kind: "create",
          path: "sub/b.bin",
          content: { kind: "bytes", base64: Buffer.from([0, 1, 2, 255]).toString("base64") },
        },
      ],
    });
    expect(r1.editSeq).toBe(1);
    expect(r1.changedPaths).toEqual(["a.txt", "sub/b.bin"]);
    // Mirroring invariant: the DO pushed the composed working tree to the
    // content store via putTree (bottom-up), root state node last.
    expect(await mem.store.getTree(r1.stateHash)).not.toBeNull();
    expect(await fileAt(r1.stateHash, "a.txt")).toBe("hello world\n");

    // Exact-range replace over the DO-composed base content.
    const r2 = await doi.applyEditOps({
      logId: LOG,
      head: CTX,
      actorId: ACTOR.id,
      actorJson: ACTOR_JSON,
      edits: [
        {
          kind: "replace",
          path: "a.txt",
          hunks: [{ start: 6, end: 11, oldText: "world", newText: "gad" }],
        },
      ],
    });
    expect(r2.editSeq).toBe(2);
    expect(await fileAt(r2.stateHash, "a.txt")).toBe("hello gad\n");

    // Whole-file write over TEXT carries hunk-level provenance (edit engine).
    await doi.applyEditOps({
      logId: LOG,
      head: CTX,
      actorId: ACTOR.id,
      actorJson: ACTOR_JSON,
      edits: [{ kind: "write", path: "a.txt", content: { kind: "text", text: "hello gad!\n" } }],
    });
    const rows = doi.listWorkingEdits({ logId: LOG, head: CTX });
    const writeRow = rows.find((r) => r["kind"] === "write");
    expect(writeRow?.["hunks_json"]).toBeTruthy();
  });

  it("enforces the edit-boundary path policy in the store", async () => {
    const edit = (path: string) =>
      doi.applyEditOps({
        logId: LOG,
        head: CTX,
        actorId: ACTOR.id,
        actorJson: ACTOR_JSON,
        edits: [{ kind: "create", path, content: { kind: "text", text: "x\n" } }],
      });
    await expect(edit("../escape.txt")).rejects.toThrow(/escapes worktree/);
    await expect(edit(".env")).rejects.toThrow(/platform-ignored/);
    await expect(edit("node_modules/x.js")).rejects.toThrow(/platform-ignored/);
    // Segments the tree encoder rejects must be refused at the boundary, not
    // stored as phantom working-map keys that only throw later at encode time.
    await expect(edit("a/./b")).rejects.toThrow(/valid tree path/);
    await expect(edit("a//b")).rejects.toThrow(/valid tree path/);
    await expect(edit("./a")).rejects.toThrow(/valid tree path/);
    await expect(edit("foo/")).rejects.toThrow(/valid tree path/);
    await expect(edit(".")).rejects.toThrow(/valid tree path/);
    await expect(edit("a\\b")).rejects.toThrow(/valid tree path/);
    await expect(edit("main")).resolves.toBeTruthy(); // ordinary file name is fine
  });

  it("rejects a stale baseStateHash (optimistic CAS guard)", async () => {
    await doi.applyEditOps({
      logId: LOG,
      head: CTX,
      actorId: ACTOR.id,
      actorJson: ACTOR_JSON,
      edits: [{ kind: "create", path: "a.txt", content: { kind: "text", text: "v1\n" } }],
    });
    await expect(
      doi.applyEditOps({
        logId: LOG,
        head: CTX,
        actorId: ACTOR.id,
        actorJson: ACTOR_JSON,
        baseStateHash: "state:" + "0".repeat(64),
        edits: [{ kind: "write", path: "a.txt", content: { kind: "text", text: "v2\n" } }],
      })
    ).rejects.toThrow(/edit CAS conflict/);
  });

  it("commitWorking composes + seals included rows, excludes stay working, unchanged when empty", async () => {
    await doi.applyEditOps({
      logId: LOG,
      head: CTX,
      actorId: ACTOR.id,
      actorJson: ACTOR_JSON,
      edits: [
        { kind: "create", path: "a.txt", content: { kind: "text", text: "A\n" } },
        { kind: "create", path: "keep.txt", content: { kind: "text", text: "K\n" } },
      ],
    });
    const commit = await doi.commitWorking({
      logId: LOG,
      head: CTX,
      message: "commit a only",
      actor: ACTOR,
      exclude: ["keep.txt"],
    });
    expect(commit.status).toBe("committed");
    expect(commit.editCount).toBe(1);
    expect(commit.transitionKind).toBe("snapshot");
    // The committed set excludes keep.txt; the committed state is mirrored.
    const committedPaths = (await mem.store.listTree(commit.stateHash))!
      .filter((e) => e.kind === "file")
      .map((e) => e.path);
    expect(committedPaths).toEqual(["a.txt"]);
    // The excluded row stays uncommitted; the included row was RE-KEYED.
    const working = doi.listWorkingEdits({ logId: LOG, head: CTX });
    expect(working.map((r) => r["path"])).toEqual(["keep.txt"]);
    const owned = doi.vcsCommitEdits(REPO, commit.eventId!);
    expect(owned).toHaveLength(1);
    expect(owned[0]!.path).toBe("a.txt");
    expect(owned[0]!.committedEventId).toBe(commit.eventId);
    expect(owned[0]!.outputStateHash).toBe(commit.stateHash);
    // vcs log (userland read surface) shows the commit, newest first.
    const log = doi.vcsLog(REPO, 10, CTX);
    expect(log[0]).toMatchObject({ summary: "commit a only", outputStateHash: commit.stateHash });
    // Nothing to seal ⇒ unchanged (the excluded row still pending is by design
    // only committed when included).
    const again = await doi.commitWorking({
      logId: LOG,
      head: CTX,
      message: "noop",
      actor: ACTOR,
      exclude: ["keep.txt"],
    });
    expect(again.status).toBe("unchanged");
  });

  it("revertWorking computes the inverse patch as working ops (by blob digest)", async () => {
    await doi.applyEditOps({
      logId: LOG,
      head: CTX,
      actorId: ACTOR.id,
      actorJson: ACTOR_JSON,
      edits: [
        { kind: "create", path: "a.txt", content: { kind: "text", text: "v1\n" } },
        { kind: "create", path: "gone.txt", content: { kind: "text", text: "bye\n" } },
      ],
    });
    const c1 = await doi.commitWorking({ logId: LOG, head: CTX, message: "c1", actor: ACTOR });
    await doi.applyEditOps({
      logId: LOG,
      head: CTX,
      actorId: ACTOR.id,
      actorJson: ACTOR_JSON,
      edits: [
        { kind: "write", path: "a.txt", content: { kind: "text", text: "v2\n" } },
        { kind: "delete", path: "gone.txt" },
        { kind: "create", path: "new.txt", content: { kind: "text", text: "n\n" } },
      ],
    });
    const c2 = await doi.commitWorking({ logId: LOG, head: CTX, message: "c2", actor: ACTOR });

    const reverted = await doi.revertWorking({
      logId: LOG,
      head: CTX,
      target: { stateHash: c2.stateHash },
      actorId: ACTOR.id,
      actorJson: ACTOR_JSON,
    });
    expect(reverted.changedPaths.sort()).toEqual(["a.txt", "gone.txt", "new.txt"]);
    // The reverted WORKING content equals c1's content.
    expect(await fileAt(reverted.stateHash, "a.txt")).toBe("v1\n");
    expect(await fileAt(reverted.stateHash, "gone.txt")).toBe("bye\n");
    const paths = (await mem.store.listTree(reverted.stateHash))!
      .filter((e) => e.kind === "file")
      .map((e) => e.path)
      .sort();
    expect(paths).toEqual(["a.txt", "gone.txt"]);
    expect(reverted.stateHash).toBe(c1.stateHash); // same content ⇒ same state
    // It landed as UNCOMMITTED ops, not a commit.
    expect(doi.listWorkingEdits({ logId: LOG, head: CTX }).length).toBeGreaterThan(0);
  });

  it("resolveWorkingState: null when the repo is absent; composed state otherwise", async () => {
    expect(await doi.resolveWorkingState({ logId: LOG, head: CTX })).toEqual({ stateHash: null });
    const r = await doi.applyEditOps({
      logId: LOG,
      head: CTX,
      actorId: ACTOR.id,
      actorJson: ACTOR_JSON,
      edits: [{ kind: "create", path: "a.txt", content: { kind: "text", text: "x\n" } }],
    });
    const resolved = await doi.resolveWorkingState({ logId: LOG, head: CTX });
    expect(resolved.stateHash).toBe(r.stateHash);
  });

  it("compose base falls back to the protected main ref through the refs bridge", async () => {
    // Craft a main state that exists ONLY in the content store (a ref value
    // the DO never recorded — the fresh-scan situation).
    const blob = await mem.store.putBase64(Buffer.from("from-main\n").toString("base64"));
    const root = await mem.store.putTree(
      [{ name: "seed.txt", kind: "file", contentHash: blob.digest, mode: 33188 }],
      { root: true }
    );
    refs.set(REPO, "main", root.stateHash!);

    const r = await doi.applyEditOps({
      logId: LOG,
      head: "ctx:fresh",
      actorId: ACTOR.id,
      actorJson: ACTOR_JSON,
      edits: [{ kind: "write", path: "seed.txt", content: { kind: "text", text: "edited\n" } }],
    });
    expect(r.baseStateHash).toBe(root.stateHash);
    expect(await fileAt(r.stateHash, "seed.txt")).toBe("edited\n");
    // The write over the main-ref base carries old→new provenance.
    const row = doi.listWorkingEdits({ logId: LOG, head: "ctx:fresh" })[0]!;
    expect(row["old_content_hash"]).toBe(blob.digest);
  });

  it("compose base uses the context's pinned-base slice from the content store", async () => {
    // A workspace-rooted pinned view: packages/demo/pinned.txt.
    const blob = await mem.store.putBase64(Buffer.from("pinned\n").toString("base64"));
    const demo = await mem.store.putTree([
      { name: "pinned.txt", kind: "file", contentHash: blob.digest, mode: 33188 },
    ]);
    const packagesDir = await mem.store.putTree([
      { name: "demo", kind: "dir", childHash: demo.treeHash },
    ]);
    const view = await mem.store.putTree(
      [{ name: "packages", kind: "dir", childHash: packagesDir.treeHash }],
      { root: true }
    );
    doi.setContextBase({ contextId: "pinned-ctx", stateHash: view.stateHash! });

    const r = await doi.applyEditOps({
      logId: LOG,
      head: "ctx:pinned-ctx",
      actorId: ACTOR.id,
      actorJson: ACTOR_JSON,
      edits: [{ kind: "create", path: "extra.txt", content: { kind: "text", text: "e\n" } }],
    });
    // The working state composes over the SLICE (repo-relative pinned.txt).
    expect(await fileAt(r.stateHash, "pinned.txt")).toBe("pinned\n");
    expect(await fileAt(r.stateHash, "extra.txt")).toBe("e\n");
  });

  it("confines composed context read surfaces to the caller's context lineage", async () => {
    const emptyView = await mem.store.putTree([], { root: true });
    doi.setContextBase({ contextId: "owner", stateHash: emptyView.stateHash! });
    doi.setContextBase({ contextId: "other", stateHash: emptyView.stateHash! });
    await doi.vcsForkContext({ sourceContextId: "owner", targetContextId: "child" });

    bindRuntimeCaller("panel", "owner");

    await expect(doi.vcsResolveContextView({ contextId: "owner" })).resolves.toEqual({
      stateHash: emptyView.stateHash,
    });
    await expect(doi.vcsContextStatus({ contextId: "owner" })).resolves.toEqual([]);
    await expect(doi.vcsResolveContextView({ contextId: "child" })).resolves.toEqual({
      stateHash: emptyView.stateHash,
    });
    await expect(doi.vcsContextStatus({ contextId: "child" })).resolves.toEqual([]);

    await expect(doi.vcsResolveContextView({ contextId: "other" })).rejects.toThrow(
      /not the caller's context/
    );
    await expect(doi.vcsContextStatus({ contextId: "other" })).rejects.toThrow(
      /not the caller's context/
    );

    bindRuntimeCaller("worker");
    await expect(doi.vcsResolveContextView({ contextId: "owner" })).rejects.toThrow(
      /has no context registration/
    );
  });

  it("the userland vcs read surface returns camelCase rows (positional args)", async () => {
    await doi.applyEditOps({
      logId: LOG,
      head: CTX,
      actorId: ACTOR.id,
      actorJson: ACTOR_JSON,
      invocationId: "inv-1",
      edits: [{ kind: "create", path: "a.txt", content: { kind: "text", text: "v1\n" } }],
    });
    const c1 = await doi.commitWorking({ logId: LOG, head: CTX, message: "c1", actor: ACTOR });

    const history = doi.vcsFileHistory(REPO, "a.txt", CTX);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      kind: "create",
      path: "a.txt",
      committedEventId: c1.eventId,
      actorId: ACTOR.id,
      invocationId: "inv-1",
    });
    // Workspace-relative path argument is stripped to repo-relative.
    expect(doi.vcsFileHistory(REPO, `${REPO}/a.txt`, CTX)).toHaveLength(1);

    const byActor = doi.vcsEditsByActor(ACTOR.id);
    expect(byActor.some((r) => r.path === "a.txt")).toBe(true);
    const byInvocation = doi.vcsEditsByInvocation("inv-1");
    expect(byInvocation).toHaveLength(1);

    const ancestors = doi.vcsCommitAncestors(REPO, c1.eventId!);
    expect(ancestors[0]).toMatchObject({ eventId: c1.eventId, stateHash: c1.stateHash });

    const log = doi.vcsLog(REPO, 10, CTX);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ summary: "c1", outputStateHash: c1.stateHash });
    // vcsLog defaults to `main` (no caller-context defaulting in userland).
    expect(doi.vcsLog(REPO)).toHaveLength(0);
  });
});

/**
 * U1 (insert-time hunk completeness), U2 (standing per-path chain check), and the
 * §5.2 blame RPC — against the real DO with the same in-memory host bridges.
 */
describe("GadWorkspaceDO — U1/U2 invariants + blame (real DO, memory bridges)", () => {
  let gad: TestGad;
  let doi: GadWorkspaceDO;
  let mem: ReturnType<typeof createMemoryHostStore>;
  let refs: ReturnType<typeof createMemoryRefs>;

  beforeEach(async () => {
    gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad-blame" });
    doi = gad.instance;
    mem = createMemoryHostStore();
    refs = createMemoryRefs();
    Object.defineProperty(doi, "contentStore", { value: () => mem.store });
    Object.defineProperty(doi, "refsStore", { value: () => refs.bridge });
  });

  type WorkOp = {
    kind: string;
    path: string;
    oldContentHash?: string | null;
    newContentHash?: string | null;
    hunks?: unknown;
    mode?: number | null;
    binary?: boolean | null;
  };
  /** Drive the private working-edit seam directly (the edit engine never emits a
   *  hunkless text replace, so U1 at this seam is exercised with crafted ops). */
  function insertWorking(head: string, ops: WorkOp[]): { editSeq: number } {
    return (
      doi as unknown as {
        insertWorkingEditRows: (i: {
          logId: string;
          head: string;
          actorId: string;
          actorJson: string;
          eventId: string;
          ops: WorkOp[];
          expectedEditSeq: number;
          expectedCommitHead: string | null;
        }) => { editSeq: number };
      }
    ).insertWorkingEditRows({
      logId: LOG,
      head,
      actorId: ACTOR.id,
      actorJson: ACTOR_JSON,
      eventId: `evt-${head}`,
      ops,
      expectedEditSeq: 0,
      expectedCommitHead: null,
    });
  }

  it("U1 (working seam): rejects hunkless text replace/write; accepts hunks/binary/create/delete/chmod/no-op", () => {
    // Reject: a content mutation over existing text with no hunks.
    expect(() =>
      insertWorking("ctx:w-rep", [
        { kind: "replace", path: "a.txt", oldContentHash: "old", newContentHash: "new" },
      ])
    ).toThrow(/hunk-completeness/);
    expect(() =>
      insertWorking("ctx:w-wri", [
        { kind: "write", path: "a.txt", oldContentHash: "old", newContentHash: "new" },
      ])
    ).toThrow(/hunk-completeness/);

    // Accept: hunks present.
    expect(
      insertWorking("ctx:w-hunk", [
        {
          kind: "replace",
          path: "a.txt",
          oldContentHash: "old",
          newContentHash: "new",
          hunks: [{ start: 0, end: 3, oldText: "old", newText: "new" }],
        },
      ]).editSeq
    ).toBe(1);
    // Accept: binary new content (threaded into the `binary` column, no hunks).
    expect(
      insertWorking("ctx:w-bin", [
        {
          kind: "write",
          path: "a.bin",
          oldContentHash: "old",
          newContentHash: "new",
          binary: true,
        },
      ]).editSeq
    ).toBe(1);
    expect(doi.listWorkingEdits({ logId: LOG, head: "ctx:w-bin" })[0]!["binary"]).toBe(1);
    // Accept: first write (no prior content), create, delete, chmod, and no-op writes.
    expect(
      insertWorking("ctx:w-fresh", [
        { kind: "write", path: "a.txt", oldContentHash: null, newContentHash: "new" },
      ]).editSeq
    ).toBe(1);
    expect(
      insertWorking("ctx:w-create", [
        { kind: "create", path: "a.txt", oldContentHash: null, newContentHash: "new" },
      ]).editSeq
    ).toBe(1);
    expect(
      insertWorking("ctx:w-del", [
        { kind: "delete", path: "a.txt", oldContentHash: "old", newContentHash: null },
      ]).editSeq
    ).toBe(1);
    expect(
      insertWorking("ctx:w-chmod", [
        { kind: "chmod", path: "a.txt", oldContentHash: "old", newContentHash: "old", mode: 33261 },
      ]).editSeq
    ).toBe(1);
    expect(
      insertWorking("ctx:w-noop", [
        { kind: "write", path: "a.txt", oldContentHash: "same", newContentHash: "same" },
      ]).editSeq
    ).toBe(1);
  });

  it("U1 (ingest editOps seam): rejects hunkless text replace; accepts synthetic/binary/hunked", async () => {
    const ingest = (head: string, op: Record<string, unknown>) =>
      doi.ingestWorktreeState({
        logId: LOG,
        head,
        files: [],
        actor: ACTOR,
        eventId: `ing-${head}`,
        editOps: [{ path: "a.txt", ...op }] as never,
      });

    await expect(
      ingest("ctx:i-bad", { kind: "replace", oldContentHash: "old", newContentHash: "new" })
    ).rejects.toThrow(/hunk-completeness/);
    // Synthetic snapshot ops (import/push/whole-file take) may omit hunks.
    await expect(
      ingest("ctx:i-syn", {
        kind: "replace",
        oldContentHash: "old",
        newContentHash: "new",
        synthetic: true,
      })
    ).resolves.toBeTruthy();
    await expect(
      ingest("ctx:i-bin", {
        kind: "write",
        oldContentHash: "old",
        newContentHash: "new",
        binary: true,
      })
    ).resolves.toBeTruthy();
    await expect(
      ingest("ctx:i-hunk", {
        kind: "replace",
        oldContentHash: "old",
        newContentHash: "new",
        hunks: [{ start: 0, end: 1, oldText: "o", newText: "n" }],
      })
    ).resolves.toBeTruthy();
    // The synthetic op is stamped on the row; the binary op set the binary column.
    expect(doi.vcsFileHistory(REPO, "a.txt", "ctx:i-syn")[0]).toMatchObject({ synthetic: true });
    expect(doi.vcsFileHistory(REPO, "a.txt", "ctx:i-bin")[0]).toMatchObject({ binary: true });
  });

  it("U1: a write of text over a binary file is a binary boundary (not a rejection)", async () => {
    await doi.applyEditOps({
      logId: LOG,
      head: CTX,
      actorId: ACTOR.id,
      actorJson: ACTOR_JSON,
      edits: [
        {
          kind: "create",
          path: "asset",
          content: { kind: "bytes", base64: Buffer.from([0, 1, 2, 255]).toString("base64") },
        },
      ],
    });
    // Text over the binary path: no line structure crosses the boundary, so the
    // op is recorded `binary` (blame chain-restart) rather than U1-rejected.
    await expect(
      doi.applyEditOps({
        logId: LOG,
        head: CTX,
        actorId: ACTOR.id,
        actorJson: ACTOR_JSON,
        invocationId: "inv-tob",
        edits: [{ kind: "write", path: "asset", content: { kind: "text", text: "now text\n" } }],
      })
    ).resolves.toBeTruthy();
    const row = doi.listWorkingEdits({ logId: LOG, head: CTX }).find((r) => r["kind"] === "write");
    expect(row?.["binary"]).toBe(1);
    // Blame attributes the line to the write op, flagged degraded 'binary'.
    const blame = await doi.vcsBlameLines(REPO, "asset", 1, 1, CTX);
    expect(blame[0]).toMatchObject({ invocationId: "inv-tob", degraded: "binary" });
  });

  it("U2: checkGadIntegrity catches a broken committed chain and passes a clean history", async () => {
    await doi.applyEditOps({
      logId: LOG,
      head: CTX,
      actorId: ACTOR.id,
      actorJson: ACTOR_JSON,
      edits: [{ kind: "create", path: "f.txt", content: { kind: "text", text: "L1\nL2\n" } }],
    });
    await doi.commitWorking({ logId: LOG, head: CTX, message: "c1", actor: ACTOR });
    await doi.applyEditOps({
      logId: LOG,
      head: CTX,
      actorId: ACTOR.id,
      actorJson: ACTOR_JSON,
      edits: [{ kind: "write", path: "f.txt", content: { kind: "text", text: "L1X\nL2\n" } }],
    });
    const c2 = await doi.commitWorking({ logId: LOG, head: CTX, message: "c2", actor: ACTOR });

    const clean = await doi.checkGadIntegrity();
    expect(clean.errors.filter((e) => e["type"] === "edit-op-chain")).toEqual([]);

    // Break op[k+1].old != op[k].new by corrupting the c2 write's old hash.
    gad.sql.exec(
      `UPDATE gad_worktree_edit_ops SET old_content_hash = 'deadbeef'
       WHERE committed_event_id = ? AND kind = 'write'`,
      c2.eventId
    );
    const broken = await doi.checkGadIntegrity();
    const chainErrors = broken.errors.filter((e) => e["type"] === "edit-op-chain");
    expect(chainErrors.length).toBeGreaterThan(0);
    expect(chainErrors[0]).toMatchObject({ path: "f.txt", kind: "write" });
  });

  it("blame: single-chain edits attribute to their commit; working tail hits the uncommitted op", async () => {
    await doi.applyEditOps({
      logId: LOG,
      head: CTX,
      actorId: ACTOR.id,
      actorJson: ACTOR_JSON,
      invocationId: "inv-create",
      edits: [
        { kind: "create", path: "f.txt", content: { kind: "text", text: "alpha\nbeta\ngamma\n" } },
      ],
    });
    const c1 = await doi.commitWorking({
      logId: LOG,
      head: CTX,
      message: "create f",
      actor: ACTOR,
      invocationId: "inv-create",
    });
    await doi.applyEditOps({
      logId: LOG,
      head: CTX,
      actorId: ACTOR.id,
      actorJson: ACTOR_JSON,
      invocationId: "inv-edit",
      edits: [
        {
          kind: "replace",
          path: "f.txt",
          hunks: [{ start: 6, end: 10, oldText: "beta", newText: "BETA" }],
        },
      ],
    });
    const c2 = await doi.commitWorking({
      logId: LOG,
      head: CTX,
      message: "edit line 2",
      actor: ACTOR,
      invocationId: "inv-edit",
    });

    // §9 provenance_for_file view: edit ops ⋈ invocations ⋈ commit message.
    const view = doi.query(
      `SELECT path, kind, commit_message, invocation_id
       FROM provenance_for_file
       WHERE log_id = ? AND path = 'f.txt' AND commit_event_id = ?`,
      [LOG, c2.eventId]
    ).rows;
    expect(view).toContainEqual(
      expect.objectContaining({ commit_message: "edit line 2", invocation_id: "inv-edit" })
    );

    const blame = await doi.vcsBlameLines(REPO, "f.txt", 1, 3, CTX);
    const l2 = blame.find((b) => b.startLine <= 2 && b.endLine >= 2)!;
    expect(l2).toMatchObject({
      commitEventId: c2.eventId,
      commitMessage: "edit line 2",
      invocationId: "inv-edit",
      kind: "replace",
      degraded: null,
    });
    // Unchanged lines existed since creation → a `create` semantic stop on c1.
    const l1 = blame.find((b) => b.startLine <= 1 && b.endLine >= 1)!;
    expect(l1).toMatchObject({ commitEventId: c1.eventId, kind: "create", degraded: "create" });

    // Working tail: an uncommitted edit blames to the working op (no commit).
    await doi.applyEditOps({
      logId: LOG,
      head: CTX,
      actorId: ACTOR.id,
      actorJson: ACTOR_JSON,
      invocationId: "inv-working",
      edits: [
        {
          kind: "replace",
          path: "f.txt",
          hunks: [{ start: 0, end: 5, oldText: "alpha", newText: "ALPHA" }],
        },
      ],
    });
    const tail = await doi.vcsBlameLines(REPO, "f.txt", 1, 1, CTX);
    expect(tail[0]).toMatchObject({
      commitEventId: null,
      invocationId: "inv-working",
      degraded: null,
    });
  });

  it("blame: an inline edit later in a line attributes that line to the edit", async () => {
    await doi.applyEditOps({
      logId: LOG,
      head: CTX,
      actorId: ACTOR.id,
      actorJson: ACTOR_JSON,
      invocationId: "inv-create-inline",
      edits: [
        {
          kind: "create",
          path: "inline.txt",
          content: { kind: "text", text: "alpha beta gamma\nsecond\n" },
        },
      ],
    });
    await doi.commitWorking({
      logId: LOG,
      head: CTX,
      message: "create inline",
      actor: ACTOR,
      invocationId: "inv-create-inline",
    });
    await doi.applyEditOps({
      logId: LOG,
      head: CTX,
      actorId: ACTOR.id,
      actorJson: ACTOR_JSON,
      invocationId: "inv-inline",
      edits: [
        {
          kind: "replace",
          path: "inline.txt",
          hunks: [{ start: 6, end: 10, oldText: "beta", newText: "BETA" }],
        },
      ],
    });
    const c2 = await doi.commitWorking({
      logId: LOG,
      head: CTX,
      message: "inline edit",
      actor: ACTOR,
      invocationId: "inv-inline",
    });

    const blame = await doi.vcsBlameLines(REPO, "inline.txt", 1, 1, CTX);
    expect(blame).toEqual([
      expect.objectContaining({
        commitEventId: c2.eventId,
        commitMessage: "inline edit",
        invocationId: "inv-inline",
        kind: "replace",
        degraded: null,
      }),
    ]);
  });

  it("blame: a real merge routes theirs-origin lines to the other parent; a whole-file take degrades", async () => {
    const OURS = "ctx:ours";
    const THEIRS = "ctx:theirs";
    // Shared base commit on ours: f.txt (4 lines) + g.txt (2 lines).
    await doi.applyEditOps({
      logId: LOG,
      head: OURS,
      actorId: ACTOR.id,
      actorJson: ACTOR_JSON,
      edits: [
        { kind: "create", path: "f.txt", content: { kind: "text", text: "L1\nL2\nL3\nL4\n" } },
        { kind: "create", path: "g.txt", content: { kind: "text", text: "G1\nG2\n" } },
      ],
    });
    const base = await doi.commitWorking({ logId: LOG, head: OURS, message: "base", actor: ACTOR });
    // Publish the base as main so a fresh `theirs` head branches from it.
    refs.set(REPO, "main", base.stateHash);

    // ours changes f.txt line 1 only.
    await doi.applyEditOps({
      logId: LOG,
      head: OURS,
      actorId: ACTOR.id,
      actorJson: ACTOR_JSON,
      invocationId: "inv-ours",
      edits: [
        { kind: "write", path: "f.txt", content: { kind: "text", text: "OURS\nL2\nL3\nL4\n" } },
      ],
    });
    const cOurs = await doi.commitWorking({
      logId: LOG,
      head: OURS,
      message: "ours edits line 1",
      actor: ACTOR,
      invocationId: "inv-ours",
    });

    // theirs (branched from main=base) changes f.txt line 4 AND all of g.txt.
    await doi.applyEditOps({
      logId: LOG,
      head: THEIRS,
      actorId: ACTOR.id,
      actorJson: ACTOR_JSON,
      invocationId: "inv-theirs",
      edits: [
        { kind: "write", path: "f.txt", content: { kind: "text", text: "L1\nL2\nL3\nTHEIRS\n" } },
        { kind: "write", path: "g.txt", content: { kind: "text", text: "G1\nGX\n" } },
      ],
    });
    const cTheirs = await doi.commitWorking({
      logId: LOG,
      head: THEIRS,
      message: "theirs edits line 4 + g",
      actor: ACTOR,
      invocationId: "inv-theirs",
    });

    const merge = await doi.vcsMerge({
      logId: LOG,
      targetHead: OURS,
      sourceHead: THEIRS,
      actor: ACTOR,
    });
    expect(merge.status).toBe("merged");

    // f.txt is line-merged: line 1 stays on the ours chain, line 4 routes to theirs.
    const fBlame = await doi.vcsBlameLines(REPO, "f.txt", 1, 4, OURS);
    const f1 = fBlame.find((b) => b.startLine <= 1 && b.endLine >= 1)!;
    expect(f1).toMatchObject({ commitEventId: cOurs.eventId, invocationId: "inv-ours" });
    const f4 = fBlame.find((b) => b.startLine <= 4 && b.endLine >= 4)!;
    expect(f4).toMatchObject({
      commitEventId: cTheirs.eventId,
      invocationId: "inv-theirs",
      degraded: null,
    });

    // g.txt was a whole-file take-theirs (no line hunks) → synthetic merge op →
    // a degraded blame stop that reports the merge commit, not the healing actor.
    const gBlame = await doi.vcsBlameLines(REPO, "g.txt", 1, 1, OURS);
    expect(gBlame[0]).toMatchObject({
      commitEventId: (merge as { eventId: string }).eventId,
      degraded: "synthetic",
    });

    // The merge left the standing chain check clean (synthetic take restarts; the
    // line-merged file's hunked op continues the first parent).
    const integrity = await doi.checkGadIntegrity();
    expect(integrity.errors.filter((e) => e["type"] === "edit-op-chain")).toEqual([]);
  });

  it("blame + U2 on a CONFLICTED merge resolution: cleanly-taken incoming files carry merge provenance, resolved regions blame the resolver, and the committed chain stays continuous (blame-1 + blame-2)", async () => {
    const OURS = "ctx:c-ours";
    const THEIRS = "ctx:c-theirs";
    // Shared base commit on ours: f.txt (3 lines) + g.txt (2 lines).
    await doi.applyEditOps({
      logId: LOG,
      head: OURS,
      actorId: ACTOR.id,
      actorJson: ACTOR_JSON,
      edits: [
        { kind: "create", path: "f.txt", content: { kind: "text", text: "L1\nL2\nL3\n" } },
        { kind: "create", path: "g.txt", content: { kind: "text", text: "G1\nG2\n" } },
      ],
    });
    const base = await doi.commitWorking({ logId: LOG, head: OURS, message: "base", actor: ACTOR });
    // Publish the base as main so a fresh `theirs` head branches from it.
    refs.set(REPO, "main", base.stateHash);

    // ours changes f.txt line 1.
    await doi.applyEditOps({
      logId: LOG,
      head: OURS,
      actorId: ACTOR.id,
      actorJson: ACTOR_JSON,
      invocationId: "inv-ours",
      edits: [{ kind: "write", path: "f.txt", content: { kind: "text", text: "OURS\nL2\nL3\n" } }],
    });
    await doi.commitWorking({
      logId: LOG,
      head: OURS,
      message: "ours edits line 1",
      actor: ACTOR,
      invocationId: "inv-ours",
    });

    // theirs (branched from main=base) changes f.txt line 1 DIFFERENTLY (→ a
    // CONFLICT on f.txt), rewrites g.txt line 2 (→ a clean take-theirs), and
    // adds a brand-new file d.txt (→ a clean incoming create). None of g.txt /
    // d.txt carry a resolution working row — they are the blame-1 surface.
    await doi.applyEditOps({
      logId: LOG,
      head: THEIRS,
      actorId: ACTOR.id,
      actorJson: ACTOR_JSON,
      invocationId: "inv-theirs",
      edits: [
        { kind: "write", path: "f.txt", content: { kind: "text", text: "THEIRS\nL2\nL3\n" } },
        { kind: "write", path: "g.txt", content: { kind: "text", text: "G1\nGX\n" } },
        { kind: "create", path: "d.txt", content: { kind: "text", text: "D1\n" } },
      ],
    });
    const cTheirs = await doi.commitWorking({
      logId: LOG,
      head: THEIRS,
      message: "theirs edits line 1 + g + adds d",
      actor: ACTOR,
      invocationId: "inv-theirs",
    });
    expect(cTheirs.status).toBe("committed");

    // Merge theirs → ours: f.txt conflicts; g.txt + d.txt auto-apply cleanly.
    const merge = await doi.vcsMerge({
      logId: LOG,
      targetHead: OURS,
      sourceHead: THEIRS,
      actor: ACTOR,
    });
    expect(merge.status).toBe("conflicted");
    expect((merge as { conflictPaths: string[] }).conflictPaths).toContain("f.txt");

    // The agent resolves f.txt via vcs.edit (working ops over the provisional,
    // conflict-marked base) and seals the merge with a commit.
    await doi.applyEditOps({
      logId: LOG,
      head: OURS,
      actorId: ACTOR.id,
      actorJson: ACTOR_JSON,
      invocationId: "inv-resolve",
      edits: [
        { kind: "write", path: "f.txt", content: { kind: "text", text: "RESOLVED\nL2\nL3\n" } },
      ],
    });
    const resolved = await doi.commitWorking({
      logId: LOG,
      head: OURS,
      message: "resolve f.txt conflict",
      actor: ACTOR,
      invocationId: "inv-resolve",
    });
    expect(resolved.status).toBe("committed");
    expect(resolved.transitionKind).toBe("merge-resolution");

    // (a) blame-1 — cleanly-taken THEIRS content carries MERGE provenance, never
    // a silent mis-blame onto the base `create`.
    //   g.txt line 2 is a whole-file take-theirs → synthetic op on the
    //   resolution commit (degraded, but pointing at the merge, not the base).
    const gBlame = await doi.vcsBlameLines(REPO, "g.txt", 2, 2, OURS);
    expect(gBlame[0]).toMatchObject({ commitEventId: resolved.eventId, degraded: "synthetic" });
    expect(gBlame[0]!.commitEventId).not.toBe(base.eventId);
    //   d.txt is a brand-new incoming file → a `create` op on the resolution
    //   commit (was `older-than-log` with a null commit before the fix).
    const dBlame = await doi.vcsBlameLines(REPO, "d.txt", 1, 1, OURS);
    expect(dBlame[0]).toMatchObject({ commitEventId: resolved.eventId, degraded: "create" });
    expect(dBlame[0]!.commitEventId).not.toBeNull();

    // (b) blame-2 — the resolution commit's per-path chain composes from OURS:
    // the standing edit-op-chain continuity check stays clean on a conflicted
    // merge (the OURS→provisional bridge restarts the chain vs the OURS parent).
    const integrity = await doi.checkGadIntegrity();
    expect(integrity.errors.filter((e) => e["type"] === "edit-op-chain")).toEqual([]);

    // (c) authorship — a resolved region blames the RESOLVING session's own edit
    // op (merge-notes invariant 4 survives the bridge restart).
    const fBlame = await doi.vcsBlameLines(REPO, "f.txt", 1, 1, OURS);
    expect(fBlame[0]).toMatchObject({
      commitEventId: resolved.eventId,
      invocationId: "inv-resolve",
      degraded: null,
    });
    // Sanity: the merge recorded THEIRS as the second parent (event-keyed).
    expect(cTheirs.eventId).toBeTruthy();
  });
});
