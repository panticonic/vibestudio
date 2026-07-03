/**
 * P3 — DO-side push/merge orchestration (docs/narrow-host-vcs-plan.md §6/§8).
 *
 * Drives the gad-store DO's `vcsPush` directly against an in-process
 * RefService + content-store bridge (attachLocalHostBridges). Seeds ctx commits
 * through the real WorkspaceVcs edit→commit flow, then exercises: happy-path
 * single/multi-repo group atomicity, up-to-date, divergence classification,
 * build-failed no-publish, write-ahead-intent crash→heal with full provenance,
 * synthetic catch-up for intent-less drift, and the GC-root protection of a
 * pending intent's candidate.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { GadWorkspaceDO } from "../workers/gad-store/index.js";
import { attachLocalHostBridges } from "../../src/server/vcsHost/testSupport.js";
import { WorkspaceVcs } from "../../src/server/vcsHost/workspaceVcs.js";
import { vcsContextHead } from "../../src/server/vcsHost/paths.js";
import type { GadCaller } from "../../src/server/vcsHost/testSupport.js";
import { createRefService } from "../../src/server/services/refService.js";

const USER = { id: "user", kind: "user" };
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

type PushInput = {
  repoPaths: string[];
  sourceHead: string;
  message?: string | null;
  actor: { id: string; kind: string };
};

describe("DO vcsPush (narrow-host push orchestration)", () => {
  let root: string;
  let gad: TestGad;
  let vcs: WorkspaceVcs;
  let refs: ReturnType<typeof createRefService>;
  let buildFail = false;
  // Per-test build-gate override (interleaving/mixed-report scenarios). When set
  // it wins over the `buildFail` boolean.
  let buildValidateOverride:
    | ((input: {
        viewHash: string;
        repoPaths: string[];
        baseViewHash?: string;
      }) => Promise<Array<{ required?: boolean; status: string; [k: string]: unknown }>>)
    | null = null;

  const doInstance = () => gad.instance as unknown as Record<string, (a: unknown) => Promise<unknown>>;
  const push = (input: PushInput) =>
    doInstance().vcsPush(input) as Promise<
      | { status: "pushed" | "up-to-date"; repoPaths: string[] }
      | {
          status: "diverged";
          divergences: Array<{ repoPath: string; mergeable: string; upstreamCommits: unknown[] }>;
        }
      | { status: "build-failed"; reports: unknown[] }
    >;
  const readMain = (repoPath: string) => refs.readMain(repoPath)?.stateHash ?? null;

  async function seedCommit(
    ctxId: string,
    repoPath: string,
    file: string,
    text: string
  ): Promise<string> {
    const head = vcsContextHead(ctxId);
    await vcs.recordEdit({
      head,
      repoPath,
      actor: USER,
      edits: [{ kind: "create", path: file, content: { kind: "text", text } }],
    });
    const committed = await vcs.commit({ head, repoPath, message: `commit ${file}`, actor: USER });
    expect(committed.status).toBe("committed");
    return committed.stateHash;
  }

  async function editCommit(
    ctxId: string,
    repoPath: string,
    file: string,
    text: string
  ): Promise<string> {
    const head = vcsContextHead(ctxId);
    await vcs.recordEdit({
      head,
      repoPath,
      actor: USER,
      edits: [{ kind: "write", path: file, content: { kind: "text", text } }],
    });
    const committed = await vcs.commit({ head, repoPath, message: `edit ${file}`, actor: USER });
    return committed.stateHash;
  }

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "do-push-"));
    await fsp.mkdir(path.join(root, "workspace"));
    gad = await createTestDO(GadWorkspaceDO, { __objectKey: "workspace-gad" });
    refs = createRefService({ statePath: path.join(root, "refs"), gate: async () => {} });
    buildFail = false;
    buildValidateOverride = null;
    attachLocalHostBridges(gad.instance, {
      blobsDir: path.join(root, "blobs"),
      refs: () => refs,
      buildValidate: async (input) =>
        buildValidateOverride
          ? buildValidateOverride(input)
          : buildFail
            ? input.repoPaths.map((p) => ({ unit: p, required: true, status: "failed" }))
            : [],
    });
    vcs = new WorkspaceVcs({
      blobsDir: path.join(root, "blobs"),
      workspaceRoot: path.join(root, "workspace"),
      contextsRoot: path.join(root, ".contexts"),
      buildSourcesRoot: path.join(root, "build-sources"),
      refs,
    });
    await vcs.attachGad(callerFor(gad));
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("pushes a brand-new repo to main and records provenance (intent cleared)", async () => {
    const stateHash = await seedCommit("c1", "packages/a", "a.txt", "hello\n");
    const result = await push({ repoPaths: ["packages/a"], sourceHead: vcsContextHead("c1"), actor: USER });
    expect(result.status).toBe("pushed");
    expect(readMain("packages/a")).toBe(stateHash);
    // Provenance: the DO's recorded main head matches the ref (commit recorded).
    const head = (gad.instance as unknown as {
      resolveWorktreeHeadInternal: (l: string, h: string) => { stateHash: string } | null;
    }).resolveWorktreeHeadInternal("vcs:repo:packages/a", "main");
    expect(head?.stateHash).toBe(stateHash);
    // No pending intent left behind (completed + deleted).
    const pending = (gad.instance as unknown as { sql: { exec: (s: string) => { toArray: () => unknown[] } } })
      .sql.exec("SELECT * FROM gad_publish_intents").toArray();
    expect(pending).toHaveLength(0);
  });

  it("group-pushes multiple repos atomically (one updateMains batch)", async () => {
    const a = await seedCommit("c1", "packages/a", "a.txt", "A\n");
    const b = await seedCommit("c1", "packages/b", "b.txt", "B\n");
    const result = await push({
      repoPaths: ["packages/a", "packages/b"],
      sourceHead: vcsContextHead("c1"),
      actor: USER,
    });
    expect(result.status).toBe("pushed");
    expect(readMain("packages/a")).toBe(a);
    expect(readMain("packages/b")).toBe(b);
  });

  it("returns up-to-date when nothing to advance", async () => {
    await seedCommit("c1", "packages/a", "a.txt", "A\n");
    await push({ repoPaths: ["packages/a"], sourceHead: vcsContextHead("c1"), actor: USER });
    const again = await push({ repoPaths: ["packages/a"], sourceHead: vcsContextHead("c1"), actor: USER });
    expect(again.status).toBe("up-to-date");
  });

  it("classifies divergence and does NOT advance main", async () => {
    // main = X from ctx c1
    await seedCommit("c1", "packages/a", "a.txt", "base\n");
    await push({ repoPaths: ["packages/a"], sourceHead: vcsContextHead("c1"), actor: USER });
    const mainX = readMain("packages/a");
    // c2 forks from X, commits Y (rebase c2 onto current main first via pin)
    await vcs.rebaseContext("c2", USER).catch(() => {});
    await editCommit("c2", "packages/a", "a.txt", "c2-change\n");
    // main advances to Z under c1
    await editCommit("c1", "packages/a", "a.txt", "c1-change\n");
    await push({ repoPaths: ["packages/a"], sourceHead: vcsContextHead("c1"), actor: USER });
    expect(readMain("packages/a")).not.toBe(mainX);
    const mainZ = readMain("packages/a");
    // pushing c2 now diverges
    const diverged = await push({ repoPaths: ["packages/a"], sourceHead: vcsContextHead("c2"), actor: USER });
    expect(diverged.status).toBe("diverged");
    if (diverged.status === "diverged") {
      expect(diverged.divergences[0]?.repoPath).toBe("packages/a");
    }
    expect(readMain("packages/a")).toBe(mainZ); // unchanged
  });

  it("aborts on a required build failure (no publish, no intent)", async () => {
    await seedCommit("c1", "packages/a", "a.txt", "A\n");
    buildFail = true;
    const result = await push({ repoPaths: ["packages/a"], sourceHead: vcsContextHead("c1"), actor: USER });
    expect(result.status).toBe("build-failed");
    expect(readMain("packages/a")).toBe(null);
    const pending = (gad.instance as unknown as { sql: { exec: (s: string) => { toArray: () => unknown[] } } })
      .sql.exec("SELECT * FROM gad_publish_intents").toArray();
    expect(pending).toHaveLength(0);
  });

  it("heals a crash between the CAS and provenance (write-ahead intent)", async () => {
    const stateHash = await seedCommit("c1", "packages/a", "a.txt", "A\n");
    // Simulate a crash: make provenance recording throw AFTER updateMains lands.
    const inst = gad.instance as unknown as { completePublishIntent: (i: unknown) => void };
    const original = inst.completePublishIntent;
    inst.completePublishIntent = () => {
      throw new Error("simulated crash after CAS");
    };
    await expect(
      push({ repoPaths: ["packages/a"], sourceHead: vcsContextHead("c1"), actor: USER })
    ).rejects.toThrow(/simulated crash/);
    // Ref moved, intent still pending.
    expect(readMain("packages/a")).toBe(stateHash);
    const pendingBefore = (gad.instance as unknown as { sql: { exec: (s: string) => { toArray: () => unknown[] } } })
      .sql.exec("SELECT * FROM gad_publish_intents").toArray();
    expect(pendingBefore).toHaveLength(1);
    // Restart: restore provenance recording and heal.
    inst.completePublishIntent = original;
    const healed = await doInstance().vcsHealPublishDrift({});
    expect(healed).toMatchObject({ pendingIntents: 0 });
    // Provenance recorded: DO main head now matches the ref.
    const head = (gad.instance as unknown as {
      resolveWorktreeHeadInternal: (l: string, h: string) => { stateHash: string } | null;
    }).resolveWorktreeHeadInternal("vcs:repo:packages/a", "main");
    expect(head?.stateHash).toBe(stateHash);
  });

  it("rejects an editOps sequence that breaks first-parent chain continuity (A2/U2)", async () => {
    const stateHash = await seedCommit("c1", "packages/a", "a.txt", "A\n");
    await push({ repoPaths: ["packages/a"], sourceHead: vcsContextHead("c1"), actor: USER });
    // Ingest a main provenance commit whose editOp claims a WRONG first-parent
    // old_content_hash (base is `stateHash`, but the op claims a bogus old).
    const ingest = () =>
      (gad.instance as unknown as { ingestWorktreeState: (i: unknown) => Promise<unknown> }).ingestWorktreeState({
        logId: "vcs:repo:packages/a",
        head: "main",
        logKind: "vcs",
        actor: USER,
        files: [{ path: "a.txt", contentHash: "deadbeef".repeat(8), mode: 33188 }],
        baseStateHash: stateHash,
        expectedRefStateHash: stateHash,
        eventKind: "state.merge_applied",
        summary: "bad chain",
        editOps: [
          {
            kind: "replace",
            path: "a.txt",
            oldContentHash: "00000000".repeat(8), // wrong: not the first-parent content
            newContentHash: "deadbeef".repeat(8),
          },
        ],
        validateFirstParentChain: true,
      });
    await expect(ingest()).rejects.toThrow(/chain continuity/i);
  });

  it("records origin-annotated ops for a clean ctx merge (A3/U3, no blame hole)", async () => {
    // main = base; c1 diverges (its own line), main advances (another line).
    await seedCommit("c1", "packages/a", "a.txt", "l1\nl2\nl3\n");
    await push({ repoPaths: ["packages/a"], sourceHead: vcsContextHead("c1"), actor: USER });
    // c2 edits line 1; main (via c1) edits line 3 -> clean, non-overlapping merge.
    await editCommit("c2", "packages/a", "a.txt", "L1\nl2\nl3\n");
    await editCommit("c1", "packages/a", "a.txt", "l1\nl2\nL3\n");
    await push({ repoPaths: ["packages/a"], sourceHead: vcsContextHead("c1"), actor: USER });
    // Merge main into c2 (clean) via the DO merge path.
    const merged = (await doInstance().vcsMerge({
      logId: "vcs:repo:packages/a",
      targetHead: vcsContextHead("c2"),
      sourceHead: "main",
      actor: USER,
    })) as { status: string; eventId?: string };
    expect(merged.status).toBe("merged");
    // The merge commit owns per-file edit ops (not an op-less commit).
    const ops = (gad.instance as unknown as {
      sql: { exec: (s: string, ...a: unknown[]) => { toArray: () => unknown[] } };
    }).sql
      .exec(
        "SELECT kind, path, hunks_json FROM gad_worktree_edit_ops WHERE committed_event_id = ?",
        merged.eventId
      )
      .toArray() as Array<{ kind: string; path: string; hunks_json: string | null }>;
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.some((o) => o.path === "a.txt")).toBe(true);
  });

  it("pushes with actor omitted (derived at entry) and re-pins the ctx base (P3 flip)", async () => {
    const stateHash = await seedCommit("c1", "packages/a", "a.txt", "A\n");
    // No `actor`: the flipped userland client no longer threads it — the DO
    // derives it from the verified caller read-at-entry (system here).
    const result = (await doInstance().vcsPush({
      repoPaths: ["packages/a"],
      sourceHead: vcsContextHead("c1"),
    })) as { status: string };
    expect(result.status).toBe("pushed");
    expect(readMain("packages/a")).toBe(stateHash);
    // Re-pin: the ctx base view now equals the freshly-published workspace view.
    const inst = gad.instance as unknown as {
      getContextBase: (i: { contextId: string }) => { stateHash: string } | null;
      workspaceViewFromRefs: (store: unknown) => Promise<string>;
      contentStore: () => unknown;
    };
    const wsView = await inst.workspaceViewFromRefs(inst.contentStore());
    expect(inst.getContextBase({ contextId: "c1" })?.stateHash).toBe(wsView);
  });

  it("merges a diverged ctx into main through the DO executor (clean publish-class merge)", async () => {
    // main = base via c1; c2 diverges (line 1), main advances (line 3) → clean.
    await seedCommit("c1", "packages/a", "a.txt", "l1\nl2\nl3\n");
    await push({ repoPaths: ["packages/a"], sourceHead: vcsContextHead("c1"), actor: USER });
    await editCommit("c2", "packages/a", "a.txt", "L1\nl2\nl3\n");
    await editCommit("c1", "packages/a", "a.txt", "l1\nl2\nL3\n");
    await push({ repoPaths: ["packages/a"], sourceHead: vcsContextHead("c1"), actor: USER });
    const mainBefore = readMain("packages/a");
    // Merge c2 INTO main (chrome-class advance) → clean, main advances via the
    // DO's write-ahead-intent → updateMains(operation:"merge") machinery.
    const merged = (await doInstance().vcsMerge({
      logId: "vcs:repo:packages/a",
      targetHead: "main",
      sourceHead: vcsContextHead("c2"),
      actor: USER,
    })) as { status: string; stateHash?: string };
    expect(merged.status).toBe("merged");
    expect(readMain("packages/a")).not.toBe(mainBefore);
    expect(readMain("packages/a")).toBe(merged.stateHash);
    // Provenance recorded and intent cleared (write-ahead completed).
    const head = (gad.instance as unknown as {
      resolveWorktreeHeadInternal: (l: string, h: string) => { stateHash: string } | null;
    }).resolveWorktreeHeadInternal("vcs:repo:packages/a", "main");
    expect(head?.stateHash).toBe(merged.stateHash);
    const pending = (gad.instance as unknown as { sql: { exec: (s: string) => { toArray: () => unknown[] } } })
      .sql.exec("SELECT * FROM gad_publish_intents").toArray();
    expect(pending).toHaveLength(0);
  });

  it("parks a pending merge on main for a conflicted publish-class merge (no ref advance)", async () => {
    await seedCommit("c1", "packages/a", "a.txt", "base\n");
    await push({ repoPaths: ["packages/a"], sourceHead: vcsContextHead("c1"), actor: USER });
    // c2 and c1 edit the SAME line → overlapping conflict.
    await editCommit("c2", "packages/a", "a.txt", "c2-change\n");
    await editCommit("c1", "packages/a", "a.txt", "c1-change\n");
    await push({ repoPaths: ["packages/a"], sourceHead: vcsContextHead("c1"), actor: USER });
    const mainBefore = readMain("packages/a");
    const conflicted = (await doInstance().vcsMerge({
      logId: "vcs:repo:packages/a",
      targetHead: "main",
      sourceHead: vcsContextHead("c2"),
      actor: USER,
    })) as { status: string; conflictPaths?: string[] };
    expect(conflicted.status).toBe("conflicted");
    expect(conflicted.conflictPaths).toContain("a.txt");
    // No ref advance on conflict — the resolution lands through the host.
    expect(readMain("packages/a")).toBe(mainBefore);
    // Pending merge parked on `main`.
    const pending = (gad.instance as unknown as {
      getPendingMerge: (i: { logId: string; head: string }) => { info: unknown };
    }).getPendingMerge({ logId: "vcs:repo:packages/a", head: "main" });
    expect(pending.info).toBeTruthy();
  });

  it("protects a pending intent's candidate state from GC", async () => {
    const stateHash = await seedCommit("c1", "packages/a", "a.txt", "A\n");
    // Record an intent WITHOUT publishing (candidate reachable only via intent).
    const inst = gad.instance as unknown as {
      recordPublishIntent: (i: unknown) => void;
      runGadGcMark: (i?: unknown) => { liveBlobDigests: string[]; keptStates: number };
      transaction: (f: () => void) => void;
    };
    inst.transaction(() =>
      inst.recordPublishIntent({
        intentId: "intent-1",
        operation: "push",
        entries: [
          {
            repoPath: "packages/a",
            logId: "vcs:repo:packages/a",
            expectedOld: null,
            next: stateHash,
            parentEventId: null,
            parentStateHash: stateHash,
            files: [],
            editOps: [],
          },
        ],
        message: null,
        actor: USER,
        sourceHead: vcsContextHead("c1"),
      })
    );
    const mark = inst.runGadGcMark({});
    // The candidate state survives the mark (rooted by the intent).
    const kept = (gad.instance as unknown as { sql: { exec: (s: string, ...a: unknown[]) => { toArray: () => unknown[] } } })
      .sql.exec("SELECT state_hash FROM gad_worktree_states WHERE state_hash = ?", stateHash)
      .toArray();
    expect(kept).toHaveLength(1);
    expect(mark.keptStates).toBeGreaterThan(0);
  });

  // ── Scenarios ported from the deleted host push pipeline (workspaceVcs.push
  //    .test.ts): the DO's vcsPush is now the sole executor of these paths. ──

  it("rejects duplicate repoPaths after normalization", async () => {
    await seedCommit("c1", "packages/a", "a.txt", "A\n");
    await expect(
      push({
        repoPaths: ["packages/a", "packages/a/"],
        sourceHead: vcsContextHead("c1"),
        actor: USER,
      })
    ).rejects.toThrow(/duplicate repoPath "packages\/a"/);
    expect(readMain("packages/a")).toBeNull();
  });

  it("rejects a push over uncommitted edits on the source (clean-source precondition)", async () => {
    const base = await seedCommit("c1", "packages/a", "a.txt", "A\n");
    await push({ repoPaths: ["packages/a"], sourceHead: vcsContextHead("c1"), actor: USER });
    // A working (uncommitted) edit dirties the ctx source head.
    await vcs.recordEdit({
      head: vcsContextHead("c1"),
      repoPath: "packages/a",
      actor: USER,
      edits: [{ kind: "write", path: "a.txt", content: { kind: "text", text: "dirty\n" } }],
    });
    await expect(
      push({ repoPaths: ["packages/a"], sourceHead: vcsContextHead("c1"), actor: USER })
    ).rejects.toThrow(/uncommitted edits/);
    // main did NOT advance past the first push.
    expect(readMain("packages/a")).toBe(base);
  });

  it("rejects a phantom repo (no main, no content on the source head)", async () => {
    await expect(
      push({ repoPaths: ["packages/ghost"], sourceHead: vcsContextHead("c1"), actor: USER })
    ).rejects.toThrow(/unknown repo/);
    expect(readMain("packages/ghost")).toBeNull();
  });

  it("a non-required (regression-gated) build failure does NOT block the push", async () => {
    const stateHash = await seedCommit("c1", "packages/a", "a.txt", "A\n");
    buildValidateOverride = async () => [
      { unit: "packages/a", required: true, status: "ok" },
      { unit: "panels/dependent", required: false, status: "failed" },
    ];
    const result = await push({
      repoPaths: ["packages/a"],
      sourceHead: vcsContextHead("c1"),
      actor: USER,
    });
    expect(result.status).toBe("pushed");
    expect(readMain("packages/a")).toBe(stateHash);
  });

  it("returns structured divergence when main moves during the build gate (CAS race → retry)", async () => {
    // main = base via c1.
    await seedCommit("c1", "packages/a", "a.txt", "base\n");
    await push({ repoPaths: ["packages/a"], sourceHead: vcsContextHead("c1"), actor: USER });
    const mainBase = readMain("packages/a");
    // c2 forks from base and commits a competing change to the SAME file.
    await vcs.rebaseContext("c2", USER).catch(() => {});
    await editCommit("c2", "packages/a", "a.txt", "c2-change\n");
    // c1 commits its own change (the outer push candidate).
    await editCommit("c1", "packages/a", "a.txt", "c1-change\n");
    // During the OUTER push's build gate (before its ref CAS), interleave c2's
    // push so main advances underneath — the outer push's preflight goes stale,
    // its CAS conflicts, and the bounded retry re-reads main and reclassifies as
    // diverged (the old pushRaceResult scenario, now DO-side).
    let raced = false;
    buildValidateOverride = async () => {
      if (!raced) {
        raced = true;
        const inner = await push({
          repoPaths: ["packages/a"],
          sourceHead: vcsContextHead("c2"),
          actor: USER,
        });
        expect(inner.status).toBe("pushed");
      }
      return [];
    };
    const result = await push({
      repoPaths: ["packages/a"],
      sourceHead: vcsContextHead("c1"),
      actor: USER,
    });
    expect(raced).toBe(true);
    expect(result.status).toBe("diverged");
    if (result.status === "diverged") {
      expect(result.divergences[0]?.repoPath).toBe("packages/a");
      expect(result.divergences[0]?.upstreamCommits.length).toBeGreaterThanOrEqual(1);
    }
    // main carries c2's change (the winner of the race), not c1's.
    expect(readMain("packages/a")).not.toBe(mainBase);
  });
});
