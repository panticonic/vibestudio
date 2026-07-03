import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UnitBatchEntry } from "@vibez1/shared/approvals";
import { createVerifiedCaller } from "@vibez1/shared/serviceDispatcher";
import { unitChangeSessionGrantKey, type UnitMetaChangeApprovalProvider } from "@vibez1/unit-host";
import { EMPTY_STATE_HASH } from "@vibez1/shared/contentTree/worktreeHash";
import type { ApprovalQueue } from "./approvalQueue.js";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { mirrorWorktreeTree, putBytes } from "./blobstoreService.js";
import {
  createMainAdvanceApprovalGate,
  createMainRefAdvanceGate,
  type MainAdvanceApprovalCandidate,
  type MetaApprovalGrantStore,
  type RefAdvanceGateContext,
  type RepoDeletionApprovalCandidate,
  type RepoRestoreApprovalCandidate,
} from "./mainAdvanceApproval.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempStatePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibez1-main-advance-"));
  roots.push(root);
  return root;
}

class MemoryGrantStore implements MetaApprovalGrantStore {
  readonly grants = new Map<string, number>();

  hasActive(key: string): boolean {
    const expiresAt = this.grants.get(key);
    return expiresAt !== undefined && expiresAt > Date.now();
  }

  grant(key: string, ttlMs: number): void {
    this.grants.set(key, Date.now() + ttlMs);
  }
}

const unit: UnitBatchEntry = {
  unitKind: "extension",
  unitName: "@workspace-extensions/tools",
  displayName: "Tools",
  version: "1.0.0",
  source: { kind: "workspace-repo", repo: "extensions/tools", ref: "main" },
  capabilities: [],
};

/** A protected-ref advance candidate as the ref gate produces it: caller +
 *  repo + SERVER-COMPUTED changed paths + candidate view. */
function candidate(
  overrides: Partial<MainAdvanceApprovalCandidate> = {}
): MainAdvanceApprovalCandidate {
  return {
    caller: panelCaller(),
    repoPath: "meta",
    changedPaths: ["meta/vibez1.yml"],
    stateHash: "state:next",
    sourceHead: "ctx:ctx-1",
    ...overrides,
  };
}

function panelCaller() {
  return createVerifiedCaller("panel-1", "panel", {
    callerId: "panel-1",
    callerKind: "panel",
    repoPath: "panels/test",
    effectiveVersion: "ev-panel",
  });
}

function approvalQueue(decision: "once" | "session" | "version" | "repo" | "deny") {
  return {
    request: vi.fn(async () => decision),
  } as unknown as ApprovalQueue & { request: ReturnType<typeof vi.fn> };
}

function gateDeps(opts: { decision?: "once" | "session" | "version" | "repo" | "deny" } = {}) {
  const queue = approvalQueue(opts.decision ?? "once");
  const grantStore = new MemoryGrantStore();
  return {
    approvalQueue: queue,
    grantStore,
    grantTtlMs: 1000,
    capabilityGrantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    getProviders: () => [] as UnitMetaChangeApprovalProvider<UnitBatchEntry>[],
  };
}

describe("createMainAdvanceApprovalGate", () => {
  it("approves main meta advances with the semantic unit-batch prompt", async () => {
    const deps = gateDeps({ decision: "session" });
    const provider: UnitMetaChangeApprovalProvider<UnitBatchEntry> = {
      metaChangeApprovalForCommit: vi.fn(async () => ({
        units: [unit],
        identityKeys: ["identity:unit"],
      })),
      acceptPreapprovedTrust: vi.fn(),
    };
    const gate = createMainAdvanceApprovalGate({
      ...deps,
      getProviders: () => [provider],
    });

    await gate.approve(candidate());

    expect(provider.metaChangeApprovalForCommit).toHaveBeenCalledWith("state:next");
    expect(deps.approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-batch",
        callerId: "panel-1",
        callerKind: "panel",
        repoPath: "panels/test",
        effectiveVersion: "ev-panel",
        trigger: "meta-change",
        configWrite: {
          repoPath: "meta",
          summary: "meta/vibez1.yml changed",
        },
        units: [unit],
      })
    );
    expect(
      deps.grantStore.hasActive(unitChangeSessionGrantKey("panel-1", "meta", "meta", "main"))
    ).toBe(true);
    expect(provider.acceptPreapprovedTrust).toHaveBeenCalledWith(["identity:unit"]);
  });

  it("does not re-prompt for the same preapproved meta identity on retry", async () => {
    const deps = gateDeps({ decision: "once" });
    const provider: UnitMetaChangeApprovalProvider<UnitBatchEntry> = {
      metaChangeApprovalForCommit: vi.fn(async () => ({
        units: [unit],
        identityKeys: ["identity:unit"],
      })),
      acceptPreapprovedTrust: vi.fn(),
    };
    const gate = createMainAdvanceApprovalGate({
      ...deps,
      getProviders: () => [provider],
    });
    const cand = candidate();

    await gate.approve(cand);
    await gate.approve(cand);

    expect(deps.approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(provider.acceptPreapprovedTrust).toHaveBeenCalledTimes(2);
  });

  it("approves non-meta main advances with the workspace repo write capability prompt", async () => {
    const deps = gateDeps({ decision: "repo" });
    const provider: UnitMetaChangeApprovalProvider<UnitBatchEntry> = {
      metaChangeApprovalForCommit: vi.fn(async () => ({ units: [unit], identityKeys: [] })),
      acceptPreapprovedTrust: vi.fn(),
    };
    const gate = createMainAdvanceApprovalGate({ ...deps, getProviders: () => [provider] });

    await gate.approve(
      candidate({ repoPath: "apps/shell", changedPaths: ["apps/shell/index.tsx"] })
    );

    expect(deps.approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "capability",
        callerId: "panel-1",
        callerKind: "panel",
        repoPath: "panels/test",
        effectiveVersion: "ev-panel",
        capability: "workspace-repo-write",
        grantResourceKey: "workspace-source-change:main",
        title: "Update workspace main",
        description: "This advance moves workspace main and changes 1 path.",
        resource: {
          type: "vcs-head",
          label: "Head",
          value: "workspace main",
        },
        details: [
          { label: "Repo", value: "apps/shell" },
          { label: "Source", value: "ctx:ctx-1" },
          { label: "State", value: "state:next" },
          { label: "Changes", value: "apps/shell/index.tsx" },
          { label: "Built", value: "not validated" },
        ],
      })
    );
    expect(provider.metaChangeApprovalForCommit).not.toHaveBeenCalled();
  });

  it("bypasses the prompt for a chrome-authorized RESOLVED caller (on-behalf-of, not the writer DO)", async () => {
    // §10 attribution + §5 chrome bypass: a shell-originated push flows through
    // the same vcs DO as a panel push, but the gate keys on the host-RESOLVED
    // on-behalf-of caller. A chrome/shell principal keeps its user-level trust,
    // so no approval is queued — regardless of the (untrusted) writer DO.
    const deps = gateDeps({ decision: "deny" });
    const gate = createMainAdvanceApprovalGate(deps);
    const shell = createVerifiedCaller("shell:device-1", "shell");

    await gate.approve(
      candidate({
        caller: shell,
        via: "do:workers/gad-store:GadStore:vcs",
        repoPath: "apps/shell",
        changedPaths: ["apps/shell/index.tsx"],
      })
    );

    expect(deps.approvalQueue.request).not.toHaveBeenCalled();
  });

  it("does not let meta session grants skip mixed workspace changes", async () => {
    // Defensive guard: production candidates are per-repo (all-meta or
    // no-meta — the ref gate re-roots every path with the one advancing
    // repo), but if a mixed candidate ever appeared, a `meta` session grant
    // must NOT silently cover the non-meta paths. The summary reports the
    // meta paths only (the unreachable mixed-path summary branch was
    // deleted in P5b).
    const deps = gateDeps({ decision: "once" });
    deps.grantStore.grant(unitChangeSessionGrantKey("panel-1", "meta", "meta", "main"), 1000);
    const gate = createMainAdvanceApprovalGate({
      ...deps,
      getProviders: () => [
        {
          metaChangeApprovalForCommit: vi.fn(async () => ({ units: [], identityKeys: [] })),
          acceptPreapprovedTrust: vi.fn(),
        },
      ],
    });

    await gate.approve(candidate({ changedPaths: ["meta/vibez1.yml", "apps/shell/index.tsx"] }));

    expect(deps.approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-batch",
        configWrite: {
          repoPath: "meta",
          summary: "meta/vibez1.yml changed",
        },
      })
    );
  });

  it("does not prompt (or forward a diff payload) for an advance with no changed paths", async () => {
    const deps = gateDeps({ decision: "once" });
    const gate = createMainAdvanceApprovalGate(deps);

    await gate.approve(
      candidate({
        repoPath: "apps/shell",
        changedPaths: [],
        diffReview: [
          {
            repoPath: "apps/shell",
            oldState: "state:a",
            newState: "state:b",
            diffStat: { filesChanged: 0 },
            changedFiles: [],
          },
        ],
      })
    );

    expect(deps.approvalQueue.request).not.toHaveBeenCalled();
  });

  it("forwards the diff-review payload onto the workspace-repo-write prompt", async () => {
    const deps = gateDeps({ decision: "once" });
    const gate = createMainAdvanceApprovalGate(deps);
    const diffReview = [
      {
        repoPath: "apps/shell",
        oldState: "state:a",
        newState: "state:b",
        diffStat: { filesChanged: 1, insertions: 2, deletions: 1 },
        changedFiles: [
          { path: "index.tsx", kind: "changed" as const, oldHash: "h1", newHash: "h2" },
        ],
      },
    ];

    await gate.approve(
      candidate({ repoPath: "apps/shell", changedPaths: ["apps/shell/index.tsx"], diffReview })
    );

    expect(deps.approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "capability", diffReview })
    );
  });

  it("rejects denied main meta advances", async () => {
    const gate = createMainAdvanceApprovalGate({
      ...gateDeps({ decision: "deny" }),
      getProviders: () => [
        {
          metaChangeApprovalForCommit: vi.fn(async () => ({ units: [], identityKeys: [] })),
          acceptPreapprovedTrust: vi.fn(),
        },
      ],
    });

    await expect(gate.approve(candidate())).rejects.toThrow("Workspace config push denied");
  });

  it("rejects denied non-meta main advances", async () => {
    const gate = createMainAdvanceApprovalGate(gateDeps({ decision: "deny" }));

    await expect(
      gate.approve(
        candidate({
          repoPath: "panels/spectrolite",
          changedPaths: ["panels/spectrolite/index.tsx"],
        })
      )
    ).rejects.toThrow("Workspace main update denied");
  });

  describe("approveRepoDeletion", () => {
    const deletionCandidate = {
      caller: panelCaller(),
      repoPath: "panels/old",
      fileCount: 3,
      stateHash: "state:doomed",
    };

    it("prompts with the dedicated severe per-repo deletion capability", async () => {
      const deps = gateDeps({ decision: "once" });
      const gate = createMainAdvanceApprovalGate(deps);

      await gate.approveRepoDeletion(deletionCandidate);

      expect(deps.approvalQueue.request).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "capability",
          capability: "workspace-repo-delete",
          severity: "severe",
          grantResourceKey: "workspace-repo-delete:panels/old",
        })
      );
    });

    it("throws when the user denies the deletion", async () => {
      const gate = createMainAdvanceApprovalGate(gateDeps({ decision: "deny" }));
      await expect(gate.approveRepoDeletion(deletionCandidate)).rejects.toThrow(
        /Deletion of panels\/old denied/
      );
    });

    it("is NOT auto-approved by a prior generic workspace-repo-write grant", async () => {
      const deps = gateDeps({ decision: "deny" });
      // Pre-grant the ordinary write capability broadly for this caller.
      deps.capabilityGrantStore.grant(
        "workspace-repo-write",
        "workspace-source-change:main",
        { callerId: "panel-1", repoPath: "panels/test", effectiveVersion: "ev-panel" },
        "session"
      );
      const gate = createMainAdvanceApprovalGate(deps);

      // The deletion must STILL prompt (and here be denied) — the write grant
      // does not cover the distinct `workspace-repo-delete` capability.
      await expect(gate.approveRepoDeletion(deletionCandidate)).rejects.toThrow(/denied/);
      expect(deps.approvalQueue.request).toHaveBeenCalledTimes(1);
    });
  });

  describe("approveRepoRestore", () => {
    const restoreCandidate = {
      caller: panelCaller(),
      repoPath: "panels/old",
      fileCount: 2,
      stateHash: "state:archived",
    };

    it("prompts with the dedicated restore capability", async () => {
      const deps = gateDeps({ decision: "once" });
      const gate = createMainAdvanceApprovalGate(deps);
      await gate.approveRepoRestore(restoreCandidate);
      expect(deps.approvalQueue.request).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "capability",
          capability: "workspace-repo-restore",
          grantResourceKey: "workspace-repo-restore:panels/old",
        })
      );
    });

    it("throws when the user denies the restore", async () => {
      const gate = createMainAdvanceApprovalGate(gateDeps({ decision: "deny" }));
      await expect(gate.approveRepoRestore(restoreCandidate)).rejects.toThrow(
        /Restore of panels\/old denied/
      );
    });
  });
});

describe("createMainRefAdvanceGate (the reshaped batch approval gate)", () => {
  /** Mirror a repo-relative file listing into a scratch blob store and return
   *  its state hash — the CAS'd trees the gate diffs. */
  async function stageTree(
    blobsDir: string,
    files: Array<{ path: string; body: string }>
  ): Promise<string> {
    fs.mkdirSync(path.join(blobsDir, "tmp"), { recursive: true });
    const listing = [];
    for (const file of files) {
      const { digest } = await putBytes(blobsDir, Buffer.from(file.body, "utf8"));
      listing.push({ path: file.path, contentHash: digest, mode: 33188 });
    }
    const mirrored = await mirrorWorktreeTree(blobsDir, listing);
    return mirrored.stateHash;
  }

  function refGateDeps(blobsDir: string) {
    const approvals: MainAdvanceApprovalCandidate[] = [];
    const deletions: Array<{ repoPath: string; fileCount: number; stateHash: string }> = [];
    const restores: Array<{ repoPath: string; fileCount: number; stateHash: string }> = [];
    // Full candidates (incl. the diff-review payload) captured separately so the
    // existing summary assertions on `deletions`/`restores` stay exact.
    const deletionCandidates: RepoDeletionApprovalCandidate[] = [];
    const restoreCandidates: RepoRestoreApprovalCandidate[] = [];
    const gate = createMainRefAdvanceGate({
      blobsDir,
      approvalGate: {
        approve: async (candidate) => {
          approvals.push(candidate);
        },
        approveRepoDeletion: async (c) => {
          deletions.push({ repoPath: c.repoPath, fileCount: c.fileCount, stateHash: c.stateHash });
          deletionCandidates.push(c);
        },
        approveRepoRestore: async (c) => {
          restores.push({ repoPath: c.repoPath, fileCount: c.fileCount, stateHash: c.stateHash });
          restoreCandidates.push(c);
        },
      },
      // Trees are staged locally above; like the real vcsHost implementation,
      // the empty state needs no store round trip — just the empty tree node.
      ensureStateMirrored: async (stateHash) => {
        if (stateHash === EMPTY_STATE_HASH) await mirrorWorktreeTree(blobsDir, []);
      },
      workspaceViewWithReposAt: async () => "state:composed-fallback",
    });
    return { gate, approvals, deletions, restores, deletionCandidates, restoreCandidates };
  }

  type Entry = {
    repoPath?: string;
    old?: string | null;
    next: string | null;
    priorDeleted?: boolean;
  };

  function batch(
    entries: Entry[],
    context: unknown,
    operation: "push" | "merge" | "import" | "delete" | "restore" = "push"
  ) {
    return {
      entries: entries.map((e) => ({
        repoPath: e.repoPath ?? "panels/x",
        old: e.old ?? null,
        next: e.next,
        priorDeleted: e.priorDeleted ?? false,
      })),
      operation,
      reason: "test",
      writer: "do:workers/gad-store:GadStore:vcs",
      onBehalfOf: null,
      ...(context !== undefined ? { gateContext: context } : {}),
    };
  }

  it("fails CLOSED when the batch carries no gate context", async () => {
    const blobsDir = path.join(tempStatePath(), "blobs");
    const { gate, approvals } = refGateDeps(blobsDir);
    const next = await stageTree(blobsDir, [{ path: "a.txt", body: "a\n" }]);

    await expect(gate(batch([{ next }], undefined))).rejects.toThrow(/no gate context/);
    expect(approvals).toHaveLength(0);
  });

  it("system advances (scans/bootstrap/adoption) bypass approval", async () => {
    const blobsDir = path.join(tempStatePath(), "blobs");
    const { gate, approvals } = refGateDeps(blobsDir);
    const next = await stageTree(blobsDir, [{ path: "a.txt", body: "a\n" }]);

    await gate(batch([{ next }], { kind: "system" }));
    expect(approvals).toHaveLength(0);
  });

  it("computes the approval's changed paths from the server-side tree diff, re-rooted to the repo", async () => {
    const blobsDir = path.join(tempStatePath(), "blobs");
    const { gate, approvals } = refGateDeps(blobsDir);
    const oldState = await stageTree(blobsDir, [
      { path: "kept.txt", body: "same\n" },
      { path: "changed.txt", body: "v1\n" },
      { path: "removed.txt", body: "bye\n" },
    ]);
    const next = await stageTree(blobsDir, [
      { path: "kept.txt", body: "same\n" },
      { path: "changed.txt", body: "v2\n" },
      { path: "added.txt", body: "hi\n" },
    ]);
    const context: RefAdvanceGateContext = {
      kind: "caller",
      caller: panelCaller(),
      sourceHead: "ctx:ctx-1",
    };

    await gate(batch([{ old: oldState, next }], context));

    expect(approvals).toHaveLength(1);
    const candidate = approvals[0]!;
    // Server-computed: exactly the tree delta, never anything the caller
    // proposed; kept.txt (identical) is absent.
    expect([...candidate.changedPaths].sort()).toEqual([
      "panels/x/added.txt",
      "panels/x/changed.txt",
      "panels/x/removed.txt",
    ]);
    expect(candidate.repoPath).toBe("panels/x");
    expect(candidate.sourceHead).toBe("ctx:ctx-1");
    // No candidate view supplied → the gate composes one itself.
    expect(candidate.stateHash).toBe("state:composed-fallback");
  });

  it("a main creation (old null) diffs against the empty tree", async () => {
    const blobsDir = path.join(tempStatePath(), "blobs");
    const { gate, approvals } = refGateDeps(blobsDir);
    const next = await stageTree(blobsDir, [
      { path: "a.txt", body: "a\n" },
      { path: "b/c.txt", body: "c\n" },
    ]);

    await gate(
      batch([{ old: null, next }], {
        kind: "caller",
        caller: panelCaller(),
      } satisfies RefAdvanceGateContext)
    );

    expect(approvals).toHaveLength(1);
    expect([...approvals[0]!.changedPaths].sort()).toEqual(["panels/x/a.txt", "panels/x/b/c.txt"]);
  });

  it("passes a supplied candidate workspace view through (batches share one)", async () => {
    const blobsDir = path.join(tempStatePath(), "blobs");
    const { gate, approvals } = refGateDeps(blobsDir);
    const next = await stageTree(blobsDir, [{ path: "a.txt", body: "a\n" }]);

    await gate(
      batch([{ next }], {
        kind: "caller",
        caller: panelCaller(),
        candidateWorkspaceState: "state:group-candidate",
      } satisfies RefAdvanceGateContext)
    );

    expect(approvals[0]!.stateHash).toBe("state:group-candidate");
  });

  it("routes a delete entry (next null) to the severe repo-deletion capability", async () => {
    const blobsDir = path.join(tempStatePath(), "blobs");
    const { gate, approvals, deletions } = refGateDeps(blobsDir);
    const oldState = await stageTree(blobsDir, [
      { path: "a.txt", body: "a\n" },
      { path: "b.txt", body: "b\n" },
    ]);

    await gate(
      batch([{ repoPath: "panels/old", old: oldState, next: null }], {
        kind: "caller",
        caller: panelCaller(),
      } satisfies RefAdvanceGateContext)
    );

    expect(approvals).toHaveLength(0);
    expect(deletions).toEqual([{ repoPath: "panels/old", fileCount: 2, stateHash: oldState }]);
  });

  it("treats a re-creation (old null, non-null next) as an ordinary content advance", async () => {
    // Phase 5: the host no longer classifies restores. A previously-deleted
    // repo's re-creation is just an expectedOld:null → tree advance; the
    // restore saga (archive lookup, restore capability) lives in the DO now.
    const blobsDir = path.join(tempStatePath(), "blobs");
    const { gate, approvals, restores } = refGateDeps(blobsDir);
    const next = await stageTree(blobsDir, [{ path: "a.txt", body: "a\n" }]);

    await gate(
      batch([{ repoPath: "panels/old", old: null, next }], {
        kind: "caller",
        caller: panelCaller(),
      } satisfies RefAdvanceGateContext)
    );

    expect(restores).toHaveLength(0);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.repoPath).toBe("panels/old");
    expect([...approvals[0]!.changedPaths]).toEqual(["panels/old/a.txt"]);
  });

  it("a mixed batch (advance + delete) yields one advance prompt and one deletion prompt", async () => {
    const blobsDir = path.join(tempStatePath(), "blobs");
    const { gate, approvals, deletions } = refGateDeps(blobsDir);
    const advNext = await stageTree(blobsDir, [{ path: "x.txt", body: "x\n" }]);
    const delOld = await stageTree(blobsDir, [{ path: "y.txt", body: "y\n" }]);

    await gate(
      batch(
        [
          { repoPath: "panels/keep", old: null, next: advNext },
          { repoPath: "panels/drop", old: delOld, next: null },
        ],
        {
          kind: "caller",
          caller: panelCaller(),
          candidateWorkspaceState: "state:batch-view",
        } satisfies RefAdvanceGateContext
      )
    );

    expect(approvals.map((c) => c.repoPath)).toEqual(["panels/keep"]);
    expect(approvals[0]!.stateHash).toBe("state:batch-view");
    expect(deletions.map((d) => d.repoPath)).toEqual(["panels/drop"]);
  });

  describe("diff-review payload (§5.1)", () => {
    const HEX64 = /^[0-9a-f]{64}$/;
    const callerContext = (
      extra: Partial<Extract<RefAdvanceGateContext, { kind: "caller" }>> = {}
    ): RefAdvanceGateContext => ({
      kind: "caller",
      caller: panelCaller(),
      ...extra,
    });

    it("attaches per-entry kinds/hashes and accurate line counts for an advance", async () => {
      const blobsDir = path.join(tempStatePath(), "blobs");
      const { gate, approvals } = refGateDeps(blobsDir);
      const oldState = await stageTree(blobsDir, [
        { path: "kept.txt", body: "same\n" },
        { path: "changed.txt", body: "l1\nl2\nl3\n" },
        { path: "removed.txt", body: "bye\n" },
      ]);
      const next = await stageTree(blobsDir, [
        { path: "kept.txt", body: "same\n" },
        { path: "changed.txt", body: "l1\nL2\nl3\n" },
        { path: "added.txt", body: "new\n" },
      ]);

      await gate(batch([{ old: oldState, next }], callerContext()));

      const review = approvals[0]!.diffReview!;
      expect(review).toHaveLength(1);
      const entry = review[0]!;
      expect(entry.repoPath).toBe("panels/x");
      expect(entry.oldState).toBe(oldState);
      expect(entry.newState).toBe(next);
      // filesChanged is exact; line totals are the accurate per-file sums:
      //   changed.txt +1/-1, added.txt +1, removed.txt -1.
      expect(entry.diffStat).toEqual({ filesChanged: 3, insertions: 2, deletions: 2 });

      const byPath = Object.fromEntries(entry.changedFiles.map((f) => [f.path, f]));
      expect(byPath["added.txt"]!.kind).toBe("added");
      expect(byPath["added.txt"]!.newHash).toMatch(HEX64);
      expect(byPath["added.txt"]!.oldHash).toBeUndefined();
      expect(byPath["removed.txt"]!.kind).toBe("removed");
      expect(byPath["removed.txt"]!.oldHash).toMatch(HEX64);
      expect(byPath["removed.txt"]!.newHash).toBeUndefined();
      expect(byPath["changed.txt"]!.kind).toBe("changed");
      expect(byPath["changed.txt"]!.oldHash).toMatch(HEX64);
      expect(byPath["changed.txt"]!.newHash).toMatch(HEX64);
      expect(byPath["changed.txt"]!.oldHash).not.toBe(byPath["changed.txt"]!.newHash);
      // The diff-review payload is the SAME array across the whole batch.
      expect(approvals[0]!.diffReview).toBe(review);
    });

    it("attaches an all-removed payload with newState null for a delete entry", async () => {
      const blobsDir = path.join(tempStatePath(), "blobs");
      const { gate, deletionCandidates } = refGateDeps(blobsDir);
      const oldState = await stageTree(blobsDir, [
        { path: "a.txt", body: "a\n" },
        { path: "b.txt", body: "b\n" },
      ]);

      await gate(batch([{ repoPath: "panels/old", old: oldState, next: null }], callerContext()));

      const entry = deletionCandidates[0]!.diffReview![0]!;
      expect(entry.repoPath).toBe("panels/old");
      expect(entry.oldState).toBe(oldState);
      expect(entry.newState).toBeNull();
      expect(entry.changedFiles.every((f) => f.kind === "removed")).toBe(true);
      expect(entry.changedFiles.every((f) => f.oldHash && !f.newHash)).toBe(true);
      // All-removed text: two one-line files → 0 insertions, 2 deletions.
      expect(entry.diffStat).toEqual({ filesChanged: 2, insertions: 0, deletions: 2 });
    });

    it("flags binary and oversized files and omits the entry's line totals", async () => {
      const blobsDir = path.join(tempStatePath(), "blobs");
      const { gate, approvals } = refGateDeps(blobsDir);
      const bigBody = "x".repeat(1024 * 1024 + 16); // > 1 MiB → tooLarge
      const next = await stageTree(blobsDir, [
        { path: "text.txt", body: "hi\n" },
        { path: "bin.dat", body: "a b\n" },
        { path: "big.txt", body: bigBody },
      ]);

      await gate(batch([{ old: null, next }], callerContext()));

      const entry = approvals[0]!.diffReview![0]!;
      const byPath = Object.fromEntries(entry.changedFiles.map((f) => [f.path, f]));
      expect(byPath["bin.dat"]!.binary).toBe(true);
      expect(byPath["big.txt"]!.tooLarge).toBe(true);
      expect(byPath["text.txt"]!.binary).toBeUndefined();
      expect(byPath["text.txt"]!.tooLarge).toBeUndefined();
      // A skipped (binary/oversized) file forfeits the whole entry's line totals.
      expect(entry.diffStat).toEqual({ filesChanged: 3 });
      expect(entry.diffStat.insertions).toBeUndefined();
    });

    it("truncates the file list at the cap while keeping filesChanged exact", async () => {
      const blobsDir = path.join(tempStatePath(), "blobs");
      const { gate, approvals } = refGateDeps(blobsDir);
      const files = Array.from({ length: 501 }, (_, i) => ({
        path: `f${String(i).padStart(4, "0")}.txt`,
        body: `line-${i}\n`,
      }));
      const next = await stageTree(blobsDir, files);

      await gate(batch([{ old: null, next }], callerContext()));

      const entry = approvals[0]!.diffReview![0]!;
      expect(entry.changedFiles).toHaveLength(500);
      expect(entry.truncated).toBe(true);
      expect(entry.diffStat.filesChanged).toBe(501);
      // A truncated list can't carry accurate totals → omitted.
      expect(entry.diffStat.insertions).toBeUndefined();
    });
  });
});

describe("createMainAdvanceApprovalGate build-status line", () => {
  it("renders the HOST-sourced build status in the advance prompt (never a build trigger)", async () => {
    const deps = gateDeps({ decision: "once" });
    const calls: string[] = [];
    const gate = createMainAdvanceApprovalGate({
      ...deps,
      getBuildStatusAt: async (viewHash) => {
        calls.push(viewHash);
        return { validated: true, failed: true };
      },
    });

    await gate.approve(
      candidate({ repoPath: "apps/shell", changedPaths: ["apps/shell/index.tsx"] })
    );

    expect(calls).toEqual(["state:next"]);
    const request = deps.approvalQueue.request.mock.calls[0]![0] as {
      details: Array<{ label: string; value: string }>;
    };
    expect(request.details).toContainEqual({ label: "Built", value: "failed" });
  });

  it("renders 'not validated' when no build status is recorded (absent dep)", async () => {
    const deps = gateDeps({ decision: "once" });
    const gate = createMainAdvanceApprovalGate(deps);
    await gate.approve(
      candidate({ repoPath: "apps/shell", changedPaths: ["apps/shell/index.tsx"] })
    );
    const request = deps.approvalQueue.request.mock.calls[0]![0] as {
      details: Array<{ label: string; value: string }>;
    };
    expect(request.details).toContainEqual({ label: "Built", value: "not validated" });
  });
});
