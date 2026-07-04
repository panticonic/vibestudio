import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { attachLocalHostBridges, pushToMain } from "../../../src/server/vcsHost/testSupport.js";
import { GadWorkspaceDO } from "../../../workspace/workers/gad-store/index.js";
import { WorkspaceVcs } from "../../../src/server/vcsHost/workspaceVcs.js";
import { VCS_MAIN_HEAD, vcsContextHead } from "../../../src/server/vcsHost/paths.js";
import type { GadCaller } from "../../../src/server/vcsHost/testSupport.js";
import { createRefService } from "../../../src/server/services/refService.js";
import type { RepoBuildReport } from "../../../src/server/buildV2/index.js";

type TestGad = Awaited<ReturnType<typeof createTestDO<GadWorkspaceDO>>>;

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

const USER = { id: "user", kind: "user" };
const text = (t: string) => ({ kind: "text" as const, text: t });

function report(
  partial: Pick<RepoBuildReport, "repoPath" | "required" | "status">
): RepoBuildReport {
  return { kind: "content", role: "pushed", builds: [], ...partial };
}

/**
 * End-to-end CONTEXT LIFECYCLE against a real gad-store DO. This is the seam
 * test for the per-repo VCS + editing-context reshape under the new
 * edit → commit → push model: it exercises the FULL stack (pin → edit+commit
 * several repos on ctx heads → status forked/ahead → advance main underneath →
 * status behind → rebase → build-gated ctx→main push → dropContext) and asserts
 * that drop leaves NO orphaned ctx heads / pin ref / cache entries. The
 * recurring seam bugs (push not using the ctx head, repoPath omitted, leaked
 * per-context state) must surface here.
 *
 * Note on the new model: `main` advances ONLY via push (never a direct
 * applyEdits), a ctx head is created at the FIRST COMMIT (not on the first
 * working edit), and `contextRepoState`/`resolveContextView` reflect WORKING
 * content. `editCtx` therefore records a working edit and immediately commits it
 * (the lifecycle assertions want committed ctx heads — forked/ahead/pushable);
 * `advanceMain` lands content on main through a throwaway context's
 * edit → commit → push (the only way main moves now).
 */
describe("WorkspaceVcs — full context lifecycle (e2e)", () => {
  let root: string;
  let workspaceRoot: string;
  let vcs: WorkspaceVcs;
  let gad: TestGad;
  let caller: GadCaller;
  // Mutable DO build-gate result (narrow-host P3: the gate lives in the DO's
  // vcsPush, fed by the `buildValidate` host bridge). Tests set this before a
  // pushToMain to model pass/fail; reset per test.
  let buildReports: RepoBuildReport[] = [];

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "gadvcs-life-"));
    workspaceRoot = path.join(root, "source");
    // Three repos across two sections + meta.
    await fsp.mkdir(path.join(workspaceRoot, "panels/chat"), { recursive: true });
    await fsp.writeFile(
      path.join(workspaceRoot, "panels/chat/index.tsx"),
      "export const Chat = () => null;\n"
    );
    await fsp.mkdir(path.join(workspaceRoot, "packages/foo"), { recursive: true });
    await fsp.writeFile(path.join(workspaceRoot, "packages/foo/index.ts"), "export const x = 1;\n");
    await fsp.mkdir(path.join(workspaceRoot, "packages/bar"), { recursive: true });
    await fsp.writeFile(path.join(workspaceRoot, "packages/bar/index.ts"), "export const y = 1;\n");
    await fsp.mkdir(path.join(workspaceRoot, "meta"), { recursive: true });
    await fsp.writeFile(path.join(workspaceRoot, "meta/vibez1.yml"), "name: test\n");

    gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad" });

    // The in-process test DO has no RPC gateway; give computeMerge a local

    // content store over this test's blob dir (production uses blobstore.* RPC).

    const refs = createRefService({ statePath: path.join(root, "refs"), gate: async () => {} });
    buildReports = [];
    attachLocalHostBridges(gad.instance, {
      blobsDir: path.join(root, "blobs"),
      refs,
      buildValidate: async () => buildReports,
    });
    caller = callerFor(gad);
    vcs = new WorkspaceVcs({
      blobsDir: path.join(root, "blobs"),
      workspaceRoot,
      contextsRoot: path.join(root, ".contexts"),
      buildSourcesRoot: path.join(root, "build-sources"),
      refs,
    });
    await vcs.attachGad(caller); // bootstraps per-repo mains from disk
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  // Edit a repo on its ctx head (record a working edit, then commit it — commit
  // is what forks the ctx head in the new model). Returns the commit result.
  async function editCtx(ctxId: string, repoPath: string, file: string, body: string) {
    const head = vcsContextHead(ctxId);
    await vcs.recordEdit({
      head,
      actor: USER,
      repoPath,
      edits: [{ kind: "write", path: file, content: text(body) }],
    });
    return vcs.commit({ head, repoPath, message: `edit ${repoPath}/${file}`, actor: USER });
  }
  // Advance a repo's main out-of-band. In the new model `main` advances ONLY via
  // push, so land the new content through a throwaway context's
  // edit → commit → push, then drop that context.
  async function advanceMain(repoPath: string, file: string, body: string) {
    const seed = vcsContextHead("__advance__");
    await vcs.recordEdit({
      head: seed,
      actor: USER,
      repoPath,
      edits: [{ kind: "write", path: file, content: text(body) }],
    });
    await vcs.commit({ head: seed, repoPath, message: `advance ${repoPath}`, actor: USER });
    buildReports = [report({ repoPath, required: true, status: "ok" })];
    const pushed = await pushToMain(gad, {
      repoPaths: [repoPath],
      sourceHead: seed,
      actor: USER,
    });
    expect(pushed.status).toBe("pushed");
    await vcs.dropContext("__advance__");
    return pushed;
  }
  // Every per-repo structured worktree head currently carrying a `ctx:<contextId>` head.
  async function ctxHeadRefs(contextId: string): Promise<string[]> {
    const head = vcsContextHead(contextId);
    const heads = await caller.call<Array<{ logId: string; head: string }>>("listWorktreeHeads", {
      head,
    });
    return heads.map((row) => row.logId);
  }
  async function pinRef(contextId: string): Promise<unknown> {
    return caller.call("getContextBase", { contextId });
  }

  it("drives a context through pin → multi-repo edit+commit → status → rebase → push → drop with no orphans", async () => {
    const ctxId = "life-1";
    const head = vcsContextHead(ctxId);

    // ── 1. Pin the context to the current workspace view ───────────────────
    const baseView = await vcs.pinContext(ctxId);
    expect(baseView).toBeTruthy();
    expect(await vcs.contextBaseView(ctxId)).toBe(baseView);
    // A fresh pin has no ctx heads — the composed view IS the pinned base.
    expect(await vcs.resolveContextView(ctxId)).toBe(baseView);
    expect(await ctxHeadRefs(ctxId)).toEqual([]);

    // ── 2. Edit+commit TWO repos on their ctx heads (commit forks the head) ─
    await editCtx(ctxId, "panels/chat", "index.tsx", "export const Chat = () => 1;\n");
    await editCtx(ctxId, "packages/foo", "index.ts", "export const x = 2;\n");
    // Both ctx heads now exist; their mains are untouched.
    expect(await vcs.resolveHead(head, "panels/chat")).toBeTruthy();
    expect(await vcs.resolveHead(head, "packages/foo")).toBeTruthy();
    expect((await ctxHeadRefs(ctxId)).length).toBe(2);

    // Composed view: edited repos at ctx head, others (bar/meta) at the pin.
    let view = await vcs.resolveContextView(ctxId);
    expect(view).not.toBe(baseView); // the edits moved it off the pin
    expect((await vcs.readFile(view, "panels/chat/index.tsx"))?.content).toMatchObject({
      kind: "text",
      text: expect.stringContaining("=> 1"),
    });
    expect((await vcs.readFile(view, "packages/foo/index.ts"))?.content).toMatchObject({
      kind: "text",
      text: expect.stringContaining("x = 2"),
    });
    // Unedited repo still reads the pinned base.
    expect((await vcs.readFile(view, "packages/bar/index.ts"))?.content).toMatchObject({
      kind: "text",
      text: expect.stringContaining("y = 1"),
    });

    // ── 3. contextStatus: committed repos are forked+ahead, nothing behind yet ─
    let status = await vcs.contextStatus(ctxId);
    expect(status.find((s) => s.repoPath === "panels/chat")).toMatchObject({
      forked: true,
      ahead: true,
      behind: false,
    });
    expect(status.find((s) => s.repoPath === "packages/foo")).toMatchObject({
      forked: true,
      ahead: true,
      behind: false,
    });
    // Unedited repos aren't interesting yet.
    expect(status.find((s) => s.repoPath === "packages/bar")).toBeUndefined();

    // ── 4. Advance an UNEDITED repo's main underneath the pin ──────────────
    await advanceMain("packages/bar", "index.ts", "export const y = 99;\n");
    // The pinned context still reads the OLD bar (the pin doesn't drift).
    view = await vcs.resolveContextView(ctxId);
    expect((await vcs.readFile(view, "packages/bar/index.ts"))?.content).toMatchObject({
      kind: "text",
      text: expect.stringContaining("y = 1;"),
    });
    // contextStatus now reports bar as behind (main moved past the pinned base).
    status = await vcs.contextStatus(ctxId);
    expect(status.find((s) => s.repoPath === "packages/bar")).toMatchObject({
      forked: false,
      ahead: false,
      behind: true,
    });

    // ── 5. rebaseContext: re-pin to latest; unedited bar advances, edits kept ─
    const rebased = await vcs.rebaseContext(ctxId, USER);
    expect(rebased.baseView).toBeTruthy();
    expect(rebased.baseView).not.toBe(baseView); // re-pinned to a newer view
    view = await vcs.resolveContextView(ctxId);
    // bar now reads the advanced main…
    expect((await vcs.readFile(view, "packages/bar/index.ts"))?.content).toMatchObject({
      kind: "text",
      text: expect.stringContaining("y = 99"),
    });
    // …and the chat edit survived the rebase.
    expect((await vcs.readFile(view, "panels/chat/index.tsx"))?.content).toMatchObject({
      kind: "text",
      text: expect.stringContaining("=> 1"),
    });
    // After rebase, nothing is "behind" (the pin caught up).
    status = await vcs.contextStatus(ctxId);
    expect(status.every((s) => s.behind === false)).toBe(true);

    // ── 6. Build-gated push of the edited repos (ctx head → main) ──────────
    // The push MUST read the SOURCE (ctx) head, not main: chat's main is still
    // `=> null`; only the ctx head has `=> 1`. A build failure must block.
    buildReports = [report({ repoPath: "panels/chat", required: true, status: "failed" })];
    const blocked = await pushToMain(gad, {
      repoPaths: ["panels/chat", "packages/foo"],
      sourceHead: head,
      actor: USER,
    });
    expect(blocked.status).toBe("build-failed");
    // main did NOT advance — chat's main is still the original.
    expect((await vcs.readFile(VCS_MAIN_HEAD, "index.tsx", "panels/chat"))?.content).toMatchObject({
      kind: "text",
      text: expect.stringContaining("=> null"),
    });

    // Now a passing build gate: the ctx edits land on main.
    buildReports = [
      report({ repoPath: "panels/chat", required: true, status: "ok" }),
      report({ repoPath: "packages/foo", required: true, status: "ok" }),
    ];
    const pushed = await pushToMain(gad, {
      repoPaths: ["panels/chat", "packages/foo"],
      sourceHead: head,
      actor: USER,
    });
    expect(pushed.status).toBe("pushed");
    // main now carries the ctx-head content (proves push used sourceHead).
    expect((await vcs.readFile(VCS_MAIN_HEAD, "index.tsx", "panels/chat"))?.content).toMatchObject({
      kind: "text",
      text: expect.stringContaining("=> 1"),
    });
    expect((await vcs.readFile(VCS_MAIN_HEAD, "index.ts", "packages/foo"))?.content).toMatchObject({
      kind: "text",
      text: expect.stringContaining("x = 2"),
    });

    // ── 7. dropContext: every ctx head + the pin + caches vanish ───────────
    // Pre-drop sanity: heads + pin exist.
    expect((await ctxHeadRefs(ctxId)).length).toBeGreaterThanOrEqual(2);
    expect(await pinRef(ctxId)).toBeTruthy();

    await vcs.dropContext(ctxId);

    // No orphaned ctx heads on ANY repo log.
    expect(await ctxHeadRefs(ctxId)).toEqual([]);
    expect(await vcs.resolveHead(head, "panels/chat")).toBeNull();
    expect(await vcs.resolveHead(head, "packages/foo")).toBeNull();
    // The pin ref is gone.
    expect(await pinRef(ctxId)).toBeNull();
    // In-memory caches cleared (base + materialization tracking).
    expect(await vcs.contextBaseView(ctxId)).toBeNull();
    expect(vcs.isContextRepoMaterialized(ctxId, "panels/chat")).toBe(false);
    expect(vcs.isContextRepoMaterialized(ctxId, "packages/foo")).toBe(false);

    // main is unaffected by the drop — the pushed work persists.
    expect((await vcs.readFile(VCS_MAIN_HEAD, "index.tsx", "panels/chat"))?.content).toMatchObject({
      kind: "text",
      text: expect.stringContaining("=> 1"),
    });
  });

  it("push of a context fast-forwards an UNCHANGED repo to up-to-date (no phantom advance)", async () => {
    const ctxId = "life-2";
    const head = vcsContextHead(ctxId);
    await vcs.pinContext(ctxId);
    // Edit+commit only foo; push BOTH foo and an unedited bar.
    await editCtx(ctxId, "packages/foo", "index.ts", "export const x = 7;\n");
    buildReports = [report({ repoPath: "packages/foo", required: true, status: "ok" })];
    const result = await pushToMain(gad, {
      repoPaths: ["packages/foo", "packages/bar"],
      sourceHead: head,
      actor: USER,
    });
    expect(result.status).toBe("pushed");
    // Only foo actually advanced; bar's ctx head was never forked so it stays at main.
    if (result.status === "pushed") {
      expect(result.repoPaths).toEqual(["packages/foo"]);
    }
    expect((await vcs.readFile(VCS_MAIN_HEAD, "index.ts", "packages/foo"))?.content).toMatchObject({
      kind: "text",
      text: expect.stringContaining("x = 7"),
    });
    await vcs.dropContext(ctxId);
    expect(await ctxHeadRefs(ctxId)).toEqual([]);
  });

  it("two contexts edit+commit the SAME repo independently; dropping one leaves the other intact", async () => {
    const a = "life-a";
    const b = "life-b";
    await vcs.pinContext(a);
    await vcs.pinContext(b);
    await editCtx(a, "packages/foo", "index.ts", "export const x = 10;\n");
    await editCtx(b, "packages/foo", "index.ts", "export const x = 20;\n");
    // Each context reads its OWN edit.
    expect(
      (await vcs.readFile(await vcs.resolveContextView(a), "packages/foo/index.ts"))?.content
    ).toMatchObject({ kind: "text", text: expect.stringContaining("x = 10") });
    expect(
      (await vcs.readFile(await vcs.resolveContextView(b), "packages/foo/index.ts"))?.content
    ).toMatchObject({ kind: "text", text: expect.stringContaining("x = 20") });

    await vcs.dropContext(a);
    // a's heads + pin gone; b untouched.
    expect(await ctxHeadRefs(a)).toEqual([]);
    expect(await vcs.contextBaseView(a)).toBeNull();
    expect((await ctxHeadRefs(b)).length).toBe(1);
    expect(await vcs.contextBaseView(b)).toBeTruthy();
    expect(
      (await vcs.readFile(await vcs.resolveContextView(b), "packages/foo/index.ts"))?.content
    ).toMatchObject({ kind: "text", text: expect.stringContaining("x = 20") });
  });

  it("forkContext is LINEAGE-TRUE: shares the source's committed base and copies its uncommitted working edits", async () => {
    const src = "fork-src";
    const dst = "fork-dst";
    const srcHead = vcsContextHead(src);
    const dstHead = vcsContextHead(dst);
    await vcs.pinContext(src);

    // The source carries BOTH kinds of state that fork must preserve distinctly:
    //  • a COMMITTED edit on foo — a real committed ctx-head state node, and
    //  • an UNCOMMITTED working edit on bar — a dirty row with no head yet.
    const srcCommit = await editCtx(src, "packages/foo", "index.ts", "export const x = 99;\n");
    expect(srcCommit.status).toBe("committed");
    const srcFooState = srcCommit.stateHash;
    expect(await vcs.resolveHead(srcHead, "packages/foo")).toBe(srcFooState);
    await vcs.recordEdit({
      head: srcHead,
      actor: USER,
      repoPath: "packages/bar",
      edits: [{ kind: "write", path: "index.ts", content: text("export const y = 42;\n") }],
    });
    const srcView = await vcs.resolveContextView(src);

    // Fork — lineage-true, not a snapshot flatten.
    await vcs.forkContext(src, dst);

    // (base) The child inherits the source's PINNED base — NOT a flattened
    // snapshot of the source's composed view (that was the OLD semantics, and
    // is exactly what would bake the uncommitted edit into a clean base).
    const srcBase = await vcs.contextBaseView(src);
    expect(await vcs.contextBaseView(dst)).toBe(srcBase);
    expect(await vcs.contextBaseView(dst)).not.toBe(srcView);

    // (a) The child's committed foo base IS the source's committed state node —
    // same state hash AND same commit event id, i.e. the SHARED ancestor node
    // (content-addressed) that getMergeBase relies on. Only the committed head
    // is inherited into gad_worktree_heads; bar (working-only) has no head row.
    expect(await vcs.resolveHead(dstHead, "packages/foo")).toBe(srcFooState);
    const dstHeadRefs = await ctxHeadRefs(dst);
    expect(dstHeadRefs.length).toBe(1);
    const [fooLogId] = dstHeadRefs;
    const srcRef = await caller.call<{ stateHash: string; commitEventId: string | null }>(
      "resolveWorktreeHead",
      { logId: fooLogId, head: srcHead }
    );
    const dstRef = await caller.call<{ stateHash: string; commitEventId: string | null }>(
      "resolveWorktreeHead",
      { logId: fooLogId, head: dstHead }
    );
    expect(dstRef.stateHash).toBe(srcRef.stateHash);
    expect(dstRef.commitEventId).toBe(srcRef.commitEventId); // shared commit identity

    // (b) The source's UNCOMMITTED bar edit is copied as the child's OWN
    // uncommitted working edit — visible in the composed view and reported
    // UNCOMMITTED (forked:false, no head), while foo reports committed+ahead.
    expect(
      (await vcs.readFile(await vcs.resolveContextView(dst), "packages/bar/index.ts"))?.content
    ).toMatchObject({ kind: "text", text: expect.stringContaining("y = 42") });
    const dstStatus = await vcs.contextStatus(dst);
    expect(dstStatus.find((s) => s.repoPath === "packages/bar")).toMatchObject({
      forked: false,
      uncommitted: true,
    });
    expect(dstStatus.find((s) => s.repoPath === "packages/foo")).toMatchObject({
      forked: true,
      uncommitted: false,
      ahead: true,
    });

    // (isolation + real merge-base) Committing a NEW edit on the fork diverges
    // without touching the source, and getMergeBase walks both foo tips back to
    // the SHARED committed ancestor — the lineage a later merge-back reconciles
    // against (a flattened base would leave the histories unrelated → null).
    const dstCommit = await editCtx(dst, "packages/foo", "index.ts", "export const x = 1234;\n");
    expect(
      (await vcs.readFile(await vcs.resolveContextView(dst), "packages/foo/index.ts"))?.content
    ).toMatchObject({ kind: "text", text: expect.stringContaining("x = 1234") });
    expect(
      (await vcs.readFile(await vcs.resolveContextView(src), "packages/foo/index.ts"))?.content
    ).toMatchObject({ kind: "text", text: expect.stringContaining("x = 99") });
    const mergeBase = await caller.call<{ baseStateHash: string | null }>("getMergeBase", {
      leftStateHash: srcFooState,
      rightStateHash: dstCommit.stateHash,
    });
    expect(mergeBase.baseStateHash).toBe(srcFooState);
  });

  it("records working edits then commits, exposing WORKING content before commit and committed content after", async () => {
    // New-model coverage: the dirty/working layer that the old applyEdits model
    // collapsed into a single committed advance. recordEdit makes the working
    // content visible (uncommitted + no ctx head + uncommitted status), and
    // commit folds it into the ctx head.
    const ctxId = "life-work";
    const head = vcsContextHead(ctxId);
    await vcs.pinContext(ctxId);

    // A working edit: no ctx head yet, but the content is visible + flagged.
    await vcs.recordEdit({
      head,
      actor: USER,
      repoPath: "packages/foo",
      edits: [{ kind: "write", path: "index.ts", content: text("export const x = 5;\n") }],
    });
    expect(await vcs.resolveHead(head, "packages/foo")).toBeNull(); // commit forks the head, not edit
    // contextRepoState reflects WORKING content — the edit is readable now.
    const workingView = await vcs.resolveContextView(ctxId);
    expect((await vcs.readFile(workingView, "packages/foo/index.ts"))?.content).toMatchObject({
      kind: "text",
      text: expect.stringContaining("x = 5"),
    });
    // status: uncommitted-only (no ctx head, so not yet ahead).
    let status = await vcs.contextStatus(ctxId);
    expect(status.find((s) => s.repoPath === "packages/foo")).toMatchObject({
      forked: false,
      uncommitted: true,
    });

    // Commit folds the working edit into the ctx head.
    const committed = await vcs.commit({
      head,
      repoPath: "packages/foo",
      message: "x = 5",
      actor: USER,
    });
    expect(committed.status).toBe("committed");
    expect(await vcs.resolveHead(head, "packages/foo")).toBe(committed.stateHash);
    status = await vcs.contextStatus(ctxId);
    expect(status.find((s) => s.repoPath === "packages/foo")).toMatchObject({
      forked: true,
      uncommitted: false,
      ahead: true,
    });

    await vcs.dropContext(ctxId);
    expect(await ctxHeadRefs(ctxId)).toEqual([]);
  });
});
