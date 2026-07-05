/**
 * §6 write-ahead protocol for repo-LIFECYCLE ops (fork / delete / restore).
 *
 * These ops cross two durable authorities — DO-internal VCS lineage state and
 * the host's protected `main` refs (via refs.updateMains). A durable
 * `gad_lifecycle_intents` record recorded BEFORE the CAS makes a thrown
 * updateMains reconcilable against the AUTHORITATIVE ref instead of blindly
 * rolled back:
 *   - clean denial / CAS conflict (provably did NOT land) → compensate the
 *     DO-side re-key, no phantom, intent drained;
 *   - CAS lands but the response is lost (throws) → roll FORWARD (keep the DO
 *     consistent with the ref, finish the disk tail), intent drained, success;
 *   - crash-shaped park (completion stubbed away) → a later heal converges it.
 *
 * Plus the headline regression: a half-restored repo (ref present, DO main
 * still archived) no longer bricks an UNRELATED repo's push at the fail-closed
 * heal sweep.
 *
 * Driven against the real gad-store DO (workerd test-utils), matching the other
 * workspaceVcs lifecycle suites.
 */
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
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";

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
const CALLER = { runtime: { kind: "app", id: "cli" } } as unknown as VerifiedCaller;
const text = (value: string) => ({ kind: "text" as const, text: value });

describe("lifecycle intents — fork/delete/restore write-ahead reconcile (§6)", () => {
  let root: string;
  let workspaceRoot: string;
  let vcs: WorkspaceVcs;
  let gad: TestGad;
  let caller: GadCaller;
  let refs: ReturnType<typeof createRefService>;
  let gateHook: (batch: RefGateBatch) => Promise<void>;

  const sql = () =>
    (
      gad.instance as unknown as {
        sql: { exec: (s: string, ...a: unknown[]) => { toArray: () => unknown[] } };
      }
    ).sql;
  const lifecycleIntents = () =>
    sql().exec("SELECT * FROM gad_lifecycle_intents").toArray() as Array<Record<string, unknown>>;
  const refsBridge = () =>
    (
      gad.instance as unknown as {
        refsStore: () => { updateMains: (i: unknown) => Promise<unknown> };
      }
    ).refsStore();
  const worktreeHead = (repoPath: string, head: string) =>
    caller.call<{ stateHash: string } | null>("resolveWorktreeHead", {
      logId: logIdForRepo(repoPath),
      head,
    });
  const repoPaths = async () => (await vcs.discoverRepos()).map((r) => r.repoPath);

  beforeEach(async () => {
    gateHook = async () => {};
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "gadvcs-lifecycle-"));
    workspaceRoot = path.join(root, "source");
    await fsp.mkdir(path.join(workspaceRoot, "packages/foo"), { recursive: true });
    await fsp.writeFile(
      path.join(workspaceRoot, "packages/foo/package.json"),
      `{\n  "name": "@w/foo",\n  "vibestudio": {}\n}\n`
    );
    await fsp.writeFile(path.join(workspaceRoot, "packages/foo/index.ts"), "export const x = 1;\n");
    await fsp.mkdir(path.join(workspaceRoot, "packages/bar"), { recursive: true });
    await fsp.writeFile(path.join(workspaceRoot, "packages/bar/index.ts"), "export const y = 1;\n");
    await fsp.mkdir(path.join(workspaceRoot, "meta"), { recursive: true });
    await fsp.writeFile(path.join(workspaceRoot, "meta/vibestudio.yml"), "name: test\n");

    gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad" });
    caller = callerFor(gad);
    refs = createRefService({
      statePath: path.join(root, "refs"),
      gate: (batch) => gateHook(batch),
    });
    vcs = new WorkspaceVcs({
      blobsDir: path.join(root, "blobs"),
      workspaceRoot,
      contextsRoot: path.join(root, ".contexts"),
      buildSourcesRoot: path.join(root, "build-sources"),
      refs,
      extractMainToSource: true,
    });
    attachLocalHostBridges(gad.instance, {
      blobsDir: path.join(root, "blobs"),
      refs,
      gateContext: () => ({ kind: "caller", caller: CALLER }),
      worktree: {
        project: (repoPath, head, stateHash) => vcs.projectWorktree(repoPath, head, stateHash),
        dependentRepos: (repoPath) => vcs.deleteDependents(repoPath),
      },
    });
    await vcs.attachGad(caller);
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const doInstance = () =>
    gad.instance as unknown as {
      vcsDeleteRepo: (a: unknown) => Promise<Record<string, unknown>>;
      vcsRestoreRepo: (a: unknown) => Promise<Record<string, unknown>>;
      vcsForkRepo: (a: unknown) => Promise<Record<string, unknown>>;
      vcsHealPublishDrift: (a: unknown) => Promise<{ pendingIntents: number }>;
    };

  const del = (repoPath: string) =>
    doInstance().vcsDeleteRepo({ repoPath, actor: USER, force: true });
  const restore = (repoPath: string) => doInstance().vcsRestoreRepo({ repoPath, actor: USER });
  const fork = (fromPath: string, toPath: string) =>
    doInstance().vcsForkRepo({ fromPath, toPath, actor: USER });

  /** Make the next N updateMains calls APPLY host-side then throw `err` — the
   *  lost-response hazard (CAS landed, response never returned). */
  function landThenThrow(err: Error, count = 1): void {
    const bridge = refsBridge();
    const original = bridge.updateMains.bind(bridge);
    let remaining = count;
    bridge.updateMains = async (input: unknown) => {
      if (remaining > 0) {
        remaining -= 1;
        await original(input);
        throw err;
      }
      return original(input);
    };
  }

  /** Make the next updateMains throw WITHOUT applying (a pre-swap failure). */
  function throwWithoutApply(err: Error): void {
    const bridge = refsBridge();
    const original = bridge.updateMains.bind(bridge);
    let done = false;
    bridge.updateMains = async (input: unknown) => {
      if (!done) {
        done = true;
        throw err;
      }
      return original(input);
    };
  }

  // ───────────────────────────── DELETE ─────────────────────────────

  describe("delete", () => {
    it("(a) clean denial compensates: main intact, no lingering intent", async () => {
      gateHook = async () => {
        throw new Error("denied by user");
      };
      const before = refs.readMain("packages/foo")?.stateHash;
      await expect(del("packages/foo")).rejects.toThrow(/denied by user|ref delete denied/);
      // Compensated: main live again, ref intact, no phantom archive-only state.
      expect(refs.readMain("packages/foo")?.stateHash).toBe(before);
      expect(await worktreeHead("packages/foo", VCS_MAIN_HEAD)).not.toBeNull();
      expect(lifecycleIntents()).toHaveLength(0);
    });

    it("(b) CAS conflict compensates", async () => {
      throwWithoutApply(new Error("Main-ref group compare-and-swap conflict"));
      const before = refs.readMain("packages/foo")?.stateHash;
      await expect(del("packages/foo")).rejects.toThrow(/ref delete denied|conflict/);
      expect(refs.readMain("packages/foo")?.stateHash).toBe(before);
      expect(await worktreeHead("packages/foo", VCS_MAIN_HEAD)).not.toBeNull();
      expect(lifecycleIntents()).toHaveLength(0);
    });

    it("(c) CAS lands but throws → roll forward, authorities converge, intent drained", async () => {
      landThenThrow(new Error("lost response after delete"));
      const result = await del("packages/foo");
      expect(result["archived"]).toBe(true);
      // Ref gone (delete landed) and the DO main stays archived — converged.
      expect(refs.readMain("packages/foo")).toBeNull();
      expect(await worktreeHead("packages/foo", VCS_MAIN_HEAD)).toBeNull();
      expect(lifecycleIntents()).toHaveLength(0);
    });

    it("(d) crash-shaped park then heal converges the delete", async () => {
      // Stub completion away so the intent stays parked after a landed CAS.
      const inst = gad.instance as unknown as {
        deleteLifecycleIntent: (id: string) => void;
        reconcileLifecycleIntent: (i: unknown, e?: unknown) => Promise<string>;
      };
      const originalReconcile = inst.reconcileLifecycleIntent.bind(inst);
      landThenThrow(new Error("crash after delete CAS"));
      // Neuter reconcile in the live catch so the intent is left parked (crash).
      inst.reconcileLifecycleIntent = async () => "indeterminate";
      await expect(del("packages/foo")).rejects.toThrow(/crash after delete CAS/);
      inst.reconcileLifecycleIntent = originalReconcile;
      // Ref deleted, intent parked, DO main archived (half state).
      expect(refs.readMain("packages/foo")).toBeNull();
      expect(lifecycleIntents()).toHaveLength(1);
      // Heal converges: keep archived (ref is authority), drain the intent.
      const healed = await doInstance().vcsHealPublishDrift({});
      expect(healed.pendingIntents).toBe(0);
      expect(await worktreeHead("packages/foo", VCS_MAIN_HEAD)).toBeNull();
      expect(lifecycleIntents()).toHaveLength(0);
    });
  });

  // ───────────────────────────── RESTORE ─────────────────────────────

  describe("restore", () => {
    it("(a) clean denial re-archives: still deleted, no lingering intent", async () => {
      await del("packages/foo");
      gateHook = async () => {
        throw new Error("restore denied");
      };
      await expect(restore("packages/foo")).rejects.toThrow(/restore denied|ref restore denied/);
      expect(refs.readMain("packages/foo")).toBeNull();
      expect(await worktreeHead("packages/foo", VCS_MAIN_HEAD)).toBeNull();
      expect(lifecycleIntents()).toHaveLength(0);
    });

    it("(b) CAS conflict re-archives", async () => {
      await del("packages/foo");
      throwWithoutApply(new Error("Main-ref group compare-and-swap conflict"));
      await expect(restore("packages/foo")).rejects.toThrow(/ref restore denied|conflict/);
      expect(refs.readMain("packages/foo")).toBeNull();
      expect(await worktreeHead("packages/foo", VCS_MAIN_HEAD)).toBeNull();
      expect(lifecycleIntents()).toHaveLength(0);
    });

    it("(c) CAS lands but throws → roll forward, authorities converge, intent drained", async () => {
      await del("packages/foo");
      landThenThrow(new Error("lost response after restore"));
      const result = await restore("packages/foo");
      expect(result["restored"]).toBe(true);
      const ref = refs.readMain("packages/foo")?.stateHash;
      expect(ref).toBeTruthy();
      // DO main matches the ref (restored, not re-archived).
      expect((await worktreeHead("packages/foo", VCS_MAIN_HEAD))?.stateHash).toBe(ref);
      expect(lifecycleIntents()).toHaveLength(0);
      // Disk tail finished: the file is back in the workspace view.
      const view = await vcs.workspaceView();
      expect(await vcs.readFile(view.stateHash, "packages/foo/index.ts")).not.toBeNull();
    });

    /** Manufacture the EXACT bricking half-restore: ref present at the archived
     *  state, DO main still ARCHIVED, and a parked restore intent covering it.
     *  (A live op never leaves this state now; it models a crash under the OLD
     *  buggy re-archive-on-landed catch.) Returns the archived stateHash. */
    async function manufactureHalfRestore(repoPath: string): Promise<string> {
      const delResult = await del(repoPath);
      const archiveHead = String(delResult["archiveHead"]);
      const archivedState = (await worktreeHead(repoPath, archiveHead))!.stateHash;
      // Ref restored (landed) but DO main left archived — the divergence.
      await refs.seedMain({ repoPath, value: archivedState });
      const inst = gad.instance as unknown as {
        recordLifecycleIntent: (i: unknown) => void;
        transaction: (f: () => void) => void;
      };
      inst.transaction(() =>
        inst.recordLifecycleIntent({
          intentId: `half-restore-${repoPath}`,
          operation: "restore",
          repoPath,
          logId: logIdForRepo(repoPath),
          expectedOld: null,
          next: archivedState,
          detail: { archiveHead, logCursor: null },
          actor: USER,
        })
      );
      return archivedState;
    }

    it("(d) crash-shaped park then heal converges the half-restore", async () => {
      const archivedState = await manufactureHalfRestore("packages/foo");
      // The bricking state: ref present, DO main archived, intent parked.
      expect(refs.readMain("packages/foo")?.stateHash).toBe(archivedState);
      expect(await worktreeHead("packages/foo", VCS_MAIN_HEAD)).toBeNull();
      expect(lifecycleIntents()).toHaveLength(1);
      // Heal rolls forward: DO main re-adopted, intent drained.
      const healed = await doInstance().vcsHealPublishDrift({});
      expect(healed.pendingIntents).toBe(0);
      expect((await worktreeHead("packages/foo", VCS_MAIN_HEAD))?.stateHash).toBe(archivedState);
      expect(lifecycleIntents()).toHaveLength(0);
    });

    it("headline regression: a half-restore does NOT brick an unrelated repo's push", async () => {
      // Seed a ctx commit on bar so it has something to push.
      await vcs.recordEdit({
        head: vcsContextHead("agent-1"),
        actor: USER,
        repoPath: "packages/bar",
        edits: [{ kind: "write", path: "index.ts", content: text("export const y = 2;\n") }],
      });
      await vcs.commit({
        head: vcsContextHead("agent-1"),
        repoPath: "packages/bar",
        message: "bump bar",
        actor: USER,
      });

      const archivedState = await manufactureHalfRestore("packages/foo");
      expect(await worktreeHead("packages/foo", VCS_MAIN_HEAD)).toBeNull();
      expect(lifecycleIntents()).toHaveLength(1);

      // The unrelated push runs entry heal, which reconciles foo's half-restore
      // FIRST (covering its main) so the fail-closed sweep never throws over it.
      const pushResult = await pushToMain(gad, {
        repoPaths: ["packages/bar"],
        sourceHead: vcsContextHead("agent-1"),
        actor: USER,
      });
      expect(pushResult.status).toBe("pushed");
      // foo converged as a side effect of the heal at push entry.
      expect((await worktreeHead("packages/foo", VCS_MAIN_HEAD))?.stateHash).toBe(archivedState);
      expect(lifecycleIntents()).toHaveLength(0);
    });
  });

  // ───────────────────────────── FORK ─────────────────────────────

  describe("fork", () => {
    it("(a) clean denial removes the created lineage: no phantom repo", async () => {
      gateHook = async () => {
        throw new Error("fork denied");
      };
      await expect(fork("packages/foo", "packages/clone")).rejects.toThrow(
        /fork denied|ref create denied/
      );
      // No phantom: destination has neither a ref nor a live main.
      expect(refs.readMain("packages/clone")).toBeNull();
      expect(await worktreeHead("packages/clone", VCS_MAIN_HEAD)).toBeNull();
      expect(await repoPaths()).not.toContain("packages/clone");
      expect(lifecycleIntents()).toHaveLength(0);
    });

    it("(a2) REPEATED denial of the same fork compensates each time — unwind heads must not collide", async () => {
      // `intent.next` is content-derived, so the same denied fork repeats it; the
      // unwind archive head is keyed by intentId precisely so the second denial's
      // archiveRepoMain does not reject a duplicate head and strand the intent.
      gateHook = async () => {
        throw new Error("fork denied");
      };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(fork("packages/foo", "packages/clone")).rejects.toThrow(
          /fork denied|ref create denied/
        );
        expect(refs.readMain("packages/clone")).toBeNull();
        expect(await worktreeHead("packages/clone", VCS_MAIN_HEAD)).toBeNull();
        expect(lifecycleIntents()).toHaveLength(0);
      }
    });

    it("(b) CAS conflict removes the created lineage", async () => {
      throwWithoutApply(new Error("Main-ref group compare-and-swap conflict"));
      await expect(fork("packages/foo", "packages/clone")).rejects.toThrow(
        /ref create denied|conflict/
      );
      expect(refs.readMain("packages/clone")).toBeNull();
      expect(await worktreeHead("packages/clone", VCS_MAIN_HEAD)).toBeNull();
      expect(lifecycleIntents()).toHaveLength(0);
    });

    it("(c) CAS lands but throws → roll forward, fork lineage kept, intent drained", async () => {
      landThenThrow(new Error("lost response after fork"));
      const result = await fork("packages/foo", "packages/clone");
      expect(result["repoPath"]).toBe("packages/clone");
      const ref = refs.readMain("packages/clone")?.stateHash;
      expect(ref).toBeTruthy();
      expect((await worktreeHead("packages/clone", VCS_MAIN_HEAD))?.stateHash).toBe(ref);
      expect(lifecycleIntents()).toHaveLength(0);
      // Disk tail finished: fork appears in the workspace view.
      expect(await repoPaths()).toContain("packages/clone");
    });

    it("(d) crash-shaped park then heal converges the fork", async () => {
      const inst = gad.instance as unknown as {
        reconcileLifecycleIntent: (i: unknown, e?: unknown) => Promise<string>;
      };
      const originalReconcile = inst.reconcileLifecycleIntent.bind(inst);
      landThenThrow(new Error("crash after fork CAS"));
      inst.reconcileLifecycleIntent = async () => "indeterminate";
      await expect(fork("packages/foo", "packages/clone")).rejects.toThrow(/crash after fork CAS/);
      inst.reconcileLifecycleIntent = originalReconcile;
      // Ref present, intent parked.
      const ref = refs.readMain("packages/clone")?.stateHash;
      expect(ref).toBeTruthy();
      expect(lifecycleIntents()).toHaveLength(1);
      // Heal converges: keep the forked lineage, drain intent, project to disk.
      const healed = await doInstance().vcsHealPublishDrift({});
      expect(healed.pendingIntents).toBe(0);
      expect((await worktreeHead("packages/clone", VCS_MAIN_HEAD))?.stateHash).toBe(ref);
      expect(lifecycleIntents()).toHaveLength(0);
    });
  });
});
