import YAML from "yaml";
import type { UnitChangeApprovalProvider } from "@vibestudio/unit-host";
import type {
  ApprovalPreparationProgress,
  DiffReviewEntry,
  DiffReviewFile,
  ReviewedUnit,
} from "@vibestudio/shared/approvals";
import type {
  HostAuthorityEffect,
  AuthorityChallengePresentation,
  ServiceContext,
  VerifiedCaller,
} from "@vibestudio/shared/serviceDispatcher";
import type { AppCapability } from "@vibestudio/shared/unitManifest";
import type {
  InstallReviewOrigin,
  InstallReviewTemplate,
  UnitInstallSourceOrigin,
} from "@vibestudio/shared/authority/unitInstallReview";
import type { UnitAuthorityRequest } from "@vibestudio/shared/authorityManifest";
import {
  multipleTemplateContributorsOrigin,
  templateOrigin,
} from "@vibestudio/shared/authority/reviewedUnitParts";
import { HOST_APPROVAL_COPY } from "@vibestudio/shared/hostApprovalCopy";
import { assertTemplateLockIntegrityForRead } from "@vibestudio/workspace/templateLock";
import {
  normalizeTemplateGitUrl,
  templateGitTransportUrl,
} from "@vibestudio/workspace/templateCoordinates";
import type { WorkspaceTemplateLock } from "@vibestudio/workspace-contracts/types";
import { sanitizeTemplateDisplayText } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import { compareUtf16CodeUnits, EMPTY_STATE_HASH } from "@vibestudio/content-addressing";
import { countLines, countLineDiff } from "@vibestudio/shared/lineDiff";
import { blobPath, diffTrees, getBytes, statBlob } from "./blobstoreService.js";
import { joinRepoPrefix } from "../vcsHost/paths.js";
import { isAuthorizedChrome, isInteractiveChrome } from "./chromeTrust.js";
import type {
  RefGate,
  RefGateBatch,
  RefGateBatchEntry,
  RefGateCompletion,
} from "./protectedRefStore.js";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import { sha256Canonical } from "@vibestudio/shared/authority/invocationSnapshot";

const WORKSPACE_MAIN_ADVANCE_CAPABILITY = "workspace-main-advance";
// Deliberately DISTINCT from the write capability: a generic
// `workspace-main-advance` grant must NEVER silently authorize a
// destructive whole-repo deletion. The per-repo resource key (below) further
// ensures approving the deletion of one repo never covers another.
const WORKSPACE_REPO_DELETE_CAPABILITY = "workspace-repo-delete";
const SLOW_PUBLICATION_STAGE_MS = 10_000;
// Restoring a deleted repo re-creates its `main` ref (`expectedOld: null`), so it
// flows through the GENERIC advance prompt as an add-repo (classified from the CAS
// shape)—there is no distinct restore capability; restore semantics are GAD-owned.

/**
 * One atomic protected-ref publication awaiting approval. The
 * `changedPaths` are SERVER-COMPUTED (content-store `diffTrees` between the
 * ref's current and candidate trees, re-rooted workspace-relative) — never
 * caller-supplied (see {@link createMainRefAdvanceGate}).
 */
export interface MainAdvanceApprovalCandidate {
  caller: VerifiedCaller;
  /** Cancellation of the originating publication request. */
  signal?: AbortSignal;
  /** Repositories advanced by this one atomic protected publication. */
  repoPaths: readonly string[];
  /** Server-computed changed paths, workspace-rooted. */
  changedPaths: string[];
  /** The composed workspace view AT THE CANDIDATE (the workspace as it would
   *  be after this advance) — meta unit derivation + approval dedup keys. A
   *  group push shares ONE candidate view across its repos, so the whole group
   *  coalesces into one prompt/grant. */
  stateHash: string;
  /** Exact protected publication whose commit completes this review. */
  publicationId: string;
  /** Display-only "requested by X via Y" attribution: the DO identity a
   *  caller-driven advance was dispatched through (§4). The AUTHORITATIVE
   *  principal is `caller` (host-resolved); `via` is prompt copy only. */
  via?: string;
  /** Host-computed diff-review payload for the whole batch (§5.1), surfaced on
   *  the approval so the reviewer sees the full server-side diff. */
  diffReview?: DiffReviewEntry[];
}

/**
 * Per-batch context on the private protected-ref effect. Caller publications
 * carry the host-verified requester. The only caller-free publication is the
 * exact first workspace snapshot installed by the trusted lifecycle operation.
 * Durable publication replay is recognized by ProtectedRefStore evidence and
 * never needs a gate context.
 */
export type RefAdvanceGateContext =
  | { kind: "workspace-initialization" }
  | {
      kind: "caller";
      caller: VerifiedCaller;
      /** The protected-ref wait is part of this request, never detached work. */
      signal?: AbortSignal;
      /** DO identity the write was dispatched through, for "requested by X via
       *  Y" prompt copy (§4). Never authoritative. */
      via?: string;
      /** Composed candidate workspace view (a caller-driven advance passes its
       *  shared candidate view so one approval covers the whole batch). When
       *  absent the gate composes one itself from the batch entries. */
      candidateWorkspaceState?: string;
    };

/**
 * The ProtectedRefStore gate for protected `main` refs — THE single approval path for
 * every main advance (docs/provenance-aware-diff-merge-plan.md §9). It computes
 * the AUTHORITATIVE diff itself from the CAS'd trees (`expectedOld` → `next`)
 * via the content store; callers may propose summaries, but the prompt's
 * changed paths always come from this server-side diff.
 */
export function createMainRefAdvanceGate(deps: {
  blobsDir: string;
  approvalGate: Pick<
    MainAdvanceApprovalGate,
    "approve" | "approveRepoDeletion" | "approveSemanticAdvance"
  >;
  /** Lazy mirroring hook (ContentProjectionStore.ensureStateMirrored) so historical states
   *  minted inside the store resolve to full trees before diffing. */
  ensureStateMirrored(stateHash: string): Promise<void>;
  /** Compose the candidate workspace content view with one atomic batch of repo
   *  overrides (`stateHash: null` removes the repo). This is a protected-ref
   *  effect input, never a semantic revision or ancestry authority. */
  workspaceViewWithReposAt(
    overrides: Array<{ repoPath: string; stateHash: string | null }>
  ): Promise<string>;
  /** Reject candidate workspace-wide invariants before prompting or advancing refs. */
  validateCandidateWorkspaceState?(
    stateHash: string,
    changedPaths: readonly string[],
    signal?: AbortSignal,
    reportProgress?: (progress: ApprovalPreparationProgress) => void
  ): Promise<void>;
  beginCandidateReview?(candidate: MainAdvanceApprovalCandidate): void;
  updateCandidateReview?(publicationId: string, progress: ApprovalPreparationProgress): void;
  failCandidateReview?(publicationId: string, error: unknown): void;
  discardCandidateReview?(publicationId: string): void;
  /** Host-computed dependents of a repo being DELETED (repos whose build unit
   *  imports it), for the severe deletion prompt's dependents warning (§5) —
   *  derived from the build dependency graph at the live workspace view. Absent
   *  ⇒ no dependents surfaced. */
  computeDeleteDependents?(repoPath: string): Promise<string[]>;
  /** Records that the ungated creation publication owes a creation review (§7.1). */
  onWorkspaceInitialized?(): void;
}): RefGate {
  return async (batch: RefGateBatch): Promise<RefGateCompletion | undefined> => {
    const context = batch.gateContext as RefAdvanceGateContext | undefined;
    if (!context || (context.kind !== "workspace-initialization" && context.kind !== "caller")) {
      // Fail CLOSED: a protected-main update without an explicit advance
      // context is a programming error, never an implicit allow.
      throw new Error(`Protected main update carries no gate context`);
    }
    if (context.kind === "workspace-initialization") {
      // There is no workspace yet and nobody to ask, so this publication does not
      // prompt. It is not a silent trust path either: the units it lands are
      // admitted by the creation review, held in the new workspace immediately
      // after it opens (§5.2, §7.1). This records that obligation durably.
      deps.onWorkspaceInitialized?.();
      return;
    }

    // ONE candidate workspace view for the whole batch: current mains ⊕ entries
    // (deletes remove the repo). The shared view hash is the dedup key that
    // coalesces a multi-repo batch into one prompt, exactly as group push does.
    const candidateView =
      context.candidateWorkspaceState ??
      (await observePublicationStage(
        "compose-candidate-view",
        {
          repoPaths: batch.entries.map((entry) => entry.repoPath),
          publicationId: batch.publication.publicationId,
        },
        () =>
          deps.workspaceViewWithReposAt(
            batch.entries.map((entry) => ({ repoPath: entry.repoPath, stateHash: entry.next }))
          )
      ));
    // Seed validation from the advancing repository paths. The build system
    // resolves each seed to its unit and reverse dependency closure; this
    // keeps publication validation on the same topology as state-triggered
    // builds without requiring a full workspace sweep.
    const preparingCandidate: MainAdvanceApprovalCandidate = {
      caller: context.caller,
      ...(context.signal ? { signal: context.signal } : {}),
      repoPaths: batch.entries.map((entry) => entry.repoPath),
      changedPaths: batch.entries.map((entry) => entry.repoPath),
      stateHash: candidateView,
      publicationId: batch.publication.publicationId,
      ...(context.via ? { via: context.via } : {}),
    };
    if (batch.entries.some((entry) => entry.next !== null)) {
      deps.beginCandidateReview?.(preparingCandidate);
    }
    try {
      const changedRepoPaths = batch.entries.map((entry) => entry.repoPath);
      const reportProgress = (progress: ApprovalPreparationProgress) =>
        deps.updateCandidateReview?.(batch.publication.publicationId, progress);
      if (context.signal) {
        await deps.validateCandidateWorkspaceState?.(
          candidateView,
          changedRepoPaths,
          context.signal,
          reportProgress
        );
      } else {
        await deps.validateCandidateWorkspaceState?.(
          candidateView,
          changedRepoPaths,
          undefined,
          reportProgress
        );
      }
    } catch (error) {
      deps.failCandidateReview?.(batch.publication.publicationId, error);
      throw error;
    }

    if (batch.entries.length === 0) {
      await deps.approvalGate.approveSemanticAdvance({
        caller: context.caller,
        ...(context.signal ? { signal: context.signal } : {}),
        previousEventId: batch.publication.previousEventId,
        publishedEventId: batch.publication.publishedEventId,
        ...(context.via ? { via: context.via } : {}),
      });
      return;
    }

    // Build the whole-batch diff-review payload ONCE (one per batch entry,
    // §5.1). Every prompt in the batch carries the FULL payload so the reviewer
    // always sees the complete host-computed diff. Also yields the exact
    // workspace-rooted changed paths + file count per entry, reused below (so a
    // main advance never diffs its trees twice).
    const perEntry: Array<{
      entry: RefGateBatchEntry;
      review: DiffReviewEntry;
      changedPaths: string[];
    }> = [];
    try {
      for (const entry of batch.entries) {
        perEntry.push({
          entry,
          ...(await observePublicationStage(
            "build-diff-review",
            {
              repoPaths: [entry.repoPath],
              publicationId: batch.publication.publicationId,
            },
            () => buildDiffReviewEntry(deps, entry)
          )),
        });
      }
    } catch (error) {
      deps.failCandidateReview?.(batch.publication.publicationId, error);
      throw error;
    }
    const diffReview = perEntry.map((e) => e.review);
    const completions: MainAdvanceApprovalCompletion[] = [];
    const advances: Array<{ entry: RefGateBatchEntry; changedPaths: string[] }> = [];

    try {
      for (const { entry, review, changedPaths } of perEntry) {
        // The ONLY host-side classification is a REMOVAL, derived from the host's
        // own CAS request shape (`next === null`) — never from a caller-supplied
        // VCS-operation label. Everything else is an ordinary content advance;
        // the VCS workflow (push/merge/import/restore) lives in the DO.
        if (entry.next === null) {
          // Removal → severe per-repo deletion capability, inside the batch. The
          // dependents warning (repos whose build breaks) is host-computed from
          // the build dependency graph, exactly like the file count is from the
          // CAS diff (§5) — never caller-supplied.
          const dependents = deps.computeDeleteDependents
            ? await deps.computeDeleteDependents(entry.repoPath).catch(() => [])
            : [];
          await deps.approvalGate.approveRepoDeletion({
            caller: context.caller,
            ...(context.signal ? { signal: context.signal } : {}),
            repoPath: entry.repoPath,
            fileCount: review.diffStat.filesChanged,
            stateHash: entry.old ?? EMPTY_STATE_HASH,
            dependents,
            diffReview,
          });
          continue;
        }

        advances.push({ entry, changedPaths });
      }

      // Protected refs commit the batch atomically, the review describes the
      // whole candidate view, and its landing receipt is keyed by publication.
      // Authorize that same operation once. Per-repository authorization made
      // the second member of a batch compete for the first member's landing
      // channel after the user had already accepted the complete review.
      if (advances.length > 0) {
        const completion = await deps.approvalGate.approve({
          caller: context.caller,
          ...(context.signal ? { signal: context.signal } : {}),
          repoPaths: advances.map(({ entry }) => entry.repoPath),
          changedPaths: advances.flatMap(({ changedPaths }) => changedPaths),
          stateHash: candidateView,
          publicationId: batch.publication.publicationId,
          diffReview,
          ...(context.via ? { via: context.via } : {}),
        });
        if (completion) completions.push(completion);
        deps.discardCandidateReview?.(batch.publication.publicationId);
      }
    } catch (error) {
      for (const completion of completions) await completion.failed(error);
      deps.failCandidateReview?.(batch.publication.publicationId, error);
      throw error;
    }
    if (completions.length === 0) return;
    return {
      prepare: async () => {
        for (const completion of completions) await completion.prepare();
      },
      committed: async () => {
        for (const completion of completions) await completion.committed();
      },
      failed: async (error) => {
        for (const completion of completions) await completion.failed(error);
      },
    } satisfies RefGateCompletion;
  };
}

// Host-side protected-publication diff review (provenance-aware-diff-merge-plan §9).
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
  raw.sort((a, b) => compareUtf16CodeUnits(a.path, b.path));

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

async function observePublicationStage<T>(
  stage: string,
  detail: { repoPaths: string[]; publicationId?: string },
  operation: () => Promise<T>
): Promise<T> {
  const startedAt = performance.now();
  let reportedSlow = false;
  const timer = setTimeout(() => {
    reportedSlow = true;
    console.warn("[Vcs] protected publication stage is slow", {
      stage,
      elapsedMs: Math.round(performance.now() - startedAt),
      repoPaths: detail.repoPaths,
      ...(detail.publicationId ? { publicationId: detail.publicationId } : {}),
    });
  }, SLOW_PUBLICATION_STAGE_MS);
  timer.unref?.();
  try {
    return await operation();
  } finally {
    clearTimeout(timer);
    if (reportedSlow) {
      console.info("[Vcs] protected publication stage settled", {
        stage,
        elapsedMs: Math.round(performance.now() - startedAt),
        repoPaths: detail.repoPaths,
        ...(detail.publicationId ? { publicationId: detail.publicationId } : {}),
      });
    }
  }
}

/** A pending whole-repo deletion awaiting the user's explicit, severe approval. */
export interface RepoDeletionApprovalCandidate {
  caller: VerifiedCaller;
  signal?: AbortSignal;
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

/** A protected semantic-main advance whose repository snapshot is unchanged. */
export interface SemanticAdvanceApprovalCandidate {
  caller: VerifiedCaller;
  signal?: AbortSignal;
  previousEventId: string;
  publishedEventId: string;
  /** Display-only host dispatch identity; never authorization or authorship. */
  via?: string;
}

const TEMPLATE_LOCK_PATH = "meta/templates.lock.yml";
// A heading and a single line under it. Same bounds the manifest schema applies
// on the way in, restated here because this side must hold even if a lock was
// written by an older composer that had looser ones.
const TEMPLATE_NAME_MAX = 60;
const TEMPLATE_PURPOSE_MAX = 200;

/** `installReview` as this gate presents it. */
export type InstallReviewPresentation = NonNullable<
  AuthorityChallengePresentation["installReview"]
>;

/**
 * What a publication does to this workspace's template relationships (§5.3).
 *
 * A template pulls foreign code over the network — categorically unlike an edit
 * to code already present — so it gets the install surface rather than "someone
 * edited this part in your workspace". Everything needed to say that is derived
 * here, on the server, and nothing about it is asked of the caller.
 */
export interface TemplateOperationRecognition {
  mode: "install" | "update" | "remove";
  template: InstallReviewTemplate;
  /** Where each repository the lock claims came from, at the state being published. */
  origins: ReadonlyMap<string, InstallReviewOrigin>;
  /** Repositories touched by contributions from the closure this operation moves. */
  contributedRepoPaths: ReadonlySet<string>;
}

/**
 * Recognize a template operation from the two locks, and from nothing else.
 *
 * §13.9 requires both directions to fail at the server boundary: a template
 * operation cannot be disguised as an ordinary publication to get the generic
 * card, and an ordinary publication cannot claim to be a template install to
 * borrow its framing. A flag on the request — or the composer's own operation
 * record, which is userland state written by the extension that wants the
 * framing — answers neither, because both are assertions by the party under
 * review.
 *
 * `meta/templates.lock.yml` is different. It is the workspace's committed
 * projection of its template closure, its fingerprint covers every node, pin,
 * and repository contribution entry, and `assertTemplateLockIntegrityForRead`
 * additionally re-derives each node id from its own pin and each alias from its
 * own URL. Diffing the lock the workspace has against the lock the publication
 * would install is therefore not a claim about the operation — it IS the
 * operation, stated in the only terms that survive verification: which template
 * roots this publication adds, re-pins, or drops. A publication that changes no
 * root changes no template relationship, and gets the ordinary part-changed
 * review no matter who published it or what it says about itself.
 *
 * A lock that fails integrity is not evidence of anything, so it recognizes
 * nothing and the publication falls back to the generic review. Failing that
 * way round matters: the risk being defended against is a forged lock buying
 * install framing, never a real one losing it.
 */
export function recognizeTemplateOperation(input: {
  /** The lock the workspace currently has, or null when it composes nothing. */
  currentLock: WorkspaceTemplateLock | null;
  /** The lock at the state being published. */
  candidateLock: WorkspaceTemplateLock | null;
  /** Sources the user has already run code from, for first encounter. */
  admittedOriginKeys: ReadonlySet<string>;
}): TemplateOperationRecognition | null {
  const current = rootNodes(input.currentLock);
  const candidate = rootNodes(input.candidateLock);
  const moved: Array<{
    mode: TemplateOperationRecognition["mode"];
    url: string;
  }> = [];
  for (const [url, node] of candidate) {
    const before = current.get(url);
    if (!before) moved.push({ mode: "install", url });
    // The commit is the exact identity of a pin and never leaves this function:
    // it decides whether the pin moved, and the review shows only the human ref.
    else if (before.pin.commit !== node.pin.commit) moved.push({ mode: "update", url });
  }
  for (const url of current.keys()) {
    if (!candidate.has(url)) moved.push({ mode: "remove", url });
  }
  // Two templates moving at once is a real state — a recompose, a cutover — but
  // it has no single name, and naming it after one of them would head the card
  // with a template that is not the whole story. The generic review is the
  // honest surface for it.
  if (moved.length !== 1) return null;
  const operation = moved[0]!;

  const lock = operation.mode === "remove" ? input.currentLock : input.candidateLock;
  const rootNode = (operation.mode === "remove" ? current : candidate).get(operation.url)!;
  const fromVersion = current.get(operation.url)?.pin.ref ?? null;
  const toVersion = candidate.get(operation.url)?.pin.ref ?? null;

  // A root's closure is the root plus everything it depends on. A repository
  // belongs to the operation when any node in that closure contributes to it;
  // no template exclusively owns the resulting workspace repository.
  const nodesById = new Map((lock?.nodes ?? []).map((node) => [node.nodeId, node]));
  const closure = new Set<string>();
  const pending = [rootNode.nodeId];
  while (pending.length > 0) {
    const nodeId = pending.pop()!;
    if (closure.has(nodeId)) continue;
    closure.add(nodeId);
    for (const parent of nodesById.get(nodeId)?.parents ?? []) pending.push(parent);
  }

  const origins = new Map<string, InstallReviewOrigin>();
  const contributedRepoPaths = new Set<string>();
  for (const [repoPath, repository] of Object.entries(lock?.repositories ?? {})) {
    const contributors = repository.contributions
      .map(({ nodeId }) => nodesById.get(nodeId))
      .filter((node): node is NonNullable<typeof node> => node !== undefined);
    if (contributors.length === 1) {
      const contributor = contributors[0]!;
      const contributorName = sanitizeTemplateDisplayText(
        contributor.presentation?.name,
        TEMPLATE_NAME_MAX
      );
      origins.set(
        repoPath,
        templateOrigin({
          url: contributor.pin.url,
          version: contributor.pin.ref,
          ...(contributorName ? { selfName: contributorName } : {}),
          admittedOriginKeys: input.admittedOriginKeys,
        })
      );
    } else if (contributors.length > 1) {
      origins.set(repoPath, multipleTemplateContributorsOrigin());
    }
    if (repository.contributions.some(({ nodeId }) => closure.has(nodeId))) {
      contributedRepoPaths.add(repoPath);
    }
  }

  // What the template says it is called and what it says it does, re-sanitized
  // at the point of use. The lock's fingerprint proves these bytes are the ones
  // the composer wrote; it proves nothing about whether the template authored
  // them hostile, and this is the last place before they reach a person.
  const selfName = sanitizeTemplateDisplayText(rootNode.presentation?.name, TEMPLATE_NAME_MAX);
  const selfPurpose = sanitizeTemplateDisplayText(
    rootNode.presentation?.description,
    TEMPLATE_PURPOSE_MAX
  );

  return {
    mode: operation.mode,
    template: {
      // The template's own name may head the card, because a heading is a title
      // and titles are attributed to the thing they name. It may NOT become the
      // origin: `origin` below is built from the pin URL alone, so a template
      // calling itself Vibestudio changes what the card is headed and nothing
      // about where the review says its bytes came from (§7.6.3). When the
      // manifest offers no usable name — or offered one the sanitizer refused —
      // the URL stem stands in, which is a worse heading and an honest one.
      title: selfName ?? templateTitleFromUrl(rootNode.pin.url),
      purpose: selfPurpose ?? "",
      origin: templateOrigin({
        url: rootNode.pin.url,
        version: toVersion ?? fromVersion,
        // Carried beside the URL rather than instead of it: every renderer that
        // shows `selfName` shows it as the template's claim about itself, next
        // to the identity it cannot alter.
        ...(selfName ? { selfName } : {}),
        admittedOriginKeys: input.admittedOriginKeys,
      }),
      fromVersion,
      toVersion,
    },
    origins,
    contributedRepoPaths,
  };
}

/** The declared roots of a lock, keyed by normalized URL, with their nodes. */
function rootNodes(
  lock: WorkspaceTemplateLock | null
): ReadonlyMap<string, WorkspaceTemplateLock["nodes"][number]> {
  const roots = new Map<string, WorkspaceTemplateLock["nodes"][number]>();
  if (!lock) return roots;
  for (const root of lock.roots) {
    const url = normalizeTemplateGitUrl(root.url);
    const node = lock.nodes.find((candidate) => normalizeTemplateGitUrl(candidate.pin.url) === url);
    // Integrity already refuses a root without a node; skipping is belt to that
    // brace rather than a case that can reach here.
    if (node) roots.set(url, node);
  }
  return roots;
}

/**
 * The human name of a template, derived from its URL and only from its URL.
 *
 * Same derivation the lock's alias uses, minus the content-addressed suffix
 * that makes an alias collision-proof and a heading unreadable.
 */
function templateTitleFromUrl(url: string): string {
  try {
    const transport = new URL(templateGitTransportUrl(normalizeTemplateGitUrl(url)));
    return (
      transport.pathname
        .split("/")
        .filter(Boolean)
        .at(-1)
        ?.replace(/\.git$/u, "")
        .replace(/^vibestudio-(?:template|workspace)-/u, "")
        .replace(/^template-/u, "") || "template"
    );
  } catch {
    return "template";
  }
}

export interface MainAdvanceApprovalGate {
  approve(
    candidate: MainAdvanceApprovalCandidate
  ): Promise<MainAdvanceApprovalCompletion | undefined>;
  /** Gate a new semantic event even when it preserves every protected byte. */
  approveSemanticAdvance(candidate: SemanticAdvanceApprovalCandidate): Promise<void>;
  /** Gate a severe, global-state whole-repo deletion. Throws if denied. */
  approveRepoDeletion(candidate: RepoDeletionApprovalCandidate): Promise<void>;
}

export interface MainAdvanceApprovalCompletion {
  prepare(): void | Promise<void>;
  committed(): void | Promise<void>;
  failed(error: unknown): void | Promise<void>;
}

export function createMainAdvanceApprovalGate(deps: {
  authorizeEffect(ctx: ServiceContext, effect: HostAuthorityEffect): Promise<void>;
  hasAppCapability?: (callerId: string, capability: AppCapability) => boolean;
  getProviders(): Array<UnitChangeApprovalProvider<ReviewedUnit> | null | undefined>;
  /**
   * Row keys a part already holds standing clearance for. An update re-mints
   * exactly these ∩ the new manifest ∩ current policy, so a permission the user
   * declined stays declined and one that was working keeps working (§7.3).
   */
  heldClearanceFor?: (repoPath: string) => ReadonlySet<string> | null;
  /**
   * Where each unit's bytes came from, keyed by repo path.
   *
   * A publication review names parts the same way every other surface does, and
   * origin is part of that name. Without it every part falls back to the host's
   * own build, so a unit that arrived with someone else's template would be
   * presented as ours — the one claim this system must never make by accident.
   */
  resolveUnitOrigins?: (
    repoPaths: readonly string[]
  ) => Promise<ReadonlyMap<string, InstallReviewOrigin>>;
  /**
   * `meta/templates.lock.yml` at an exact composed workspace state, and at the
   * live workspace when `stateHash` is null.
   *
   * This is the whole input to recognizing a template operation, and it is
   * deliberately a raw read: the gate parses and integrity-checks the bytes
   * itself rather than being handed someone's interpretation of them.
   */
  readTemplateLock?: (stateHash: string | null) => Promise<string | null>;
  /** Sources the user has already run code from, for first encounter. */
  admittedOriginKeys?: () => ReadonlySet<string>;
  reportInstallLandingByToken?: (
    landingToken: string,
    report: import("./approvalQueue.js").InstallLandingReport
  ) => void;
}): MainAdvanceApprovalGate {
  // One publication reaches this gate once per repository it advances, each
  // time with the same candidate view. The recognition is a property of that
  // view, so it is computed once and reused for the whole batch.
  let recognized: { stateHash: string; result: TemplateOperationRecognition | null } | null = null;
  const recognizeFor = async (stateHash: string): Promise<TemplateOperationRecognition | null> => {
    if (!deps.readTemplateLock) return null;
    if (recognized?.stateHash === stateHash) return recognized.result;
    let result: TemplateOperationRecognition | null = null;
    try {
      const [currentText, candidateText] = await Promise.all([
        deps.readTemplateLock(null),
        deps.readTemplateLock(stateHash),
      ]);
      result = recognizeTemplateOperation({
        currentLock: verifiedTemplateLock(currentText, "the workspace"),
        candidateLock: verifiedTemplateLock(candidateText, "this publication"),
        admittedOriginKeys: deps.admittedOriginKeys?.() ?? new Set<string>(),
      });
    } catch (error) {
      // Nothing about the decision depends on recognizing the operation being
      // possible: failing here costs the template framing, never the review.
      console.warn(
        `[Units] Could not read template relationships for this publication: ${message(error)}`
      );
      result = null;
    }
    recognized = { stateHash, result };
    return result;
  };
  return {
    async approve(candidate) {
      if (candidate.changedPaths.length === 0) return;
      const metaChanged = candidate.changedPaths.some(isMetaPath);

      const runtimeKind = candidate.caller.runtime.kind;
      // Trusted first-party UI writing for the user in front of it — setup,
      // settings, layout. The click IS the consent, so these publications record
      // admission and stay silent (§5.2). A `server` or `headless-host`
      // publication has no user and no click, so it falls through to the
      // ordinary gate below even though it also holds `panel-hosting`.
      const interactiveChrome = isInteractiveChrome(candidate.caller, {
        hasAppCapability: deps.hasAppCapability,
      });

      if (!interactiveChrome) {
        const callerKind = userlandCallerKind(runtimeKind);
        if (!callerKind) {
          throw new Error(`Workspace main advances from ${runtimeKind} callers are not supported`);
        }

        const identity = candidate.caller.code;
        if (!identity || identity.callerKind !== runtimeKind) {
          throw new Error(`Unknown caller identity: ${candidate.caller.runtime.id}`);
        }
      }

      const providers = deps
        .getProviders()
        .filter(
          (provider): provider is UnitChangeApprovalProvider<ReviewedUnit> =>
            provider !== null && provider !== undefined
        );
      const approvals = await observePublicationStage(
        "resolve-unit-review",
        { repoPaths: [...candidate.repoPaths] },
        () =>
          Promise.all(
            providers.map(async (provider) => ({
              provider,
              approval: await provider.unitChangeApprovalForCommit(candidate.stateHash, {
                changedPaths: candidate.changedPaths,
              }),
            }))
          )
      );
      const units = approvals.flatMap(({ approval }) => approval.units);
      const charters = approvals.flatMap(({ approval }) => approval.charters ?? []);
      const unchangedPartCount = approvals.reduce(
        (total, { approval }) => total + (approval.unchangedCount ?? 0),
        0
      );
      const previousRequests = new Map(
        approvals.flatMap(({ approval }) => [...(approval.previousRequests ?? [])])
      );
      const identityKeys = new Map(
        approvals.flatMap(({ approval }) => [...(approval.identityKeysByRepo ?? [])])
      );
      const previouslyCleared = new Map(
        [...previousRequests.keys()].flatMap((repoPath) => {
          const held = deps.heldClearanceFor?.(repoPath);
          return held ? [[repoPath, held] as const] : [];
        })
      );
      type PreparedUnitTrust = {
        committed(): void | Promise<void>;
        failed(error: unknown): void | Promise<void>;
      };
      const failPreparedUnits = async (
        prepared: readonly PreparedUnitTrust[],
        error: unknown
      ): Promise<void> => {
        const rollbackErrors: unknown[] = [];
        for (const transaction of [...prepared].reverse()) {
          try {
            await transaction.failed(error);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        if (rollbackErrors.length > 0) {
          throw new AggregateError(
            [error, ...rollbackErrors],
            "Unit trust preparation could not be rolled back"
          );
        }
      };
      const commitPreparedUnits = async (prepared: readonly PreparedUnitTrust[]): Promise<void> => {
        const commitErrors: unknown[] = [];
        for (const transaction of prepared) {
          try {
            await transaction.committed();
          } catch (commitError) {
            commitErrors.push(commitError);
          }
        }
        if (commitErrors.length > 0) {
          throw new AggregateError(commitErrors, "Unit trust preparation could not be committed");
        }
      };
      const prepareReviewedUnits = async (
        origin: "chrome" | "publication",
        sourceOrigins?: ReadonlyMap<string, UnitInstallSourceOrigin | null>
      ): Promise<PreparedUnitTrust[]> => {
        const prepared: PreparedUnitTrust[] = [];
        try {
          for (const { provider, approval } of approvals) {
            const hasSourceOrigins =
              approval.identityKeys.length > 0 &&
              sourceOrigins !== undefined &&
              sourceOrigins.size > 0;
            const transaction = hasSourceOrigins
              ? provider.preparePreapprovedTrust?.(
                  approval.identityKeys,
                  origin,
                  undefined,
                  sourceOrigins
                )
              : provider.preparePreapprovedTrust?.(approval.identityKeys, origin);
            if (transaction) prepared.push(transaction);
            else if (!provider.preparePreapprovedTrust) {
              // Stateless providers retain the one-shot API. Every provider
              // that records durable trust implements the two-phase form.
              if (hasSourceOrigins) {
                provider.acceptPreapprovedTrust(
                  approval.identityKeys,
                  origin,
                  undefined,
                  sourceOrigins
                );
              } else {
                provider.acceptPreapprovedTrust(approval.identityKeys, origin);
              }
            }
          }
          return prepared;
        } catch (error) {
          await failPreparedUnits(prepared, error);
          throw error;
        }
      };

      let preparedTransactions: PreparedUnitTrust[] = [];
      let prepared = false;

      if (interactiveChrome) {
        // Silent, but never trust-free. Admission is committed with the refs,
        // never merely with authorization for a publication that may fail.
        return {
          prepare: async () => {
            if (prepared) return;
            preparedTransactions = await prepareReviewedUnits("chrome");
            prepared = true;
          },
          committed: async () => {
            if (!prepared) {
              preparedTransactions = await prepareReviewedUnits("chrome");
              prepared = true;
            }
            await commitPreparedUnits(preparedTransactions);
          },
          failed: async (error) => {
            await failPreparedUnits(preparedTransactions, error);
          },
        };
      }

      const template = await recognizeFor(candidate.stateHash);

      // Nothing changed about what any part can do, and no charter arrived:
      // this is an ordinary content advance, not a permission decision. A
      // template operation is never that, even when it lands nothing but
      // effective-version churn — an upgrade that changes no declared authority
      // is still a decision about foreign code, and §5.4 gives it one line
      // rather than no card at all.
      if (!template && !metaChanged && units.length === 0 && charters.length === 0) {
        await approveWorkspaceMainAdvance(deps, candidate);
        return {
          prepare: async () => {
            if (prepared) return;
            preparedTransactions = await prepareReviewedUnits("publication");
            prepared = true;
          },
          committed: async () => {
            if (!prepared) {
              preparedTransactions = await prepareReviewedUnits("publication");
              prepared = true;
            }
            await commitPreparedUnits(preparedTransactions);
          },
          failed: async (error) => {
            await failPreparedUnits(preparedTransactions, error);
          },
        };
      }

      const repoPaths = units.map((unit) => unit.source.repo);
      const origins = new Map(await (deps.resolveUnitOrigins?.(repoPaths) ?? []));
      // The resolver answers from the lock the workspace HAS. A template
      // arriving now is not in it, so every part it lands would print as the
      // workspace's own code — the one claim this system must never make by
      // accident. The candidate lock is the same evidence one state later, so
      // it wins wherever it claims a repository.
      for (const [repoPath, origin] of template?.origins ?? []) origins.set(repoPath, origin);
      // Inside a template publication every changed unit is one of two things:
      // a repository this template closure contributes to, or an unrelated fix
      // in the same publication, which is shown separately (§5.3). A shared
      // repository remains a template contribution; no exclusive owner exists.
      const sections = template
        ? new Map(
            repoPaths.map(
              (repoPath) =>
                [
                  repoPath,
                  template.contributedRepoPaths.has(repoPath) ? "template" : "repair",
                ] as const
            )
          )
        : null;
      await approveWorkspaceMainAdvance(deps, candidate, {
        // An edit to code already in the workspace is the part-changed review
        // (§7.4): the question is not "may this run" but "someone edited this
        // part; do you want the new version?". A template operation asks the
        // other question — may this arrive at all — and says so in its heading.
        mode: template?.mode ?? "part-changed",
        reportsLanding: true,
        landingToken: candidate.publicationId,
        title: template
          ? HOST_APPROVAL_COPY.installReview.heading[template.mode](template.template.title)
          : unitChangeTitle(units, previousRequests, metaChanged),
        ...(template
          ? {}
          : { description: unitChangeDescription(units, previousRequests, metaChanged) }),
        ...(template ? { template: template.template } : {}),
        ...(sections ? { sections } : {}),
        units,
        ...(charters.length > 0 ? { charters } : {}),
        unchangedPartCount,
        previousRequests,
        previouslyCleared,
        identityKeys,
        origins,
        configWrite: metaChanged
          ? {
              repoPath: "meta",
              summary: metaChangeSummary(candidate),
            }
          : null,
      });
      const partIdentityKeys = [
        ...new Set(
          units.map(
            (unit) => identityKeys.get(unit.source.repo) ?? `${unit.source.repo}@${unit.ev ?? ""}`
          )
        ),
      ];
      return {
        prepare: async () => {
          if (prepared) return;
          preparedTransactions = await prepareReviewedUnits("publication", origins);
          prepared = true;
        },
        committed: async () => {
          try {
            if (!prepared) {
              preparedTransactions = await prepareReviewedUnits("publication", origins);
              prepared = true;
            }
            await commitPreparedUnits(preparedTransactions);
            deps.reportInstallLandingByToken?.(candidate.publicationId, {
              landed: partIdentityKeys,
            });
          } catch (error) {
            deps.reportInstallLandingByToken?.(candidate.publicationId, {
              landed: [],
              failed: partIdentityKeys.map((identityKey) => ({
                identityKey,
                reason: message(error),
              })),
              workspaceUnchanged: false,
            });
            throw error;
          }
        },
        failed: async (error) => {
          await failPreparedUnits(preparedTransactions, error);
          deps.reportInstallLandingByToken?.(candidate.publicationId, {
            landed: [],
            failed: partIdentityKeys.map((identityKey) => ({
              identityKey,
              reason: message(error),
            })),
            workspaceUnchanged: true,
          });
        },
      };
    },

    async approveSemanticAdvance(candidate) {
      if (isAuthorizedChrome(candidate.caller, { hasAppCapability: deps.hasAppCapability })) {
        return;
      }
      const runtimeKind = candidate.caller.runtime.kind;
      if (!userlandCallerKind(runtimeKind)) {
        throw new Error(`Workspace main advances from ${runtimeKind} callers are not supported`);
      }
      const identity = candidate.caller.code;
      if (!identity || identity.callerKind !== runtimeKind) {
        throw new Error(`Unknown caller identity: ${candidate.caller.runtime.id}`);
      }
      await authorizeProtectedPublication(deps, candidate.caller, {
        ...(candidate.signal ? { signal: candidate.signal } : {}),
        capability: WORKSPACE_MAIN_ADVANCE_CAPABILITY,
        resourceKey: "workspace-source-change:main",
        tier: "gated",
        args: [candidate.previousEventId, candidate.publishedEventId],
        preparedState: {
          previousEventId: candidate.previousEventId,
          publishedEventId: candidate.publishedEventId,
        },
        challenge: {
          dedupKey: `workspace-semantic-advance:${candidate.publishedEventId}`,
          resource: { type: "vcs-head", label: "Head", value: "workspace main" },
          operation: {
            kind: "workspace",
            verb: "advance workspace history",
            object: { type: "vcs-head", label: "Head", value: "workspace main" },
            groupKey: `workspace-semantic-advance:${candidate.publishedEventId}`,
          },
          title: "Advance workspace history",
          description:
            "This advances workspace main to a new semantic event without changing protected repository content.",
          details: [
            ...(candidate.via ? [{ label: "Via", value: candidate.via }] : []),
            { label: "Previous event", value: candidate.previousEventId },
            { label: "Published event", value: candidate.publishedEventId },
          ],
          deniedReason: "Workspace main update denied",
        },
      });
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
      await authorizeProtectedPublication(deps, candidate.caller, {
        ...(candidate.signal ? { signal: candidate.signal } : {}),
        capability: WORKSPACE_REPO_DELETE_CAPABILITY,
        resourceKey: `workspace-repo-delete:${candidate.repoPath}`,
        tier: "critical",
        args: [candidate.repoPath, candidate.stateHash],
        preparedState: candidate,
        challenge: {
          severity: "severe",
          dedupKey: `workspace-repo-delete:${candidate.repoPath}:${candidate.stateHash}`,
          resource: { type: "vcs-repo", label: "Repo", value: candidate.repoPath },
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
        },
      });
    },
  };
}

async function approveWorkspaceMainAdvance(
  deps: { authorizeEffect(ctx: ServiceContext, effect: HostAuthorityEffect): Promise<void> },
  candidate: MainAdvanceApprovalCandidate,
  installReview?: InstallReviewPresentation & {
    title: string;
    description?: string;
  }
): Promise<void> {
  const resourceKey = `workspace-source-change:publication:${candidate.publicationId}`;
  const groupKey = `workspace-publication:${candidate.publicationId}`;
  const repoLabel =
    candidate.repoPaths.length === 1
      ? `${candidate.repoPaths[0]} main`
      : `${candidate.repoPaths.length} workspace repositories`;
  await authorizeProtectedPublication(deps, candidate.caller, {
    ...(candidate.signal ? { signal: candidate.signal } : {}),
    capability: WORKSPACE_MAIN_ADVANCE_CAPABILITY,
    resourceKey,
    tier: "gated",
    args: [
      candidate.publicationId,
      candidate.repoPaths,
      candidate.stateHash,
      candidate.changedPaths,
    ],
    preparedState: candidate,
    challenge: {
      dedupKey: groupKey,
      resource: { type: "vcs-head", label: "Head", value: repoLabel },
      operation: {
        kind: "workspace",
        verb: "update workspace main",
        object: { type: "vcs-head", label: "Head", value: repoLabel },
        groupKey,
      },
      title: installReview?.title ?? mainAdvanceTitle(candidate),
      description: installReview?.description ?? mainAdvanceDescription(candidate),
      details: mainAdvanceDetails(candidate),
      ...(candidate.diffReview ? { diffReview: candidate.diffReview } : {}),
      ...(installReview ? { installReview: presentedInstallReview(installReview) } : {}),
      deniedReason: "Workspace main update denied",
    },
  });
}

/** The review as the dispatcher carries it: everything the card needs, nothing else. */
function presentedInstallReview(input: InstallReviewPresentation): InstallReviewPresentation {
  return {
    mode: input.mode,
    ...(input.reportsLanding ? { reportsLanding: true } : {}),
    ...(input.landingToken ? { landingToken: input.landingToken } : {}),
    units: input.units,
    ...(input.charters ? { charters: input.charters } : {}),
    ...(input.template ? { template: input.template } : {}),
    ...(input.previousRequests ? { previousRequests: input.previousRequests } : {}),
    ...(input.previouslyCleared ? { previouslyCleared: input.previouslyCleared } : {}),
    ...(input.origins ? { origins: input.origins } : {}),
    ...(input.identityKeys ? { identityKeys: input.identityKeys } : {}),
    ...(input.sections ? { sections: input.sections } : {}),
    unchangedPartCount: input.unchangedPartCount ?? 0,
    configWrite: input.configWrite ?? null,
  };
}

async function authorizeProtectedPublication(
  deps: { authorizeEffect(ctx: ServiceContext, effect: HostAuthorityEffect): Promise<void> },
  caller: VerifiedCaller,
  input: {
    signal?: AbortSignal;
    capability: string;
    resourceKey: string;
    tier: "gated" | "critical";
    args: readonly unknown[];
    preparedState: unknown;
    challenge: NonNullable<HostAuthorityEffect["challenge"]>;
  }
): Promise<void> {
  await deps.authorizeEffect(
    {
      caller,
      authorityAcquisition: "wait",
      ...(input.signal ? { signal: input.signal } : {}),
    },
    {
      service: "vcs",
      method: "vcsPush",
      capability: input.capability,
      resourceKey: input.resourceKey,
      // The code family already admits evaluated sessions; naming session again
      // duplicates the same branch and repeats one missing-grant reason.
      requirement: requirementForPrincipals(["host", "user", "code"], input.capability),
      tier: input.tier,
      sessionAdmission: "family",
      args: input.args,
      preparedStateDigest: sha256Canonical(input.preparedState),
      challenge: input.challenge,
      sensitivity: "write",
    }
  );
}

/**
 * A lock nobody has verified is not evidence. Parse it, check its fingerprint
 * and its internal derivations, and treat any failure as "there is no lock
 * here" — the answer that can only ever cost a publication its template
 * framing, never grant one framing it did not earn.
 */
function verifiedTemplateLock(
  content: string | null,
  source: string
): WorkspaceTemplateLock | null {
  if (content === null) return null;
  try {
    return assertTemplateLockIntegrityForRead(YAML.parse(content) as unknown);
  } catch (error) {
    console.warn(
      `[Units] ${TEMPLATE_LOCK_PATH} in ${source} failed integrity checks: ${message(error)}`
    );
    return null;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMetaPath(filePath: string): boolean {
  return filePath === "meta" || filePath.startsWith("meta/");
}

function userlandCallerKind(kind: string): "panel" | "app" | "worker" | "do" | "extension" | null {
  if (
    kind === "panel" ||
    kind === "app" ||
    kind === "worker" ||
    kind === "do" ||
    kind === "extension"
  ) {
    return kind;
  }
  return null;
}

function metaChangeSummary(candidate: MainAdvanceApprovalCandidate): string {
  const metaPaths = candidate.changedPaths.filter(isMetaPath);
  return metaPaths.length === 0
    ? "workspace config change"
    : metaPaths.length === 1
      ? `${metaPaths[0]} changed`
      : `${metaPaths.length} workspace config files changed`;
}

/**
 * The heading for a publication that changes what code in this workspace can
 * do (§7.4).
 *
 * This is the agent-edits-its-own-code case, and its question is not "may this
 * run" — the code is already here — but "someone edited this part; do you want
 * the new version?". So it names the parts rather than counting privileges.
 */
function unitChangeTitle(
  units: ReviewedUnit[],
  previousRequests: ReadonlyMap<string, readonly UnitAuthorityRequest[]>,
  metaChanged: boolean
): string {
  if (units.length === 0)
    return metaChanged ? "Change workspace settings" : "Update workspace main";
  const added = units.filter((unit) => !previousRequests.has(unit.source.repo));
  if (units.length === 1) {
    const unit = units[0]!;
    const name = unit.displayName || unit.unitName;
    return added.length === 1 ? `Add ${name}?` : `${name} changed`;
  }
  if (added.length === units.length) return `Add ${units.length} workspace parts?`;
  return `${units.length} parts changed`;
}

function unitChangeDescription(
  units: ReviewedUnit[],
  previousRequests: ReadonlyMap<string, readonly UnitAuthorityRequest[]>,
  metaChanged: boolean
): string {
  if (units.length === 0) {
    return metaChanged
      ? "This changes settings that affect how your workspace starts and runs."
      : "This advance moves workspace main.";
  }
  const allAdded = units.every((unit) => !previousRequests.has(unit.source.repo));
  if (allAdded) {
    const added =
      units.length === 1
        ? "This adds a new part to your workspace."
        : "This adds new parts to your workspace.";
    return metaChanged ? `${added} It also changes workspace settings.` : added;
  }
  const edited =
    units.length === 1
      ? "Someone edited this part in your workspace."
      : "Someone edited these parts in your workspace.";
  return metaChanged ? `${edited} It also changes workspace settings.` : edited;
}

function mainAdvanceTitle(_candidate: MainAdvanceApprovalCandidate): string {
  return "Update workspace main";
}

function mainAdvanceDescription(candidate: MainAdvanceApprovalCandidate): string {
  return `This advance moves workspace main and changes ${pathCountSummary(candidate.changedPaths)}.`;
}

function mainAdvanceDetails(
  candidate: MainAdvanceApprovalCandidate
): Array<{ label: string; value: string }> {
  return [
    {
      label: candidate.repoPaths.length === 1 ? "Repo" : "Repos",
      value: candidate.repoPaths.join(", "),
    },
    ...(candidate.via ? [{ label: "Via", value: candidate.via }] : []),
    { label: "State", value: candidate.stateHash },
    { label: "Changes", value: changedPathsSummary(candidate.changedPaths) },
  ];
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
import * as fs from "node:fs";
