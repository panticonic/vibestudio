/**
 * Main-advance approval rides the PROTECTED-REF gate now: every `main` advance
 * is a RefService compare-and-swap whose injected gate runs the approval
 * machinery (docs/blob-addressed-cleanly.md step 6). These tests verify:
 *   - reads of a repo's main never block on a parked push approval (main reads
 *     resolve from the ref store, not the head locks);
 *   - the gate receives the CANDIDATE composed view (the workspace as it WOULD
 *     be after the push) plus the exact CAS pair being swapped;
 *   - the approval prompt's changed paths are SERVER-COMPUTED (content-store
 *     diffTrees over the CAS'd trees), never caller-supplied;
 *   - the meta repo still derives its semantic unit-change prompt, off the
 *     candidate composed view.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { attachLocalHostBridges, pushToMain } from "../../../src/server/vcsHost/testSupport.js";
import { createVerifiedCaller } from "@vibez1/shared/serviceDispatcher";
import type { UnitBatchEntry } from "@vibez1/shared/approvals";
import type { UnitMetaChangeApprovalProvider } from "@vibez1/unit-host";
import { GadWorkspaceDO } from "../../../workspace/workers/gad-store/index.js";
import { WorkspaceVcs } from "../../../src/server/vcsHost/workspaceVcs.js";
import { VCS_MAIN_HEAD, vcsContextHead } from "../../../src/server/vcsHost/paths.js";
import type { GadCaller } from "../../../src/server/vcsHost/testSupport.js";
import {
  createRefService,
  type RefGateBatch,
  type RefGate,
} from "../../../src/server/services/refService.js";
import {
  createMainAdvanceApprovalGate,
  createMainRefAdvanceGate,
  type MainAdvanceApprovalCandidate,
  type MetaApprovalGrantStore,
  type RefAdvanceGateContext,
} from "../../../src/server/services/mainAdvanceApproval.js";
import { CapabilityGrantStore } from "../../../src/server/services/capabilityGrantStore.js";
import type { ApprovalQueue } from "../../../src/server/services/approvalQueue.js";

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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not reached");
}

const USER = { id: "user", kind: "user" };
const AGENT = { id: "scribe", kind: "agent" };
const text = (value: string) => ({ kind: "text" as const, text: value });
const REPO = "packages/approval";

function panelCaller() {
  return createVerifiedCaller("panel-1", "panel", {
    callerId: "panel-1",
    callerKind: "panel",
    repoPath: "panels/test",
    effectiveVersion: "ev-panel",
  });
}

function callerAdvance(sourceHead: string): RefAdvanceGateContext {
  return { kind: "caller", caller: panelCaller(), sourceHead };
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

describe("WorkspaceVcs main approval (protected-ref gate)", () => {
  let root: string;
  let workspaceRoot: string;
  let vcs: WorkspaceVcs;
  let gad: TestGad;
  /** Swappable gate: allow-all by default; tests install parking/real gates. */
  let refGate: RefGate;
  let gateInputs: RefGateBatch[];

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "gadvcs-main-approval-"));
    workspaceRoot = path.join(root, "workspace");
    await fsp.mkdir(workspaceRoot);
    gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad" });
    // The in-process test DO has no RPC gateway; give computeMerge a local
    // content store over this test's blob dir (production uses blobstore.* RPC).
    refGate = async () => {};
    gateInputs = [];
    const refs = createRefService({
      statePath: path.join(root, "refs"),
      gate: async (input) => {
        gateInputs.push(input);
        await refGate(input);
      },
    });
    // In-process pushes flow through the DO's `vcsPush` → `refs.updateMains`.
    // Production attaches the caller gate context at the host RPC layer
    // (refsService.ts); supply the equivalent here so the approval gate runs on
    // every advance (mirrors a tokened, caller-driven push).
    attachLocalHostBridges(gad.instance, {
      blobsDir: path.join(root, "blobs"),
      refs,
      gateContext: () => callerAdvance(vcsContextHead("gated")),
    });
    vcs = new WorkspaceVcs({
      blobsDir: path.join(root, "blobs"),
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

  /** Seed a repo's `main` via the real flow (edit → commit → push on a throwaway
   *  context; system advance context — ungated), then drop the seeding context. */
  async function seedMain(
    repoPath: string,
    edits: Parameters<WorkspaceVcs["recordEdit"]>[0]["edits"]
  ): Promise<string> {
    const seedHead = vcsContextHead("__seed__");
    await vcs.recordEdit({ head: seedHead, repoPath, edits, actor: USER });
    await vcs.commit({ head: seedHead, repoPath, message: "seed", actor: USER });
    const pushed = await pushToMain(gad, {
      repoPaths: [repoPath],
      sourceHead: seedHead,
      actor: USER,
    });
    expect(pushed.status).toBe("pushed");
    await vcs.dropContext("__seed__");
    const main = await vcs.resolveHead(VCS_MAIN_HEAD, repoPath);
    if (!main) throw new Error("seedMain: main not created");
    return main;
  }

  it("does not block main reads while a push approval is parked on the ref", async () => {
    await seedMain(REPO, [{ kind: "create", path: "base.txt", content: text("base\n") }]);
    const ctxHead = vcsContextHead("ctx-approve");
    await vcs.recordEdit({
      head: ctxHead,
      repoPath: REPO,
      actor: AGENT,
      edits: [{ kind: "create", path: "ctx.txt", content: text("ctx\n") }],
    });
    await vcs.commit({ head: ctxHead, repoPath: REPO, message: "ctx edit", actor: AGENT });

    let approvalStarted = false;
    let releaseApproval!: () => void;
    const approval = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });
    // Park ONLY caller-context advances (the pushed candidate); system
    // advances (scans/seeds) stay instant.
    refGate = async (input) => {
      if ((input.gateContext as RefAdvanceGateContext | undefined)?.kind === "caller") {
        approvalStarted = true;
        await approval;
      }
    };

    const pushed = pushToMain(gad, {
      repoPaths: [REPO],
      sourceHead: ctxHead,
      actor: AGENT,
    });

    await waitFor(() => approvalStarted);

    // While the approval is parked, a read of the same repo's main must NOT
    // block — main reads resolve from the protected-ref store, lock-free.
    const readDuringApproval = await Promise.race([
      vcs.resolveHead(VCS_MAIN_HEAD, REPO),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 250)),
    ]);
    expect(readDuringApproval).not.toBe("blocked");

    releaseApproval();
    const result = await pushed;
    expect(result.status).toBe("pushed");

    const files = await vcs.listFiles(VCS_MAIN_HEAD, REPO);
    expect(files.map((file) => file.path).sort()).toEqual(["base.txt", "ctx.txt"]);
  });

  it("the gate receives the CAS pair and the CANDIDATE composed view", async () => {
    const base = await seedMain(REPO, [
      { kind: "create", path: "config.txt", content: text("v1\n") },
    ]);

    const ctxHead = vcsContextHead("ctx-candidate");
    await vcs.recordEdit({
      head: ctxHead,
      repoPath: REPO,
      actor: AGENT,
      edits: [{ kind: "write", path: "config.txt", content: text("v2\n") }],
    });
    await vcs.commit({ head: ctxHead, repoPath: REPO, message: "bump config", actor: AGENT });
    const ctxState = await vcs.resolveHead(ctxHead, REPO);

    // Install the real gate to observe the candidate it composes. Narrow-host
    // P3: the caller context no longer carries a pre-computed
    // candidateWorkspaceState (the host push that stuffed it is gone) — the gate
    // now composes the candidate view itself from `current mains ⊕ entries`.
    const approvals: MainAdvanceApprovalCandidate[] = [];
    refGate = createMainRefAdvanceGate({
      blobsDir: path.join(root, "blobs"),
      approvalGate: {
        approve: async (candidate) => {
          approvals.push(candidate);
        },
        approveRepoDeletion: async () => {},
      },
      ensureStateMirrored: (stateHash) => vcs.worktrees.ensureStateMirrored(stateHash),
      workspaceViewWithReposAt: (overrides) => vcs.workspaceViewWithReposAt(overrides),
    });

    gateInputs.length = 0;
    const pushed = await pushToMain(gad, {
      repoPaths: [REPO],
      sourceHead: ctxHead,
      actor: AGENT,
    });
    expect(pushed.status).toBe("pushed");

    // The CAS pair the gate swaps is exactly "what main was built against" →
    // "the ctx tip" (raw batch entries, server-supplied).
    const advanceBatch = gateInputs.find((b) => b.entries.some((e) => e.repoPath === REPO));
    expect(advanceBatch).toBeTruthy();
    const advance = advanceBatch!.entries.find((e) => e.repoPath === REPO)!;
    expect(advance.old).toBe(base);
    expect(advance.next).toBe(ctxState);

    // The gate composed the CANDIDATE workspace view — the workspace as it WOULD
    // be after the push (config.txt = v2), not the still-current pre-advance view.
    expect(approvals).toHaveLength(1);
    const candidateFile = await vcs.readFile(approvals[0]!.stateHash, `${REPO}/config.txt`);
    expect(candidateFile?.content).toMatchObject({ kind: "text", text: "v2\n" });
  });

  it("the approval prompt's changed paths are SERVER-COMPUTED from the content-store diff", async () => {
    await seedMain(REPO, [
      { kind: "create", path: "config.txt", content: text("v1\n") },
      { kind: "create", path: "stay.txt", content: text("untouched\n") },
    ]);

    const approvals: MainAdvanceApprovalCandidate[] = [];
    refGate = createMainRefAdvanceGate({
      blobsDir: path.join(root, "blobs"),
      approvalGate: {
        approve: async (candidate) => {
          approvals.push(candidate);
        },
        approveRepoDeletion: async () => {},
      },
      ensureStateMirrored: (stateHash) => vcs.worktrees.ensureStateMirrored(stateHash),
      workspaceViewWithReposAt: (overrides) => vcs.workspaceViewWithReposAt(overrides),
    });

    const ctxHead = vcsContextHead("ctx-diff");
    await vcs.recordEdit({
      head: ctxHead,
      repoPath: REPO,
      actor: AGENT,
      edits: [
        { kind: "write", path: "config.txt", content: text("v2\n") },
        { kind: "create", path: "new.txt", content: text("brand new\n") },
      ],
    });
    await vcs.commit({ head: ctxHead, repoPath: REPO, message: "two changes", actor: AGENT });

    const pushed = await pushToMain(gad, {
      repoPaths: [REPO],
      sourceHead: ctxHead,
      actor: AGENT,
    });
    expect(pushed.status).toBe("pushed");

    expect(approvals).toHaveLength(1);
    const candidate = approvals[0]!;
    expect(candidate.repoPath).toBe(REPO);
    // Exactly the two files the trees differ by — workspace-rooted, computed
    // by the server's diffTrees (stay.txt untouched, so absent).
    expect([...candidate.changedPaths].sort()).toEqual([`${REPO}/config.txt`, `${REPO}/new.txt`]);
    // The candidate stateHash is the shared group candidate view.
    const file = await vcs.readFile(candidate.stateHash, `${REPO}/new.txt`);
    expect(file?.content).toMatchObject({ kind: "text", text: "brand new\n" });
  });

  it("the meta repo still derives its semantic unit-change prompt from the candidate view", async () => {
    await seedMain("meta", [{ kind: "create", path: "vibez1.yml", content: text("name: test\n") }]);

    const provider: UnitMetaChangeApprovalProvider<UnitBatchEntry> = {
      metaChangeApprovalForCommit: vi.fn(async () => ({
        units: [
          {
            unitKind: "extension",
            unitName: "@workspace-extensions/tools",
            displayName: "Tools",
            version: "1.0.0",
            source: { kind: "workspace-repo", repo: "extensions/tools", ref: "main" },
            capabilities: [],
          } satisfies UnitBatchEntry,
        ],
        identityKeys: ["identity:unit"],
      })),
      acceptPreapprovedTrust: vi.fn(),
    };
    const approvalQueue = {
      request: vi.fn(async () => "once" as const),
    } as unknown as ApprovalQueue & { request: ReturnType<typeof vi.fn> };
    const approvalGate = createMainAdvanceApprovalGate({
      approvalQueue,
      grantStore: new MemoryGrantStore(),
      grantTtlMs: 1000,
      capabilityGrantStore: new CapabilityGrantStore({ statePath: path.join(root, "grants") }),
      getProviders: () => [provider],
    });
    refGate = createMainRefAdvanceGate({
      blobsDir: path.join(root, "blobs"),
      approvalGate,
      ensureStateMirrored: (stateHash) => vcs.worktrees.ensureStateMirrored(stateHash),
      workspaceViewWithReposAt: (overrides) => vcs.workspaceViewWithReposAt(overrides),
    });

    const ctxHead = vcsContextHead("ctx-meta");
    await vcs.recordEdit({
      head: ctxHead,
      repoPath: "meta",
      actor: AGENT,
      edits: [{ kind: "write", path: "vibez1.yml", content: text("name: test-v2\n") }],
    });
    await vcs.commit({ head: ctxHead, repoPath: "meta", message: "config change", actor: AGENT });

    const pushed = await pushToMain(gad, {
      repoPaths: ["meta"],
      sourceHead: ctxHead,
      actor: AGENT,
    });
    expect(pushed.status).toBe("pushed");

    // The provider derived the unit changes from the CANDIDATE composed view:
    // the state it was handed resolves meta/vibez1.yml to the NEW content.
    expect(provider.metaChangeApprovalForCommit).toHaveBeenCalledTimes(1);
    const commitState = (provider.metaChangeApprovalForCommit as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    const configAtCandidate = await vcs.readFile(commitState, "meta/vibez1.yml");
    expect(configAtCandidate?.content).toMatchObject({ kind: "text", text: "name: test-v2\n" });

    // ... and the user prompt was the semantic unit-batch, with the
    // server-computed meta path summary.
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-batch",
        trigger: "meta-change",
        configWrite: {
          repoPath: "meta",
          summary: "meta/vibez1.yml changed",
        },
      })
    );
    expect(provider.acceptPreapprovedTrust).toHaveBeenCalledWith(["identity:unit"]);
  });
});
