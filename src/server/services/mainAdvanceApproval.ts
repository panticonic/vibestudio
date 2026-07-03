import * as fs from "node:fs";
import * as path from "node:path";
import { unitChangeSessionGrantKey, type UnitMetaChangeApprovalProvider } from "@vibez1/unit-host";
import type { DiffReviewEntry, DiffReviewFile, UnitBatchEntry } from "@vibez1/shared/approvals";
import type { VerifiedCaller } from "@vibez1/shared/serviceDispatcher";
import type { AppCapability } from "@vibez1/shared/unitManifest";
import { EMPTY_STATE_HASH } from "@vibez1/shared/contentTree/worktreeHash";
import { countLines, countLineDiff } from "@vibez1/shared/lineDiff";
import { blobPath, diffTrees, getBytes, statBlob } from "./blobstoreService.js";
import { joinRepoPrefix } from "../vcsHost/paths.js";
import type { ApprovalQueue } from "./approvalQueue.js";
import { requestCapabilityPermission } from "./capabilityPermission.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { isAuthorizedChrome } from "./chromeTrust.js";
import type { RefGate, RefGateBatch, RefGateBatchEntry } from "./refService.js";

const WORKSPACE_REPO_WRITE_CAPABILITY = "workspace-repo-write";
// Deliberately DISTINCT from the write capability: a generic
// `workspace-repo-write` session/repo grant must NEVER silently authorize a
// destructive whole-repo deletion. The per-repo resource key (below) further
// ensures approving the deletion of one repo never covers another.
const WORKSPACE_REPO_DELETE_CAPABILITY = "workspace-repo-delete";
// Recovering a deleted repo re-adds it to workspace main — a global-state change,
// so it is gated too, but as a standard (recovery) action rather than severe.
const WORKSPACE_REPO_RESTORE_CAPABILITY = "workspace-repo-restore";

/** The operations that advance a repo's protected `main` ref. */
export type MainAdvanceOperation = "push" | "merge";

/**
 * A candidate protected-ref (`repo` → main) advance awaiting approval. The
 * `changedPaths` are SERVER-COMPUTED (content-store `diffTrees` between the
 * ref's current and candidate trees, re-rooted workspace-relative) — never
 * caller-supplied (see {@link createMainRefAdvanceGate}).
 */
export interface MainAdvanceApprovalCandidate {
  caller: VerifiedCaller;
  operation: MainAdvanceOperation;
  /** The repo whose `main` ref is advancing. */
  repoPath: string;
  /** Server-computed changed paths, workspace-rooted. */
  changedPaths: string[];
  /** The composed workspace view AT THE CANDIDATE (the workspace as it would
   *  be after this advance) — meta unit derivation + approval dedup keys. A
   *  group push shares ONE candidate view across its repos, so the whole group
   *  coalesces into one prompt/grant. */
  stateHash: string;
  sourceHead?: string;
  /** Display-only "requested by X via Y" attribution: the DO identity a
   *  caller-driven advance was dispatched through (§4). The AUTHORITATIVE
   *  principal is `caller` (host-resolved); `via` is prompt copy only. */
  via?: string;
  /** Host-sourced build-status line for the candidate view ("ok" / "failed" /
   *  "not validated"), computed by the approval gate — never caller-supplied. */
  buildStatusLine?: string;
  /** Host-computed diff-review payload for the whole batch (§5.1), surfaced on
   *  the approval so the reviewer sees the full server-side diff. */
  diffReview?: DiffReviewEntry[];
}

/**
 * Per-batch context the VCS layer attaches to `updateMains` calls
 * (`UpdateMainsInput.gateContext`). `system` marks server-internal advances —
 * workspace scans adopting the user's own on-disk edits, bootstrap seeding,
 * fork/restore adoption — which are not approval-gated (exactly the paths that
 * ran ungated before refs existed). Every caller-driven advance carries the
 * verified caller for the approval machinery.
 */
export type RefAdvanceGateContext =
  | { kind: "system"; actor?: { id: string; kind: string } }
  | {
      kind: "caller";
      caller: VerifiedCaller;
      operation: MainAdvanceOperation;
      sourceHead?: string;
      /** DO identity the write was dispatched through, for "requested by X via
       *  Y" prompt copy (§4). Never authoritative. */
      via?: string;
      /** Composed candidate workspace view (a caller-driven advance passes its
       *  shared candidate view so one approval covers the whole batch). When
       *  absent the gate composes one itself from the batch entries. */
      candidateWorkspaceState?: string;
    };

/**
 * The RefService gate for protected `main` refs — THE single approval path for
 * every main advance (step 6 of docs/blob-addressed-cleanly.md). It computes
 * the AUTHORITATIVE diff itself from the CAS'd trees (`expectedOld` → `next`)
 * via the content store; callers may propose summaries, but the prompt's
 * changed paths always come from this server-side diff.
 */
export function createMainRefAdvanceGate(deps: {
  blobsDir: string;
  approvalGate: Pick<
    MainAdvanceApprovalGate,
    "approve" | "approveRepoDeletion" | "approveRepoRestore"
  >;
  /** Lazy mirroring hook (WorktreeStore.ensureStateMirrored) so historical states
   *  minted inside the store resolve to full trees before diffing. */
  ensureStateMirrored(stateHash: string): Promise<void>;
  /** Compose the candidate workspace view with a batch of repo overrides
   *  (`stateHash: null` removes the repo). Generalizes the single-repo
   *  `workspaceViewWithRepoAt`. */
  workspaceViewWithReposAt(
    overrides: Array<{ repoPath: string; stateHash: string | null }>
  ): Promise<string>;
  /** Host-computed dependents of a repo being DELETED (repos whose build unit
   *  imports it), for the severe deletion prompt's dependents warning (§5) —
   *  derived from the build dependency graph at the live workspace view. Absent
   *  ⇒ no dependents surfaced. */
  computeDeleteDependents?(repoPath: string): Promise<string[]>;
}): RefGate {
  return async (batch: RefGateBatch): Promise<void> => {
    const context = batch.gateContext as RefAdvanceGateContext | undefined;
    if (!context || (context.kind !== "system" && context.kind !== "caller")) {
      // Fail CLOSED: a protected-main update without an explicit advance
      // context is a programming error, never an implicit allow.
      throw new Error(`Protected main update carries no gate context`);
    }
    if (context.kind === "system") return;

    // ONE candidate workspace view for the whole batch: current mains ⊕ entries
    // (deletes remove the repo). The shared view hash is the dedup key that
    // coalesces a multi-repo batch into one prompt, exactly as group push does.
    const candidateView =
      context.candidateWorkspaceState ??
      (await deps.workspaceViewWithReposAt(
        batch.entries.map((entry) => ({ repoPath: entry.repoPath, stateHash: entry.next }))
      ));

    // Build the whole-batch diff-review payload ONCE (one entry per batch entry,
    // §5.1). Every prompt in the batch carries the FULL payload so the reviewer
    // always sees the complete host-computed diff. Also yields the exact
    // workspace-rooted changed paths + file count per entry, reused below (so a
    // main advance never diffs its trees twice).
    const perEntry: Array<{
      entry: RefGateBatchEntry;
      review: DiffReviewEntry;
      changedPaths: string[];
    }> = [];
    for (const entry of batch.entries) {
      perEntry.push({ entry, ...(await buildDiffReviewEntry(deps, entry)) });
    }
    const diffReview = perEntry.map((e) => e.review);

    for (const { entry, review, changedPaths } of perEntry) {
      // Classification is DERIVED from the host's own state + ref log — the
      // caller's claimed `operation` never loosens it (fail closed to the
      // stricter prompt).
      if (entry.next === null) {
        // Delete → severe per-repo deletion capability, inside the batch. The
        // dependents warning (repos whose build breaks) is host-computed from
        // the build dependency graph, exactly like the file count is from the
        // CAS diff (§5) — never caller-supplied.
        const dependents = deps.computeDeleteDependents
          ? await deps.computeDeleteDependents(entry.repoPath).catch(() => [])
          : [];
        await deps.approvalGate.approveRepoDeletion({
          caller: context.caller,
          repoPath: entry.repoPath,
          fileCount: review.diffStat.filesChanged,
          stateHash: entry.old ?? EMPTY_STATE_HASH,
          dependents,
          diffReview,
        });
        continue;
      }
      if (entry.old === null && entry.priorDeleted) {
        // Re-creation of a previously deleted repo (host ref log shows the
        // prior delete) → restore capability.
        await deps.approvalGate.approveRepoRestore({
          caller: context.caller,
          repoPath: entry.repoPath,
          fileCount: review.diffStat.filesChanged,
          stateHash: entry.next,
          diffReview,
        });
        continue;
      }

      // Ordinary advance: changed paths are the server-computed tree delta,
      // re-rooted to the repo (never anything the caller proposed).
      await deps.approvalGate.approve({
        caller: context.caller,
        operation: context.operation,
        repoPath: entry.repoPath,
        changedPaths,
        stateHash: candidateView,
        diffReview,
        ...(context.sourceHead ? { sourceHead: context.sourceHead } : {}),
        ...(context.via ? { via: context.via } : {}),
      });
    }
  };
}

// Host-side diff-review payload construction (narrow-host-vcs-plan §5.1).
const BINARY_SNIFF_BYTES = 8 * 1024;
/** A file over 1 MiB (either side) renders diffstat-only in the viewer. */
const TOO_LARGE_BYTES = 1024 * 1024;
/** Real line counts are computed only when BOTH sides are ≤ 256 KiB. */
const LINE_COUNT_MAX_BYTES = 256 * 1024;
/** Cap the per-entry file list; `filesChanged` stays exact when truncated. */
const MAX_CHANGED_FILES = 500;

interface DiffReviewDeps {
  blobsDir: string;
  ensureStateMirrored(stateHash: string): Promise<void>;
}

/**
 * Build one {@link DiffReviewEntry} for a batch entry from the CAS'd trees, plus
 * the entry's workspace-rooted changed paths. A delete (`next: null`) diffs
 * old → empty (all files `removed`); a restore (`old: null`) diffs empty → next
 * (all `added`); an advance diffs old → next.
 *
 * Line totals (`insertions`/`deletions`) are computed per text file where both
 * sides are ≤ 256 KiB and summed — but the WHOLE entry's totals are omitted the
 * moment any file is skipped (binary, oversized, unreadable, too line-dense, or
 * beyond the file-list cap), so totals are always accurate or absent, never
 * partial. `filesChanged` is always exact; the file list is capped at
 * {@link MAX_CHANGED_FILES} with `truncated: true` past the cap.
 */
async function buildDiffReviewEntry(
  deps: DiffReviewDeps,
  entry: RefGateBatchEntry
): Promise<{ review: DiffReviewEntry; changedPaths: string[] }> {
  const fromRef = entry.old ?? EMPTY_STATE_HASH;
  const toRef = entry.next ?? EMPTY_STATE_HASH;
  await deps.ensureStateMirrored(fromRef);
  await deps.ensureStateMirrored(toRef);
  const diff = await diffTrees(deps.blobsDir, fromRef, toRef);

  const raw: Array<{
    path: string;
    kind: DiffReviewFile["kind"];
    oldHash?: string;
    newHash?: string;
  }> = [
    ...diff.added.map((f) => ({ path: f.path, kind: "added" as const, newHash: f.contentHash })),
    ...diff.removed.map((f) => ({
      path: f.path,
      kind: "removed" as const,
      oldHash: f.contentHash,
    })),
    ...diff.changed.map((f) => ({
      path: f.path,
      kind: "changed" as const,
      oldHash: f.fromContentHash,
      newHash: f.toContentHash,
    })),
  ];
  raw.sort((a, b) => a.path.localeCompare(b.path));

  const changedPaths = raw.map((f) => joinRepoPrefix(entry.repoPath, f.path));
  const filesChanged = raw.length;
  const truncated = raw.length > MAX_CHANGED_FILES;
  const included = truncated ? raw.slice(0, MAX_CHANGED_FILES) : raw;

  const changedFiles: DiffReviewFile[] = [];
  let insertions = 0;
  let deletions = 0;
  // A truncated list can never carry accurate whole-entry totals: forfeit them
  // up front while still emitting every listed file's flags below.
  let omitLineTotals = truncated;

  for (const f of included) {
    const oldInfo = f.oldHash ? await classifyBlob(deps.blobsDir, f.oldHash) : null;
    const newInfo = f.newHash ? await classifyBlob(deps.blobsDir, f.newHash) : null;
    const binary = Boolean(oldInfo?.binary || newInfo?.binary);
    const tooLarge =
      (oldInfo?.size ?? 0) > TOO_LARGE_BYTES || (newInfo?.size ?? 0) > TOO_LARGE_BYTES;

    const file: DiffReviewFile = { path: f.path, kind: f.kind };
    if (f.oldHash) file.oldHash = f.oldHash;
    if (f.newHash) file.newHash = f.newHash;
    if (binary) file.binary = true;
    if (tooLarge) file.tooLarge = true;
    changedFiles.push(file);

    if (omitLineTotals) continue; // totals already forfeited; flags still emitted

    const missing = Boolean((f.oldHash && !oldInfo) || (f.newHash && !newInfo));
    const countable =
      !binary &&
      !missing &&
      (oldInfo?.size ?? 0) <= LINE_COUNT_MAX_BYTES &&
      (newInfo?.size ?? 0) <= LINE_COUNT_MAX_BYTES;
    if (!countable) {
      omitLineTotals = true;
      continue;
    }

    const oldText = f.oldHash ? await readBlobText(deps.blobsDir, f.oldHash) : "";
    const newText = f.newHash ? await readBlobText(deps.blobsDir, f.newHash) : "";
    if (oldText === null || newText === null) {
      omitLineTotals = true;
      continue;
    }
    if (f.kind === "added") {
      insertions += countLines(newText);
    } else if (f.kind === "removed") {
      deletions += countLines(oldText);
    } else {
      const counts = countLineDiff(oldText, newText);
      if (!counts) {
        omitLineTotals = true;
        continue;
      }
      insertions += counts.insertions;
      deletions += counts.deletions;
    }
  }

  const review: DiffReviewEntry = {
    repoPath: entry.repoPath,
    oldState: fromRef,
    newState: entry.next,
    diffStat: omitLineTotals ? { filesChanged } : { filesChanged, insertions, deletions },
    changedFiles,
    ...(truncated ? { truncated: true } : {}),
  };
  return { review, changedPaths };
}

/** Size + binary classification of a CAS blob; null when the blob is absent. */
async function classifyBlob(
  blobsDir: string,
  digest: string
): Promise<{ size: number; binary: boolean } | null> {
  const stat = await statBlob(blobsDir, digest);
  if (!stat) return null;
  const head = await readBlobHead(blobsDir, digest, BINARY_SNIFF_BYTES);
  return { size: stat.size, binary: head ? hasNullByte(head) : false };
}

/** Read up to `maxBytes` from a CAS blob's head (binary sniff) without loading
 *  the whole file. Null when absent. */
async function readBlobHead(
  blobsDir: string,
  digest: string,
  maxBytes: number
): Promise<Buffer | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(blobPath(blobsDir, digest), "r");
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buf = Buffer.alloc(length);
    if (length > 0) await handle.read(buf, 0, length, 0);
    return buf;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function readBlobText(blobsDir: string, digest: string): Promise<string | null> {
  const bytes = await getBytes(blobsDir, digest);
  return bytes ? bytes.toString("utf8") : null;
}

/** Git-style binary sniff: a NUL byte in the sampled head marks a blob binary. */
function hasNullByte(bytes: Buffer): boolean {
  return bytes.includes(0);
}

/** A pending whole-repo deletion awaiting the user's explicit, severe approval. */
export interface RepoDeletionApprovalCandidate {
  caller: VerifiedCaller;
  repoPath: string;
  /** How many tracked files the deletion will remove (for the prompt). */
  fileCount: number;
  /** The `main` state being archived (shown + used to scope the request). */
  stateHash: string;
  /** Live repos that depend on this one (force-delete) — surfaced so the user
   *  sees what will break. Empty for a clean deletion. */
  dependents?: string[];
  /** Host-computed diff-review payload for the whole batch (§5.1). */
  diffReview?: DiffReviewEntry[];
}

/** A pending whole-repo restore awaiting the user's approval. */
export interface RepoRestoreApprovalCandidate {
  caller: VerifiedCaller;
  repoPath: string;
  /** How many tracked files the restore will re-add (for the prompt). */
  fileCount: number;
  /** The archived `main` state being restored. */
  stateHash: string;
  /** Host-computed diff-review payload for the whole batch (§5.1). */
  diffReview?: DiffReviewEntry[];
}

export interface MainAdvanceApprovalGate {
  approve(candidate: MainAdvanceApprovalCandidate): Promise<void>;
  /** Gate a severe, global-state whole-repo deletion. Throws if denied. */
  approveRepoDeletion(candidate: RepoDeletionApprovalCandidate): Promise<void>;
  /** Gate a whole-repo restore (re-adds a deleted repo to main). Throws if denied. */
  approveRepoRestore(candidate: RepoRestoreApprovalCandidate): Promise<void>;
}

export interface MetaApprovalGrantStore {
  hasActive(key: string): boolean;
  grant(key: string, ttlMs: number): void;
}

export class FileMetaApprovalGrantStore implements MetaApprovalGrantStore {
  private readonly filePath: string;
  private grants = new Map<string, number>();

  constructor(opts: { statePath: string }) {
    this.filePath = path.join(opts.statePath, "units", "meta-approval-grants.json");
    this.load();
  }

  hasActive(key: string, now = Date.now()): boolean {
    const expiresAt = this.grants.get(key);
    if (!expiresAt) return false;
    if (expiresAt > now) return true;
    this.grants.delete(key);
    this.save();
    return false;
  }

  grant(key: string, ttlMs: number): void {
    this.grants.set(key, Date.now() + ttlMs);
    this.save();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as {
        grants?: Array<{ key: string; expiresAt: number }>;
      };
      this.grants = new Map(
        (Array.isArray(parsed.grants) ? parsed.grants : [])
          .filter((grant) => typeof grant.key === "string" && typeof grant.expiresAt === "number")
          .map((grant) => [grant.key, grant.expiresAt])
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[MainAdvanceApproval] Failed to load meta approval grants:", err);
      }
      this.grants = new Map();
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(
      tmp,
      `${JSON.stringify(
        {
          grants: [...this.grants.entries()].map(([key, expiresAt]) => ({ key, expiresAt })),
        },
        null,
        2
      )}\n`
    );
    fs.renameSync(tmp, this.filePath);
  }
}

export function createMainAdvanceApprovalGate(deps: {
  approvalQueue: ApprovalQueue;
  grantStore: MetaApprovalGrantStore;
  grantTtlMs: number;
  capabilityGrantStore: CapabilityGrantStore;
  hasAppCapability?: (callerId: string, capability: AppCapability) => boolean;
  getProviders(): Array<UnitMetaChangeApprovalProvider<UnitBatchEntry> | null | undefined>;
  /**
   * Host-sourced build-status read over the candidate view (§2.2 `build.statusAt`):
   * a PURE cache lookup over the host's own recorded per-unit builds — it MUST
   * NEVER trigger a build. Returns `null` (or is absent) when nothing is
   * recorded for the view, which the prompt renders as "not validated". The
   * build side is implemented in parallel (P2); the gate only defines and
   * consumes this interface.
   */
  getBuildStatusAt?: (viewHash: string) => Promise<{ validated: boolean; failed?: boolean }> | null;
}): MainAdvanceApprovalGate {
  return {
    async approve(candidate) {
      if (candidate.changedPaths.length === 0) return;
      const buildStatusLine = await resolveBuildStatusLine(
        deps.getBuildStatusAt,
        candidate.stateHash
      );
      candidate = { ...candidate, buildStatusLine };
      const metaChanged = candidate.changedPaths.some(isMetaPath);

      const runtimeKind = candidate.caller.runtime.kind;
      if (isAuthorizedChrome(candidate.caller, { hasAppCapability: deps.hasAppCapability })) {
        return;
      }

      const callerKind = userlandCallerKind(runtimeKind);
      if (!callerKind) {
        throw new Error(`Workspace main advances from ${runtimeKind} callers are not supported`);
      }

      const identity = candidate.caller.code;
      if (!identity || identity.callerKind !== runtimeKind) {
        throw new Error(`Unknown caller identity: ${candidate.caller.runtime.id}`);
      }

      if (!metaChanged) {
        await approveWorkspaceMainAdvance(deps, candidate);
        return;
      }

      const providers = deps
        .getProviders()
        .filter(
          (provider): provider is UnitMetaChangeApprovalProvider<UnitBatchEntry> =>
            provider !== null && provider !== undefined
        );
      const approvals = await Promise.all(
        providers.map(async (provider) => ({
          provider,
          approval: await provider.metaChangeApprovalForCommit(candidate.stateHash),
        }))
      );
      const units = approvals.flatMap(({ approval }) => approval.units);
      const identityKeys = approvals.flatMap(({ approval }) => approval.identityKeys);

      const grantKey = unitChangeSessionGrantKey(
        candidate.caller.runtime.id,
        "meta",
        "meta",
        "main"
      );
      const onlyMetaChanged = candidate.changedPaths.every(isMetaPath);
      if (deps.grantStore.hasActive(grantKey) && units.length === 0 && onlyMetaChanged) return;

      if (
        onlyMetaChanged &&
        units.length > 0 &&
        identityKeys.length > 0 &&
        identityKeys.every((key) => deps.grantStore.hasActive(metaIdentityGrantKey(key)))
      ) {
        for (const { provider, approval } of approvals) {
          provider.acceptPreapprovedTrust(approval.identityKeys);
        }
        return;
      }

      const decision = await deps.approvalQueue.request({
        kind: "unit-batch",
        callerId: candidate.caller.runtime.id,
        callerKind,
        repoPath: identity.repoPath,
        effectiveVersion: identity.effectiveVersion,
        dedupKey: `unit-meta-change:${candidate.caller.runtime.id}:${candidate.stateHash}`,
        trigger: "meta-change",
        title: metaChangeTitle(units),
        description: metaChangeDescription(units),
        units,
        configWrite: {
          repoPath: "meta",
          summary: metaChangeSummary(candidate),
        },
        ...(candidate.diffReview ? { diffReview: candidate.diffReview } : {}),
      });
      if (decision === "deny") {
        throw new Error("Workspace config push denied");
      }
      for (const { provider, approval } of approvals) {
        provider.acceptPreapprovedTrust(approval.identityKeys);
      }
      for (const key of identityKeys) {
        deps.grantStore.grant(metaIdentityGrantKey(key), deps.grantTtlMs);
      }
      if (decision === "session") {
        deps.grantStore.grant(grantKey, deps.grantTtlMs);
      }
    },

    async approveRepoDeletion(candidate) {
      // The shell acts on the user's behalf (it carries its own confirm UX), so
      // chrome callers pass — same trust model as `approve`. Every other caller
      // (agents, panels, workers) must get explicit user approval.
      if (isAuthorizedChrome(candidate.caller, { hasAppCapability: deps.hasAppCapability })) {
        return;
      }
      const callerKind = userlandCallerKind(candidate.caller.runtime.kind);
      if (!callerKind) {
        throw new Error(
          `Repo deletion from ${candidate.caller.runtime.kind} callers is not supported`
        );
      }
      const identity = candidate.caller.code;
      if (!identity || identity.callerKind !== candidate.caller.runtime.kind) {
        throw new Error(`Unknown caller identity: ${candidate.caller.runtime.id}`);
      }
      const fileSummary = `${candidate.fileCount} file${candidate.fileCount === 1 ? "" : "s"}`;
      const dependents = candidate.dependents ?? [];
      const dependentWarning =
        dependents.length > 0
          ? ` WARNING: ${dependents.length} repo(s) depend on it and will likely fail to build: ${dependents.join(", ")}.`
          : "";
      const authorization = await requestCapabilityPermission(
        {
          approvalQueue: deps.approvalQueue,
          grantStore: deps.capabilityGrantStore,
        },
        {
          caller: candidate.caller,
          capability: WORKSPACE_REPO_DELETE_CAPABILITY,
          severity: "severe",
          // Per-repo resource key: a grant only ever covers THIS repo, and the
          // state-scoped dedupKey keeps each distinct deletion its own prompt.
          dedupKey: `workspace-repo-delete:${candidate.repoPath}:${candidate.stateHash}`,
          resource: {
            type: "vcs-repo",
            label: "Repo",
            value: candidate.repoPath,
            key: `workspace-repo-delete:${candidate.repoPath}`,
          },
          operation: {
            kind: "workspace",
            verb: "delete repo (archives history)",
            object: { type: "vcs-repo", label: "Repo", value: candidate.repoPath },
            groupKey: `workspace-repo-delete:${candidate.repoPath}`,
          },
          title: `Delete repo ${candidate.repoPath}`,
          description:
            `Permanently remove ${candidate.repoPath} (${fileSummary}) from the workspace. ` +
            `Its history is archived (recoverable), but it is dropped from the workspace's ` +
            `main state and its working tree is deleted.${dependentWarning}`,
          details: [
            { label: "Repo", value: candidate.repoPath },
            { label: "Files removed", value: String(candidate.fileCount) },
            ...(dependents.length > 0
              ? [{ label: "Dependents at risk", value: dependents.join(", ") }]
              : []),
            { label: "Archived state", value: candidate.stateHash },
          ],
          ...(candidate.diffReview ? { diffReview: candidate.diffReview } : {}),
          deniedReason: `Deletion of ${candidate.repoPath} denied`,
        }
      );
      if (!authorization.allowed) {
        throw new Error(authorization.reason ?? `Deletion of ${candidate.repoPath} denied`);
      }
    },

    async approveRepoRestore(candidate) {
      if (isAuthorizedChrome(candidate.caller, { hasAppCapability: deps.hasAppCapability })) {
        return;
      }
      const callerKind = userlandCallerKind(candidate.caller.runtime.kind);
      if (!callerKind) {
        throw new Error(
          `Repo restore from ${candidate.caller.runtime.kind} callers is not supported`
        );
      }
      const identity = candidate.caller.code;
      if (!identity || identity.callerKind !== candidate.caller.runtime.kind) {
        throw new Error(`Unknown caller identity: ${candidate.caller.runtime.id}`);
      }
      const fileSummary = `${candidate.fileCount} file${candidate.fileCount === 1 ? "" : "s"}`;
      const authorization = await requestCapabilityPermission(
        {
          approvalQueue: deps.approvalQueue,
          grantStore: deps.capabilityGrantStore,
        },
        {
          caller: candidate.caller,
          capability: WORKSPACE_REPO_RESTORE_CAPABILITY,
          dedupKey: `workspace-repo-restore:${candidate.repoPath}:${candidate.stateHash}`,
          resource: {
            type: "vcs-repo",
            label: "Repo",
            value: candidate.repoPath,
            key: `workspace-repo-restore:${candidate.repoPath}`,
          },
          operation: {
            kind: "workspace",
            verb: "restore deleted repo",
            object: { type: "vcs-repo", label: "Repo", value: candidate.repoPath },
            groupKey: `workspace-repo-restore:${candidate.repoPath}`,
          },
          title: `Restore repo ${candidate.repoPath}`,
          description: `Re-add ${candidate.repoPath} (${fileSummary}) to the workspace from its archived history.`,
          details: [
            { label: "Repo", value: candidate.repoPath },
            { label: "Files restored", value: String(candidate.fileCount) },
            { label: "Archived state", value: candidate.stateHash },
          ],
          ...(candidate.diffReview ? { diffReview: candidate.diffReview } : {}),
          deniedReason: `Restore of ${candidate.repoPath} denied`,
        }
      );
      if (!authorization.allowed) {
        throw new Error(authorization.reason ?? `Restore of ${candidate.repoPath} denied`);
      }
    },
  };
}

async function approveWorkspaceMainAdvance(
  deps: {
    approvalQueue: ApprovalQueue;
    capabilityGrantStore: CapabilityGrantStore;
  },
  candidate: MainAdvanceApprovalCandidate
): Promise<void> {
  const authorization = await requestCapabilityPermission(
    {
      approvalQueue: deps.approvalQueue,
      grantStore: deps.capabilityGrantStore,
    },
    {
      caller: candidate.caller,
      capability: WORKSPACE_REPO_WRITE_CAPABILITY,
      dedupKey: `workspace-source-change:main:${candidate.stateHash}`,
      resource: {
        type: "vcs-head",
        label: "Head",
        value: "workspace main",
        key: "workspace-source-change:main",
      },
      operation: {
        kind: "workspace",
        verb: operationLabel(candidate.operation),
        object: {
          type: "vcs-head",
          label: "Head",
          value: "workspace main",
        },
        groupKey: `workspace-source-change:main:${candidate.stateHash}`,
      },
      title: mainAdvanceTitle(candidate),
      description: mainAdvanceDescription(candidate),
      details: mainAdvanceDetails(candidate),
      ...(candidate.diffReview ? { diffReview: candidate.diffReview } : {}),
      deniedReason: "Workspace main update denied",
    }
  );
  if (!authorization.allowed) {
    throw new Error(authorization.reason ?? "Workspace main update denied");
  }
}

function isMetaPath(filePath: string): boolean {
  return filePath === "meta" || filePath.startsWith("meta/");
}

function metaIdentityGrantKey(identityKey: string): string {
  return `unit-meta-identity\x00${identityKey}`;
}

function userlandCallerKind(kind: string): "panel" | "app" | "worker" | "do" | null {
  if (kind === "panel" || kind === "app" || kind === "worker" || kind === "do") return kind;
  return null;
}

function metaChangeSummary(candidate: MainAdvanceApprovalCandidate): string {
  // Advances are strictly per-repo: the ref gate re-roots every changed path
  // with the single advancing repo, so a meta-changing candidate's paths are
  // ALL under `meta/` — there is no mixed meta/non-meta case to summarize.
  const metaPaths = candidate.changedPaths.filter(isMetaPath);
  return metaPaths.length === 0
    ? "workspace config change"
    : metaPaths.length === 1
      ? `${metaPaths[0]} changed`
      : `${metaPaths.length} workspace config files changed`;
}

function metaChangeTitle(units: UnitBatchEntry[]): string {
  const hasApps = units.some((unit) => unit.unitKind === "app");
  const hasExtensions = units.some((unit) => unit.unitKind === "extension");
  const hasScheduledJobs = units.some((unit) => unit.unitKind === "scheduled-job");
  const hasAgentHeartbeats = units.some((unit) => unit.unitKind === "agent-heartbeat");
  if ([hasApps, hasExtensions, hasScheduledJobs, hasAgentHeartbeats].filter(Boolean).length > 1) {
    return "Workspace units changed";
  }
  if (hasApps) return "Workspace apps changed";
  if (hasExtensions) return "Workspace extensions changed";
  if (hasScheduledJobs) return "Workspace scheduled jobs changed";
  if (hasAgentHeartbeats) return "Workspace agent heartbeats changed";
  return "Edit workspace config";
}

function metaChangeDescription(units: UnitBatchEntry[]): string {
  const appCount = units.filter((unit) => unit.unitKind === "app").length;
  const extensionCount = units.filter((unit) => unit.unitKind === "extension").length;
  const jobCount = units.filter((unit) => unit.unitKind === "scheduled-job").length;
  const heartbeatCount = units.filter((unit) => unit.unitKind === "agent-heartbeat").length;
  const parts: string[] = [];
  if (extensionCount > 0) {
    parts.push(
      `${extensionCount} extension${extensionCount === 1 ? "" : "s"} that will run as native code`
    );
  }
  if (appCount > 0) {
    parts.push(
      `${appCount} privileged app${appCount === 1 ? "" : "s"} that will run in the app host`
    );
  }
  if (jobCount > 0) {
    parts.push(`${jobCount} scheduled job${jobCount === 1 ? "" : "s"} that will run automatically`);
  }
  if (heartbeatCount > 0) {
    parts.push(
      `${heartbeatCount} agent heartbeat${heartbeatCount === 1 ? "" : "s"} that will run unattended`
    );
  }
  return parts.length > 0
    ? `This push edits workspace config and adds ${parts.join(" and ")}.`
    : "This push edits sensitive workspace configuration.";
}

function mainAdvanceTitle(candidate: MainAdvanceApprovalCandidate): string {
  if (candidate.operation === "push") return "Push workspace changes";
  return "Merge into workspace main";
}

function mainAdvanceDescription(candidate: MainAdvanceApprovalCandidate): string {
  return `This ${operationLabel(candidate.operation)} moves workspace main and changes ${pathCountSummary(candidate.changedPaths)}.`;
}

function mainAdvanceDetails(
  candidate: MainAdvanceApprovalCandidate
): Array<{ label: string; value: string }> {
  return [
    { label: "Operation", value: operationLabel(candidate.operation) },
    { label: "Repo", value: candidate.repoPath },
    ...(candidate.via ? [{ label: "Via", value: candidate.via }] : []),
    ...(candidate.sourceHead ? [{ label: "Source", value: candidate.sourceHead }] : []),
    { label: "State", value: candidate.stateHash },
    { label: "Changes", value: changedPathsSummary(candidate.changedPaths) },
    { label: "Built", value: candidate.buildStatusLine ?? "not validated" },
  ];
}

/**
 * Render the host-sourced build-status line for the candidate view. A pure
 * cache read (§2.2) that NEVER triggers a build: absent dep, a null result, or
 * an unvalidated view all render "not validated"; a validated view renders
 * "ok" unless a unit failed ("failed").
 */
async function resolveBuildStatusLine(
  getBuildStatusAt:
    | ((viewHash: string) => Promise<{ validated: boolean; failed?: boolean }> | null)
    | undefined,
  viewHash: string
): Promise<string> {
  if (!getBuildStatusAt) return "not validated";
  let status: { validated: boolean; failed?: boolean } | null;
  try {
    status = await getBuildStatusAt(viewHash);
  } catch {
    return "not validated";
  }
  if (!status || !status.validated) return "not validated";
  return status.failed ? "failed" : "ok";
}

function operationLabel(operation: MainAdvanceOperation): string {
  switch (operation) {
    case "merge":
      return "vcs merge";
    case "push":
      return "vcs push";
  }
}

function pathCountSummary(paths: string[]): string {
  if (paths.length === 1) return "1 path";
  return `${paths.length} paths`;
}

function changedPathsSummary(paths: string[]): string {
  if (paths.length === 0) return "no paths";
  if (paths.length <= 3) return paths.join(", ");
  return `${paths.slice(0, 3).join(", ")} and ${paths.length - 3} more`;
}
