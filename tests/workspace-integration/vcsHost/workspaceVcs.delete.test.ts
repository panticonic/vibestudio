import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { attachLocalHostBridges, pushToMain } from "../../../src/server/vcsHost/testSupport.js";
import { GadWorkspaceDO } from "../../../workspace/workers/gad-store/index.js";
import { WorkspaceVcs } from "../../../src/server/vcsHost/workspaceVcs.js";
import { VCS_MAIN_HEAD, logIdForRepo, vcsContextHead } from "../../../src/server/vcsHost/paths.js";
import type { GadCaller } from "../../../src/server/vcsHost/testSupport.js";
import { createRefService } from "../../../src/server/services/refService.js";
import type { RefGateBatch } from "../../../src/server/services/refService.js";
import { createMainRefAdvanceGate } from "../../../src/server/services/mainAdvanceApproval.js";
import type {
  RepoDeletionApprovalCandidate,
  RepoRestoreApprovalCandidate,
} from "../../../src/server/services/mainAdvanceApproval.js";
import type { StateAdvancedEvent } from "../../../src/server/buildV2/stateTrigger.js";
import type { VerifiedCaller } from "@vibez1/shared/serviceDispatcher";

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
// A minimal verified caller — the delete/restore ref gate raises the severe
// prompt for this principal; the no-op gate below ignores it, and the denial
// tests drive rejection through the injected `gateHook` instead.
const CALLER = { runtime: { kind: "app", id: "cli" } } as unknown as VerifiedCaller;

/**
 * Whole-repo deletion is a SEVERE, global-state action: it archives a repo's
 * history (to a recoverable, non-`main` head) and drops the repo from the
 * composed workspace view. This is the explicit, approval-gated counterpart to
 * `snapshotDir`'s deliberate refusal to INFER deletions from a missing dir.
 */
describe("WorkspaceVcs — whole-repo deletion", () => {
  let root: string;
  let workspaceRoot: string;
  let vcs: WorkspaceVcs;
  let gad: TestGad;
  let caller: GadCaller;
  let refs: ReturnType<typeof createRefService>;
  // Delete/restore approval now flows through the ref gate (classification of
  // null-next / previously-deleted-recreate entries). Tests default to a no-op
  // gate; the denial cases swap in a throwing hook.
  let gateHook: (batch: RefGateBatch) => Promise<void>;

  beforeEach(async () => {
    gateHook = async () => {};
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "gadvcs-del-"));
    workspaceRoot = path.join(root, "source");
    await fsp.mkdir(path.join(workspaceRoot, "packages/foo"), { recursive: true });
    await fsp.writeFile(path.join(workspaceRoot, "packages/foo/index.ts"), "export const x = 1;\n");
    await fsp.mkdir(path.join(workspaceRoot, "packages/bar"), { recursive: true });
    await fsp.writeFile(path.join(workspaceRoot, "packages/bar/index.ts"), "export const y = 1;\n");
    await fsp.mkdir(path.join(workspaceRoot, "meta"), { recursive: true });
    await fsp.writeFile(path.join(workspaceRoot, "meta/vibez1.yml"), "name: test\n");

    gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad" });

    // The in-process test DO has no RPC gateway; give computeMerge a local

    // content store over this test's blob dir (production uses blobstore.* RPC).

    caller = callerFor(gad);
    refs = createRefService({
      statePath: path.join(root, "refs"),
      gate: (batch) => gateHook(batch),
    });
    attachLocalHostBridges(gad.instance, { blobsDir: path.join(root, "blobs"), refs });
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

  const repoPaths = async () => (await vcs.discoverRepos()).map((r) => r.repoPath);
  const worktreeHead = (repoPath: string, head: string) =>
    caller.call<{ stateHash: string } | null>("resolveWorktreeHead", {
      logId: logIdForRepo(repoPath),
      head,
    });
  // Fork a repo onto a context head (what an agent's context does): a working
  // edit folded into a deliberate commit, which is what creates the ctx head.
  async function forkCtx(ctxId: string, repoPath: string, file: string, body: string) {
    const head = vcsContextHead(ctxId);
    await vcs.recordEdit({
      head,
      actor: USER,
      repoPath,
      edits: [{ kind: "write", path: file, content: { kind: "text", text: body } }],
    });
    return vcs.commit({ head, repoPath, message: `fork ${repoPath}`, actor: USER });
  }

  it("archives history, drops the repo from global state, and removes its working tree", async () => {
    expect(await repoPaths()).toContain("packages/foo");

    const events: StateAdvancedEvent[] = [];
    const off = vcs.onStateAdvanced((e) => events.push(e));

    const result = await vcs.deleteRepo({ repoPath: "packages/foo", actor: USER, caller: CALLER });
    off();

    // Archived (recoverable) + reported the removed path.
    expect(result.archived).toBe(true);
    expect(result.archiveHead).toBeTruthy();
    expect(result.removedPaths).toContain("packages/foo/index.ts");

    // Dropped from the composed workspace view / global state.
    expect(await repoPaths()).not.toContain("packages/foo");
    expect(await repoPaths()).toContain("packages/bar");
    expect(await vcs.resolveHead(VCS_MAIN_HEAD, "packages/foo")).toBeNull();
    const view = await vcs.workspaceView();
    expect(await vcs.readFile(view.stateHash, "packages/foo/index.ts")).toBeNull();
    expect(await vcs.readFile(view.stateHash, "packages/bar/index.ts")).not.toBeNull();

    // The live `main` worktree head is gone; the archive head carries history.
    expect(await worktreeHead("packages/foo", VCS_MAIN_HEAD)).toBeNull();
    expect(await worktreeHead("packages/foo", result.archiveHead!)).not.toBeNull();

    // A `main` advance was emitted with the removed file (so build/tree react).
    const mainAdvance = events.find((e) => e.head === VCS_MAIN_HEAD);
    expect(mainAdvance?.changedPaths).toContain("packages/foo/index.ts");

    // On-disk subtree removed.
    await expect(fsp.access(path.join(workspaceRoot, "packages/foo"))).rejects.toThrow();
  });

  it("restores the protected ref when archive fails after ref deletion", async () => {
    const before = refs.readMain("packages/foo");
    expect(before).not.toBeNull();
    const originalCall = caller.call.bind(caller);
    caller.call = async <T>(method: string, input: unknown): Promise<T> => {
      if (method === "archiveRepoMain") throw new Error("archive unavailable");
      return originalCall<T>(method, input);
    };

    await expect(vcs.deleteRepo({ repoPath: "packages/foo", actor: USER, caller: CALLER })).rejects.toThrow(
      /archive unavailable/
    );

    expect(refs.readMain("packages/foo")?.stateHash).toBe(before!.stateHash);
    expect(await worktreeHead("packages/foo", VCS_MAIN_HEAD)).not.toBeNull();
    expect(await repoPaths()).toContain("packages/foo");
    await expect(
      fsp.access(path.join(workspaceRoot, "packages/foo/index.ts"))
    ).resolves.toBeUndefined();
  });

  it("removes the repo's main on delete (retaining a delete log entry) and re-adopts it on restore", async () => {
    // Bootstrap seeded the repo's main into the protected-ref store.
    expect(refs.readMain("packages/foo")).toMatchObject({
      seq: 1,
      stateHash: expect.stringMatching(/^state:/),
    });

    await vcs.deleteRepo({ repoPath: "packages/foo", actor: USER, caller: CALLER });

    // The main is removed, but the movement log is RETAINED with a nullable
    // delete entry (new: null) — the restore-classification source (§2.1).
    expect(refs.readMain("packages/foo")).toBeNull();
    const log = refs.readMainLog({ repoPath: "packages/foo" });
    expect(log[log.length - 1]).toMatchObject({ new: null, operation: "delete" });
    // Other repos' mains are untouched.
    expect(refs.readMain("packages/bar")).not.toBeNull();

    // Restore re-adopts the archived head; seq keeps increasing across the
    // retained history (delete then re-create).
    await vcs.restoreRepo({ repoPath: "packages/foo", actor: USER, caller: CALLER });
    const restored = refs.readMain("packages/foo");
    expect(restored?.stateHash).toBe(await vcs.resolveHead(VCS_MAIN_HEAD, "packages/foo"));
  });

  it("lets a fresh repo at the same path start clean (no inherited history)", async () => {
    await vcs.deleteRepo({ repoPath: "packages/foo", actor: USER, caller: CALLER });

    // Re-create the repo on disk with new content and re-seed its main.
    await fsp.mkdir(path.join(workspaceRoot, "packages/foo"), { recursive: true });
    await fsp.writeFile(
      path.join(workspaceRoot, "packages/foo/index.ts"),
      "export const reborn = true;\n"
    );
    await vcs.ensureRepoLogsFromDisk();

    expect(await repoPaths()).toContain("packages/foo");
    // The new main's log is fresh — a single seed commit, not the old lineage.
    const log = await gad.instance.vcsLog("packages/foo", 50, VCS_MAIN_HEAD);
    expect(log.length).toBe(1);
    const view = await vcs.workspaceView();
    expect((await vcs.readFile(view.stateHash, "packages/foo/index.ts"))?.content).toMatchObject({
      kind: "text",
      text: expect.stringContaining("reborn"),
    });
  });

  it("classifies the deletion at the ref gate and aborts cleanly on denial", async () => {
    // The ref gate sees a single null-next entry (the severe deletion shape);
    // a denial there throws before the swap, so no ref/archive/disk mutation.
    const seen: RefGateBatch[] = [];
    gateHook = async (batch) => {
      seen.push(batch);
      throw new Error("denied by user");
    };
    await expect(
      vcs.deleteRepo({ repoPath: "packages/foo", actor: USER, caller: CALLER })
    ).rejects.toThrow(/denied by user/);

    // The gate saw exactly one delete-shaped entry (next: null) for the target.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.operation).toBe("delete");
    expect(seen[0]!.entries).toEqual([
      expect.objectContaining({ repoPath: "packages/foo", next: null }),
    ]);
    // Nothing changed: repo still present in global state, main ref intact, tree on disk.
    expect(await repoPaths()).toContain("packages/foo");
    expect(await worktreeHead("packages/foo", VCS_MAIN_HEAD)).not.toBeNull();
    await expect(fsp.access(path.join(workspaceRoot, "packages/foo"))).resolves.toBeUndefined();
  });

  it("refuses to delete the meta repo and unknown repos", async () => {
    await expect(vcs.deleteRepo({ repoPath: "meta", actor: USER, caller: CALLER })).rejects.toThrow(/meta/);
    await expect(vcs.deleteRepo({ repoPath: "packages/ghost", actor: USER, caller: CALLER })).rejects.toThrow(
      /no committed `main`/
    );
  });

  it("refuses to resurrect a deleted repo via a stale context's push", async () => {
    // An agent forked the repo onto its context head BEFORE the deletion.
    await forkCtx("agent-1", "packages/foo", "index.ts", "export const x = 99;\n");
    await vcs.deleteRepo({ repoPath: "packages/foo", actor: USER, caller: CALLER });

    // The stale context still carries its ctx head; a push must NOT recreate main.
    await expect(
      pushToMain(gad, {
        repoPaths: ["packages/foo"],
        sourceHead: vcsContextHead("agent-1"),
        actor: USER,
      })
    ).rejects.toThrow(/was deleted/);
    // main stays absent — no silent resurrection.
    expect(await vcs.resolveHead(VCS_MAIN_HEAD, "packages/foo")).toBeNull();
    expect(await repoPaths()).not.toContain("packages/foo");
  });

  it("flags a deleted repo in contextStatus (distinct from a brand-new unpushed repo)", async () => {
    await vcs.pinContext("agent-1");
    // The context forks an existing repo AND creates a brand-new one.
    await forkCtx("agent-1", "packages/foo", "index.ts", "export const x = 2;\n");
    await forkCtx("agent-1", "packages/newbie", "index.ts", "export const n = 1;\n");
    // The existing repo is deleted out from under the context.
    await vcs.deleteRepo({ repoPath: "packages/foo", actor: USER, caller: CALLER });

    const status = await vcs.contextStatus("agent-1");
    // The deleted repo is flagged so the agent sees it BEFORE a push fails.
    expect(status.find((s) => s.repoPath === "packages/foo")).toMatchObject({ deleted: true });
    // A brand-new unpushed repo also has no main, but is NOT flagged deleted.
    expect(status.find((s) => s.repoPath === "packages/newbie")).toMatchObject({
      deleted: false,
      forked: true,
    });
    // An untouched existing repo is not flagged either.
    expect(status.find((s) => s.repoPath === "packages/bar")?.deleted ?? false).toBe(false);
  });

  it("restores a deleted repo from its archive, re-adding it to global state", async () => {
    await vcs.deleteRepo({ repoPath: "packages/foo", actor: USER, caller: CALLER });
    expect(await repoPaths()).not.toContain("packages/foo");

    const result = await vcs.restoreRepo({ repoPath: "packages/foo", actor: USER, caller: CALLER });
    expect(result.restored).toBe(true);
    expect(result.fromArchiveHead).toBeTruthy();
    expect(result.restoredPaths).toContain("packages/foo/index.ts");

    // Back in global state with its original content + working tree.
    expect(await repoPaths()).toContain("packages/foo");
    const view = await vcs.workspaceView();
    expect((await vcs.readFile(view.stateHash, "packages/foo/index.ts"))?.content).toMatchObject({
      kind: "text",
      text: expect.stringContaining("x = 1"),
    });
    expect(await worktreeHead("packages/foo", VCS_MAIN_HEAD)).not.toBeNull();
    await expect(
      fsp.access(path.join(workspaceRoot, "packages/foo/index.ts"))
    ).resolves.toBeUndefined();
    // A push from a fresh context now works again (the repo is live).
    expect(await vcs.resolveHead(VCS_MAIN_HEAD, "packages/foo")).toBeTruthy();
  });

  it("fails to restore when a different repo was slotted in at the path", async () => {
    await vcs.deleteRepo({ repoPath: "packages/foo", actor: USER, caller: CALLER });
    // A DIFFERENT repo is created at the same path after the deletion.
    await fsp.mkdir(path.join(workspaceRoot, "packages/foo"), { recursive: true });
    await fsp.writeFile(
      path.join(workspaceRoot, "packages/foo/index.ts"),
      "export const usurper = 1;\n"
    );
    await vcs.ensureRepoLogsFromDisk();

    await expect(vcs.restoreRepo({ repoPath: "packages/foo", actor: USER, caller: CALLER })).rejects.toThrow(
      /already occupies that path/
    );
    // The occupant is untouched.
    const view = await vcs.workspaceView();
    expect((await vcs.readFile(view.stateHash, "packages/foo/index.ts"))?.content).toMatchObject({
      kind: "text",
      text: expect.stringContaining("usurper"),
    });
  });

  it("fails to restore a path with no archived history", async () => {
    // A path that never existed: no live main (passes the occupancy guard) and
    // nothing archived to recover.
    await expect(vcs.restoreRepo({ repoPath: "packages/ghost", actor: USER, caller: CALLER })).rejects.toThrow(
      /no archived history/
    );
  });

  it("classifies the restore at the ref gate and aborts on denial", async () => {
    await vcs.deleteRepo({ repoPath: "packages/foo", actor: USER, caller: CALLER });
    // The re-creating updateMains is a restore-shaped entry (expectedOld null on
    // a previously-deleted repo); a gate denial throws before the ref is created.
    const seen: RefGateBatch[] = [];
    gateHook = async (batch) => {
      seen.push(batch);
      throw new Error("restore denied");
    };
    await expect(
      vcs.restoreRepo({ repoPath: "packages/foo", actor: USER, caller: CALLER })
    ).rejects.toThrow(/restore denied/);
    // The gate saw a restore-shaped entry: null old on a previously-deleted repo.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.operation).toBe("restore");
    expect(seen[0]!.entries[0]).toMatchObject({
      repoPath: "packages/foo",
      old: null,
      priorDeleted: true,
    });
    // Still deleted — the denial left nothing half-restored.
    expect(await repoPaths()).not.toContain("packages/foo");
    expect(await worktreeHead("packages/foo", VCS_MAIN_HEAD)).toBeNull();
  });

  it("raises exactly ONE deletion/restore prompt through the REAL ref gate (host-computed fileCount + dependents)", async () => {
    // Wire the production ref gate: delete/restore now flow through its
    // classification, so there is exactly one host-owned prompt per lifecycle
    // op — no separate beforeDelete/beforeRestore prompt.
    const deletions: RepoDeletionApprovalCandidate[] = [];
    const restores: RepoRestoreApprovalCandidate[] = [];
    let dependentsCalls = 0;
    const realGate = createMainRefAdvanceGate({
      blobsDir: path.join(root, "blobs"),
      approvalGate: {
        approve: async () => {},
        approveRepoDeletion: async (c) => {
          deletions.push(c);
        },
        approveRepoRestore: async (c) => {
          restores.push(c);
        },
      },
      ensureStateMirrored: (stateHash) => vcs.worktrees.ensureStateMirrored(stateHash),
      workspaceViewWithReposAt: (overrides) => vcs.workspaceViewWithReposAt(overrides),
      computeDeleteDependents: async (repoPath) => {
        dependentsCalls += 1;
        return vcs.deleteDependents(repoPath);
      },
    });
    gateHook = (batch) => realGate(batch);

    await vcs.deleteRepo({ repoPath: "packages/foo", actor: USER, caller: CALLER });
    // Exactly one severe deletion prompt, carrying host-computed file count and
    // the (host-computed, empty here) dependents list.
    expect(deletions).toHaveLength(1);
    expect(deletions[0]).toMatchObject({ repoPath: "packages/foo", fileCount: 1, dependents: [] });
    expect(dependentsCalls).toBe(1);
    expect(restores).toHaveLength(0);

    await vcs.restoreRepo({ repoPath: "packages/foo", actor: USER, caller: CALLER });
    // Exactly one restore prompt; the deletion prompt count is unchanged (no
    // double prompting across the lifecycle).
    expect(restores).toHaveLength(1);
    expect(restores[0]).toMatchObject({ repoPath: "packages/foo", fileCount: 1 });
    expect(deletions).toHaveLength(1);
  });

  it("keeps an archived (deleted) lineage's content in the owner-derived GC live set", async () => {
    const del = await vcs.deleteRepo({ repoPath: "packages/foo", actor: USER, caller: CALLER });
    const archivedState = (await worktreeHead("packages/foo", del.archiveHead!))!.stateHash;
    const files = await vcs.worktrees.listStateFiles(archivedState);
    expect(files.length).toBeGreaterThan(0);

    // The owner-derived GC mark roots every worktree head (incl. `archived:*`)
    // via listWorktreeHeads, so the archived lineage's file content stays live —
    // no host-side pin RPC is needed (narrow-host-vcs-plan §2.1).
    const gc = gad.instance.runGadGcMark({});
    for (const f of files) {
      expect(gc.liveBlobDigests).toContain(f.content_hash);
    }
    // And it stays restorable after a mark pass.
    const restored = await vcs.restoreRepo({ repoPath: "packages/foo", actor: USER, caller: CALLER });
    expect(restored.restored).toBe(true);
    const view = await vcs.workspaceView();
    expect((await vcs.readFile(view.stateHash, "packages/foo/index.ts"))?.content).toMatchObject({
      kind: "text",
      text: expect.stringContaining("x = 1"),
    });
  });
});
