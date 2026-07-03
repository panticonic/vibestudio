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
      return prefix
        ? out.filter((e) => e.path === prefix || e.path.startsWith(`${prefix}/`))
        : out;
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
