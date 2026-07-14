/**
 * P3 — DO-side push/merge orchestration (docs/narrow-host-vcs-plan.md §6/§8).
 *
 * Drives the gad-store DO's `vcsPush` directly against an in-process
 * ProtectedRefStore + content-store bridge (attachLocalHostBridges). Seeds ctx commits
 * through the real WorkspaceVcs edit→commit flow, then exercises: happy-path
 * single/multi-repo group atomicity, up-to-date, divergence classification,
 * build-failed no-publish, write-ahead-intent crash→heal with full provenance,
 * fail-closed handling for intent-less drift, and the GC-root protection of a
 * pending intent's candidate.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  createTestDO,
  createTestDirectAuthority,
} from "@workspace/runtime/worker/test-utils";
import { GadWorkspaceDO } from "../../workspace/workers/gad-store/index.js";
import { attachLocalHostBridges } from "../../src/server/vcsHost/testSupport.js";
import { WorkspaceVcs } from "../../src/server/vcsHost/workspaceVcs.js";
import { vcsContextHead } from "../../src/server/vcsHost/paths.js";
import type { GadCaller } from "../../src/server/vcsHost/testSupport.js";
import { createProtectedRefStore } from "../../src/server/services/protectedRefStore.js";
import type { RepoBuildReport } from "../../src/server/buildV2/index.js";

const USER = { id: "user", kind: "user" };
const DO_ACTOR = { id: "do:agent", kind: "do" };
type TestGad = Awaited<ReturnType<typeof createTestDO<GadWorkspaceDO>>>;

function report(
  partial: Pick<RepoBuildReport, "repoPath" | "required" | "status">
): RepoBuildReport {
  return { kind: "content", role: "pushed", builds: [], ...partial };
}

function callerFor(gad: TestGad): GadCaller {
  return {
    call: <T>(method: string, input: unknown): Promise<T> => gad.call<T>(method, input),
  };
}

type PushInput = {
  repoPaths: string[];
  sourceHead?: string | null;
  message?: string | null;
  actor: { id: string; kind: string };
};

describe("DO vcsPush (narrow-host push orchestration)", () => {
  let root: string;
  let gad: TestGad;
  let vcs: WorkspaceVcs;
  let refs: ReturnType<typeof createProtectedRefStore>;
  let buildFail = false;
  // Per-test build-gate override (interleaving/mixed-report scenarios). When set
  // it wins over the `buildFail` boolean.
  let buildValidateOverride:
    | ((input: {
        viewHash: string;
        repoPaths: string[];
        baseViewHash?: string;
      }) => Promise<RepoBuildReport[]>)
    | null = null;
  // Per-test approval-gate override — lets a test PARK a push inside
  // `refs.updateMains`' critical section (before the CAS swap), reproducing the
  // unbounded human-decision window in which a concurrent heal must not reap the
  // parked intent (plan §11).
  let gateOverride: (() => Promise<void>) | null = null;

  const push = (input: PushInput) =>
    gad.call("vcsPush", input) as Promise<
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
    refs = createProtectedRefStore({
      statePath: path.join(root, "refs"),
      gate: async () => {
        if (gateOverride) await gateOverride();
      },
    });
    buildFail = false;
    buildValidateOverride = null;
    gateOverride = null;
    attachLocalHostBridges(gad.instance, {
      blobsDir: path.join(root, "blobs"),
      refs: () => refs,
      buildValidate: async (input) =>
        buildValidateOverride
          ? buildValidateOverride(input)
          : buildFail
            ? input.repoPaths.map((p) => report({ repoPath: p, required: true, status: "failed" }))
            : [],
    });
    vcs = new WorkspaceVcs({
      workspaceId: "test-ws",
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
    const result = await push({
      repoPaths: ["packages/a"],
      sourceHead: vcsContextHead("c1"),
      actor: USER,
    });
    expect(result.status).toBe("pushed");
    expect(readMain("packages/a")).toBe(stateHash);
    // Provenance: the DO's recorded main head matches the ref (commit recorded).
    const head = (
      gad.instance as unknown as {
        resolveWorktreeHeadInternal: (l: string, h: string) => { stateHash: string } | null;
      }
    ).resolveWorktreeHeadInternal("vcs:repo:packages/a", "main");
    expect(head?.stateHash).toBe(stateHash);
    // No pending intent left behind (completed + deleted).
    const pending = (
      gad.instance as unknown as { sql: { exec: (s: string) => { toArray: () => unknown[] } } }
    ).sql
      .exec("SELECT * FROM gad_publish_intents")
      .toArray();
    expect(pending).toHaveLength(0);
  });

  it("accepts do actors while completing push provenance", async () => {
    const stateHash = await seedCommit("c1", "packages/a", "a.txt", "hello\n");
    const result = await push({
      repoPaths: ["packages/a"],
      sourceHead: vcsContextHead("c1"),
      actor: DO_ACTOR,
    });
    expect(result.status).toBe("pushed");
    expect(readMain("packages/a")).toBe(stateHash);

    const log = (
      gad.instance as unknown as {
        vcsLog: (
          repoPath: string,
          limit: number,
          head: string
        ) => Array<{ actor: unknown; outputStateHash: string | null }>;
      }
    ).vcsLog("packages/a", 50, "main");
    const entry = log.find((e) => e.outputStateHash === stateHash);
    expect(entry?.actor).toEqual(DO_ACTOR);
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
    const again = await push({
      repoPaths: ["packages/a"],
      sourceHead: vcsContextHead("c1"),
      actor: USER,
    });
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
    const diverged = await push({
      repoPaths: ["packages/a"],
      sourceHead: vcsContextHead("c2"),
      actor: USER,
    });
    expect(diverged.status).toBe("diverged");
    if (diverged.status === "diverged") {
      expect(diverged.divergences[0]?.repoPath).toBe("packages/a");
    }
    expect(readMain("packages/a")).toBe(mainZ); // unchanged
  });

  it("aborts on a required build failure (no publish, no intent)", async () => {
    await seedCommit("c1", "packages/a", "a.txt", "A\n");
    buildFail = true;
    const result = await push({
      repoPaths: ["packages/a"],
      sourceHead: vcsContextHead("c1"),
      actor: USER,
    });
    expect(result.status).toBe("build-failed");
    expect(readMain("packages/a")).toBe(null);
    const pending = (
      gad.instance as unknown as { sql: { exec: (s: string) => { toArray: () => unknown[] } } }
    ).sql
      .exec("SELECT * FROM gad_publish_intents")
      .toArray();
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
    const pendingBefore = (
      gad.instance as unknown as { sql: { exec: (s: string) => { toArray: () => unknown[] } } }
    ).sql
      .exec("SELECT * FROM gad_publish_intents")
      .toArray();
    expect(pendingBefore).toHaveLength(1);
    // Restart: restore provenance recording and heal.
    inst.completePublishIntent = original;
    const healed = await gad.call("vcsHealPublishDrift", {});
    expect(healed).toMatchObject({ pendingIntents: 0 });
    // Provenance recorded: DO main head now matches the ref.
    const head = (
      gad.instance as unknown as {
        resolveWorktreeHeadInternal: (l: string, h: string) => { stateHash: string } | null;
      }
    ).resolveWorktreeHeadInternal("vcs:repo:packages/a", "main");
    expect(head?.stateHash).toBe(stateHash);
  });

  it("does not stale-reap a concurrent op's in-flight intent, but reaps a genuine orphan", async () => {
    const stateHash = await seedCommit("c1", "packages/a", "a.txt", "A\n");
    const sql = (
      gad.instance as unknown as {
        sql: { exec: (s: string, ...a: unknown[]) => { toArray: () => unknown[] } };
      }
    ).sql;
    const pendingIntents = () =>
      sql.exec("SELECT intent_id FROM gad_publish_intents").toArray() as Array<{
        intent_id: string;
      }>;
    const inFlight = (gad.instance as unknown as { inFlightPublishIntents: Set<string> })
      .inFlightPublishIntents;

    // Park a push inside `refs.updateMains`' approval gate: intent recorded and
    // marked in-flight, but the CAS not yet applied (main still at expectedOld,
    // no ref-log transition into `next`) — so `intentIsStale` sees it as stale.
    let releaseGate!: () => void;
    const gateBlocked = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    gateOverride = () => gateBlocked;
    const pushPromise = push({
      repoPaths: ["packages/a"],
      sourceHead: vcsContextHead("c1"),
      actor: USER,
    });
    // Wait until the push has recorded its intent and parked on the gate.
    for (let i = 0; i < 100 && pendingIntents().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(pendingIntents()).toHaveLength(1);
    expect(readMain("packages/a")).toBe(null); // CAS has not landed.
    const parkedId = pendingIntents()[0]!.intent_id;
    expect(inFlight.has(parkedId)).toBe(true);

    // A concurrent heal (host-driven attach heal, or another op's on-demand
    // reconcile) runs while the intent is parked in-flight: it must NOT reap it,
    // even though the intent LOOKS stale (CAS not landed).
    const healedDuring = (await gad.call("vcsHealPublishDrift", {})) as { pendingIntents: number };
    expect(healedDuring.pendingIntents).toBe(1);
    expect(pendingIntents().map((r) => r.intent_id)).toContain(parkedId);

    // Release the gate: the parked push completes, the CAS lands, provenance is
    // recorded and the intent is cleared (and removed from the in-flight set).
    releaseGate();
    gateOverride = null;
    await pushPromise;
    expect(readMain("packages/a")).toBe(stateHash);
    expect(pendingIntents()).toHaveLength(0);
    expect(inFlight.has(parkedId)).toBe(false);

    // Genuine-orphan case: an intent present in the DB but NOT in the in-flight
    // set (a crashed op's leftover / a fresh instance whose in-memory set is
    // empty). Its CAS never landed → a heal correctly reaps it.
    const inst = gad.instance as unknown as {
      recordPublishIntent: (i: unknown) => void;
      transaction: (f: () => void) => void;
    };
    const orphanNext = "abcabc12".repeat(8);
    inst.transaction(() =>
      inst.recordPublishIntent({
        intentId: "orphan-1",
        operation: "push",
        entries: [
          {
            repoPath: "packages/a",
            logId: "vcs:repo:packages/a",
            expectedOld: stateHash, // main is at stateHash; this intent never landed
            next: orphanNext,
            parentEventId: null,
            parentStateHash: orphanNext,
            files: [],
            editOps: [],
          },
        ],
        message: null,
        actor: USER,
        sourceHead: vcsContextHead("c1"),
      })
    );
    expect(pendingIntents().map((r) => r.intent_id)).toContain("orphan-1");
    expect(inFlight.has("orphan-1")).toBe(false);
    const healedOrphan = (await gad.call("vcsHealPublishDrift", {})) as { pendingIntents: number };
    expect(healedOrphan.pendingIntents).toBe(0);
    expect(pendingIntents()).toHaveLength(0);
  });

  it("rejects an editOps sequence that breaks first-parent chain continuity (A2/U2)", async () => {
    const stateHash = await seedCommit("c1", "packages/a", "a.txt", "A\n");
    await push({ repoPaths: ["packages/a"], sourceHead: vcsContextHead("c1"), actor: USER });
    // Ingest a main provenance commit whose editOp claims a WRONG first-parent
    // old_content_hash (base is `stateHash`, but the op claims a bogus old).
    const ingest = () =>
      gad.call("ingestWorktreeState", {
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
    const merged = (await gad.call("vcsMerge", {
      logId: "vcs:repo:packages/a",
      targetHead: vcsContextHead("c2"),
      sourceHead: "main",
      actor: USER,
    })) as { status: string; eventId?: string };
    expect(merged.status).toBe("merged");
    // The merge commit owns per-file edit ops (not an op-less commit).
    const ops = (
      gad.instance as unknown as {
        sql: { exec: (s: string, ...a: unknown[]) => { toArray: () => unknown[] } };
      }
    ).sql
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
    const result = (await gad.call("vcsPush", {
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
    const kept = (
      gad.instance as unknown as {
        sql: { exec: (s: string, ...a: unknown[]) => { toArray: () => unknown[] } };
      }
    ).sql
      .exec("SELECT state_hash FROM gad_worktree_states WHERE state_hash = ?", stateHash)
      .toArray();
    expect(kept).toHaveLength(1);
    expect(mark.keptStates).toBeGreaterThan(0);
  });

  // ── Scenarios ported from the deleted host push pipeline (workspaceVcs.push
  //    .test.ts): the DO's vcsPush is now the sole executor of these paths. ──

  it("rejects duplicate repoPaths in one batch", async () => {
    await seedCommit("c1", "packages/a", "a.txt", "A\n");
    await expect(
      push({
        repoPaths: ["packages/a", "packages/a"],
        sourceHead: vcsContextHead("c1"),
        actor: USER,
      })
    ).rejects.toThrow(/duplicate repoPath "packages\/a"/);
    expect(readMain("packages/a")).toBeNull();
  });

  it("rejects a non-canonical repoPath alias outright", async () => {
    await seedCommit("c1", "packages/a", "a.txt", "A\n");
    // A trailing slash (or any `.`/empty segment) is a non-canonical alias for
    // "packages/a" that would collide on disk; it is now rejected at the
    // normalizer rather than silently stripped, so aliases never reach dedup.
    await expect(
      push({
        repoPaths: ["packages/a/"],
        sourceHead: vcsContextHead("c1"),
        actor: USER,
      })
    ).rejects.toThrow(/Invalid workspace repo path/);
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
      report({ repoPath: "packages/a", required: true, status: "ok" }),
      report({ repoPath: "panels/dependent", required: false, status: "failed" }),
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

  it("completes provenance from the parked intent when a lost-response retry surfaces as a conflict (own CAS landed)", async () => {
    const stateHash = await seedCommit("c1", "packages/a", "a.txt", "A\n");
    const sql = (
      gad.instance as unknown as {
        sql: { exec: (s: string, ...a: unknown[]) => { toArray: () => unknown[] } };
      }
    ).sql;
    // Simulate the httpClient auto-retry hazard: attempt 1 commits host-side but
    // its response is lost, so the DO re-POSTs and hits the ref it ALREADY
    // advanced → a compare-and-swap conflict. The intent must NOT be discarded
    // before that conflict is classified; the CAS landed, so provenance must be
    // recorded with full fidelity (NOT a spurious success with the intent thrown
    // away, and NOT an unrecoverable no-intent drift).
    const refsBridge = (
      gad.instance as unknown as {
        refsStore: () => { updateMains: (i: unknown) => Promise<unknown> };
      }
    ).refsStore();
    const originalUpdate = refsBridge.updateMains.bind(refsBridge);
    let applied = false;
    refsBridge.updateMains = async (input: unknown) => {
      if (!applied) {
        applied = true;
        await originalUpdate(input); // attempt 1 lands host-side (ref advances)
        // ...its response is lost; the retry POST conflicts on the ref we moved.
        throw new Error("Main-ref group compare-and-swap conflict: lost response");
      }
      return originalUpdate(input);
    };

    const result = await push({
      repoPaths: ["packages/a"],
      sourceHead: vcsContextHead("c1"),
      actor: USER,
    });
    // The ref landed; the outcome is a clean up-to-date/pushed, never an error.
    expect(["pushed", "up-to-date"]).toContain(result.status);
    expect(readMain("packages/a")).toBe(stateHash);

    // Provenance recorded with full fidelity: the DO main head matches the ref.
    const head = (
      gad.instance as unknown as {
        resolveWorktreeHeadInternal: (
          l: string,
          h: string
        ) => { stateHash: string; commitEventId: string | null } | null;
      }
    ).resolveWorktreeHeadInternal("vcs:repo:packages/a", "main");
    expect(head?.stateHash).toBe(stateHash);
    // The main commit's ops are REAL (from the parked intent), not an invented
    // no-intent recovery.
    const ops = sql
      .exec(
        "SELECT synthetic FROM gad_worktree_edit_ops WHERE committed_event_id = ?",
        head?.commitEventId
      )
      .toArray() as Array<{ synthetic: number | null }>;
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.every((o) => o.synthetic == null)).toBe(true);

    // Intent completed + cleared (not left parked, not deleted without provenance).
    const pending = sql.exec("SELECT * FROM gad_publish_intents").toArray();
    expect(pending).toHaveLength(0);
  });

  it("parks then heal-reaps the write-ahead intent on a pre-CAS approval denial (no ref move)", async () => {
    await seedCommit("c1", "packages/a", "a.txt", "A\n");
    const sql = (
      gad.instance as unknown as {
        sql: { exec: (s: string, ...a: unknown[]) => { toArray: () => unknown[] } };
      }
    ).sql;
    // The approval gate denies INSIDE updateMains, before the swap: no ref moves.
    // This surfaces to the DO as a non-conflict throw — indistinguishable by error
    // type from a post-apply transport error — so the DO does NOT eagerly delete;
    // it parks the write-ahead intent for the ref-log reconciliation to settle.
    gateOverride = async () => {
      throw new Error("approval denied by policy");
    };
    await expect(
      push({ repoPaths: ["packages/a"], sourceHead: vcsContextHead("c1"), actor: USER })
    ).rejects.toThrow(/approval denied/);
    gateOverride = null;

    // No ref advanced.
    expect(readMain("packages/a")).toBe(null);
    // Parked (not eagerly deleted), and NOT in-flight after the failed attempt.
    const parked = sql.exec("SELECT intent_id FROM gad_publish_intents").toArray();
    expect(parked).toHaveLength(1);
    const inFlight = (gad.instance as unknown as { inFlightPublishIntents: Set<string> })
      .inFlightPublishIntents;
    expect(inFlight.size).toBe(0);

    // Heal reconciles against the ref log: the CAS never landed (main absent, no
    // log transition into `next`) → the intent is a genuine orphan and is reaped.
    const healed = (await gad.call("vcsHealPublishDrift", {})) as { pendingIntents: number };
    expect(healed.pendingIntents).toBe(0);
    expect(sql.exec("SELECT * FROM gad_publish_intents").toArray()).toHaveLength(0);
    // No recovery commit was fabricated for a main that never moved.
    expect(readMain("packages/a")).toBe(null);
    const head = (
      gad.instance as unknown as {
        resolveWorktreeHeadInternal: (l: string, h: string) => { stateHash: string } | null;
      }
    ).resolveWorktreeHeadInternal("vcs:repo:packages/a", "main");
    expect(head).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Source-head confinement (register row 11): a sandboxed caller may only push
  // its OWN `ctx:` head. The context is HOST-VERIFIED — threaded on the dispatch
  // envelope (`message.callerContextId`), never client-asserted. We drive the DO
  // through the REAL `__rpc` envelope path (as the relay does) so the read-at-
  // entry `this.caller` / `this.callerContextId` binding is exercised.
  // -------------------------------------------------------------------------
  describe("source-head confinement", () => {
    async function pushViaEnvelope(
      caller: { callerId: string; callerKind: string },
      callerContextId: string | undefined,
      input: {
        repoPaths: string[];
        sourceHead?: string | null;
        actor?: { id: string; kind: string };
      }
    ): Promise<{ status: string; repoPaths?: string[] }> {
      const objectKey = "workspace-gad";
      const fetchable = gad.instance as unknown as { fetch(r: Request): Promise<Response> };
      const envelope = {
        from: caller.callerId,
        target: `do:test:${objectKey}`,
        delivery: {
          caller: {
            ...caller,
            authorization: createTestDirectAuthority({
              callerKind: caller.callerKind,
              source: "test",
              className: "TestDO",
              objectKey,
              method: "vcsPush",
            }),
          },
        },
        provenance: [],
        message: {
          type: "request",
          requestId: crypto.randomUUID(),
          fromId: caller.callerId,
          method: "vcsPush",
          args: [input],
          ...(callerContextId ? { callerContextId } : {}),
        },
      };
      const res = await fetchable.fetch(
        new Request(`http://test/${objectKey}/__rpc`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(envelope),
        })
      );
      const text = await res.text();
      const respEnv = (text ? JSON.parse(text) : {}) as {
        message?: { type?: string; result?: unknown; error?: unknown };
      };
      const msg = respEnv.message;
      if (msg?.type === "response" && msg.error != null) {
        throw new Error(typeof msg.error === "string" ? msg.error : JSON.stringify(msg.error));
      }
      return msg?.result as { status: string; repoPaths?: string[] };
    }

    it("rejects a sandboxed caller pushing a FOREIGN context head", async () => {
      await seedCommit("c1", "packages/a", "a.txt", "A\n");
      await expect(
        pushViaEnvelope({ callerId: "panel:p1", callerKind: "panel" }, "c2", {
          repoPaths: ["packages/a"],
          sourceHead: vcsContextHead("c1"),
        })
      ).rejects.toThrow(/may only push their own context head \(ctx:c2\)/);
      expect(readMain("packages/a")).toBe(null);
    });

    it("defaults an omitted sourceHead to the sandboxed caller's own context head", async () => {
      const stateHash = await seedCommit("c1", "packages/a", "a.txt", "A\n");
      const result = await pushViaEnvelope({ callerId: "panel:p1", callerKind: "panel" }, "c1", {
        repoPaths: ["packages/a"],
      });
      expect(result.status).toBe("pushed");
      expect(readMain("packages/a")).toBe(stateHash);
    });

    it("rejects an omitted sourceHead when no registered context is available", async () => {
      await seedCommit("c1", "packages/a", "a.txt", "A\n");
      await expect(
        pushViaEnvelope({ callerId: "panel:p1", callerKind: "panel" }, undefined, {
          repoPaths: ["packages/a"],
        })
      ).rejects.toThrow(/sourceHead is required.*no registered context/);
      expect(readMain("packages/a")).toBe(null);
    });

    it("rejects an empty explicit sourceHead before source resolution", async () => {
      await seedCommit("c1", "packages/a", "a.txt", "A\n");
      await expect(
        pushViaEnvelope({ callerId: "panel:p1", callerKind: "panel" }, "c1", {
          repoPaths: ["packages/a"],
          sourceHead: "",
        })
      ).rejects.toThrow(/sourceHead must be a non-empty string/);
      expect(readMain("packages/a")).toBe(null);
    });

    it("fails closed when a sandboxed caller has NO registered context", async () => {
      await seedCommit("c1", "packages/a", "a.txt", "A\n");
      await expect(
        pushViaEnvelope({ callerId: "panel:p1", callerKind: "panel" }, undefined, {
          repoPaths: ["packages/a"],
          sourceHead: vcsContextHead("c1"),
        })
      ).rejects.toThrow(/has no registered context/);
      expect(readMain("packages/a")).toBe(null);
    });

    it("allows a sandboxed caller to push its OWN context head", async () => {
      const stateHash = await seedCommit("c1", "packages/a", "a.txt", "A\n");
      const result = await pushViaEnvelope({ callerId: "panel:p1", callerKind: "panel" }, "c1", {
        repoPaths: ["packages/a"],
        sourceHead: vcsContextHead("c1"),
      });
      expect(result.status).toBe("pushed");
      expect(readMain("packages/a")).toBe(stateHash);
    });

    it("derives a do actor from an RPC envelope when actor is omitted", async () => {
      const stateHash = await seedCommit("c1", "packages/a", "a.txt", "A\n");
      const result = await pushViaEnvelope({ callerId: "do:agent", callerKind: "do" }, "c1", {
        repoPaths: ["packages/a"],
        sourceHead: vcsContextHead("c1"),
      });
      expect(result.status).toBe("pushed");
      expect(readMain("packages/a")).toBe(stateHash);

      const log = (
        gad.instance as unknown as {
          vcsLog: (
            repoPath: string,
            limit: number,
            head: string
          ) => Array<{ actor: unknown; outputStateHash: string | null }>;
        }
      ).vcsLog("packages/a", 50, "main");
      const entry = log.find((e) => e.outputStateHash === stateHash);
      expect(entry?.actor).toEqual({ id: "do:agent", kind: "do" });
    });

    it("leaves privileged (server/chrome) callers UNRESTRICTED — any source head", async () => {
      // A server caller with no context registration pushes a `ctx:` head that is
      // not "its own" — the old `isPrivilegedCaller` short-circuit still applies.
      const stateHash = await seedCommit("c1", "packages/a", "a.txt", "A\n");
      const result = await pushViaEnvelope(
        { callerId: "server", callerKind: "server" },
        undefined,
        { repoPaths: ["packages/a"], sourceHead: vcsContextHead("c1"), actor: USER }
      );
      expect(result.status).toBe("pushed");
      expect(readMain("packages/a")).toBe(stateHash);
    });
  });
});
