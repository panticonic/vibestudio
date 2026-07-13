/**
 * WorkspaceVcs — the server-side orchestration layer over {@link WorktreeStore}.
 *
 * One instance per server. Owns:
 *  - the main-head working tree (the user's workspace directory),
 *  - context-folder heads (`ctx:{contextId}` forks materialized under
 *    `.contexts/`),
 *  - per-state build-source checkouts (P1 cache: hardlinked from the CAS,
 *    deletable at any time),
 *  - the builds provenance log (`builds:workspace`),
 *  - the `state-advanced` event stream the build trigger subscribes to.
 *
 * Implements buildV2's `WorkspaceStateSource` and the builder's
 * `BuildSourceProvider`.
 */

import { EventEmitter } from "events";
import { serializeByKey } from "@vibestudio/shared/keyedSerializer";
import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { TextDecoder } from "node:util";

import {
  blobPath,
  collectTreeReachableDigests,
  diffTrees,
  getBytes,
  materializeTree,
  pruneUnreferencedTreeObjects,
  readFileAtTree,
  resolveTreePath,
  type TreeDiff,
} from "../services/blobstoreService.js";
import { type ProtectedRefStore, type RefChange } from "../services/protectedRefStore.js";
import type {
  BuildRecord,
  StateAdvancedEvent,
  WorkingAdvancedEvent,
  WorkspaceStateSource,
} from "../buildV2/stateTrigger.js";
import type { BuildSourceProvider } from "../buildV2/buildSource.js";
import type { RepoPushValidator, RepoBuildReport } from "../buildV2/index.js";
import {
  discoverPackageGraph,
  type GraphNode,
  type PackageGraph,
} from "../buildV2/packageGraph.js";
import { CONTAINER_SECTIONS, FLAT_SECTIONS } from "@vibestudio/shared/runtime/entitySpec";
import {
  CONTEXT_MARKER_FILE,
  VCS_MAIN_HEAD,
  contextIdFromVcsHead,
  logIdForRepo,
  normalizeRepoPathForLog,
  joinRepoPrefix,
  vcsContextHead,
  vcsLogActor,
} from "./paths.js";
import { WorktreeStore } from "./worktreeStore.js";
import { discoverRepos, type DiscoveredRepo } from "./repoDiscovery.js";
import { EMPTY_STATE_HASH } from "@vibestudio/shared/contentTree/worktreeHash";
import { DiskProjector } from "./diskProjector.js";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { VcsGadCaller } from "./gadCaller.js";
import { WorkspaceRepositories } from "./workspaceRepositories.js";
import { WorkspaceVcsMemory } from "./workspaceVcsMemory.js";

type SnapshotResult = Awaited<ReturnType<WorktreeStore["snapshotDir"]>>;

/**
 * Wire shapes of the gad DO's `computeMerge` (implemented by the userland
 * `@workspace/vcs-engine`). The merge SEMANTICS live in userland; the host
 * only orchestrates the returned file set (stage/park/materialize/ref).
 */
interface MergeConflict {
  path: string;
  kind: "content" | "binary" | "delete-vs-change" | "mode";
}

interface MergeComputation {
  status: "clean" | "conflicted" | "up-to-date" | "fast-forward";
  files: Array<{ path: string; contentHash: string; size: number; mode: number }>;
  conflicts: MergeConflict[];
  baseStateHash: string | null;
}

/** A raw row returned by a gad-store read RPC (snake_case columns). */

const BUILDS_LOG_ID = "builds:workspace";
const SYSTEM_ACTOR = { id: "system", kind: "system" } as const;
const USER_ACTOR = { id: "user", kind: "user" } as const;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

interface WorkspaceVcsDeps {
  blobsDir: string;
  /** The persistent source dir. In dev this is the real monorepo checkout that
   *  a push to `main` extracts back into ({@link extractMainToSource}); it is
   *  also read once at boot to seed `main` refs (`ensureRepoLogsFromDisk`). */
  workspaceRoot: string;
  /**
   * Dev extraction gate (Phase-2 revision §3). When true, a push to `main`
   * projects each advanced repo's new state OUT to `workspaceRoot/{repoPath}`
   * (write-only, via {@link DiskProjector.exportMainToSource}) so dev-session
   * changes flow back into the monorepo. Off in production ephemeral workspaces,
   * which have no persistent source dir to extract to. `main` remains a pure ref
   * for all VCS logic either way — this is a one-way bridge, never a checkout.
   */
  extractMainToSource?: boolean;
  /** Root for context-folder working trees (`{contextsRoot}/{contextId}`). */
  contextsRoot: string;
  /**
   * Active workspace id, stamped into the per-context marker
   * (`.vibestudio-context.json`) written at folder materialization.
   */
  workspaceId: string;
  /**
   * Resolve the loopback HTTP(S) server base URL the server advertises to same-host
   * CLI/agent processes, or undefined if the gateway port is not finalized yet.
   * Written into the per-context marker (§6.2). A getter because the port is
   * only known post-listen, well after WorkspaceVcs is constructed.
   */
  getServerUrl?: () => string | undefined;
  /** Root for per-state build-source checkouts. */
  buildSourcesRoot: string;
  /**
   * The server-owned protected-ref store — THE single authority for every
   * repo's `main`. All main reads resolve through it and all main advances go
   * through its gated group compare-and-swap (`updateMains`); the gad store keeps the
   * commit/provenance chain but is no longer the main-head authority.
   */
  refs: ProtectedRefStore;
  /**
   * Host-side on-behalf-of invocation table (narrow-host-vcs §4). A narrow
   * host-authored metadata publication dispatches to the writer DO outside the
   * token-minting RPC relay, so it mints a record here and threads the token to
   * `vcsPublishHostMutation`. The protected-ref gate can then attribute the
   * advance to the verified originating caller rather than the writer DO.
   */
  vcsInvocations?: import("../services/vcsInvocationTable.js").VcsInvocationTable;
  /** The single-writer vcs DO identity for a minted invocation's `via` field. */
  getVcsWriterIdentity?: () => string | null;
}

interface CommitResult extends SnapshotResult {
  head: string;
  changedPaths: string[];
}

type VcsFileWriteContent = { kind: "text"; text: string } | { kind: "bytes"; base64: string };

type VcsFileReadContent = { kind: "text"; text: string } | { kind: "bytes"; base64: string };

interface VcsFileContent {
  content: VcsFileReadContent;
  stateHash: string;
  contentHash: string;
  mode: number;
  size: number;
}

type StateAdvanceEditOp = NonNullable<StateAdvancedEvent["editOps"]>[number];

interface WorkspaceGcRoots {
  rootStateHashes: string[];
  protectedBlobDigests: string[];
  protectedTreeDigests: string[];
}

/**
 * The canonical edit input for `edit` — an op union, not bare hunks, so
 * file create/overwrite/delete/mode aren't smuggled through fake text ranges.
 * `replace` hunks are exact ranges into the base file (offsets in the base
 * content the author saw); callers resolve any fuzzy matching before submitting.
 */
type EditOp =
  | {
      kind: "replace";
      path: string;
      hunks: Array<{ start: number; end: number; oldText?: string; newText: string }>;
    }
  | { kind: "write"; path: string; content: VcsFileWriteContent; mode?: number }
  | { kind: "create"; path: string; content: VcsFileWriteContent; mode?: number }
  | { kind: "delete"; path: string }
  | { kind: "chmod"; path: string; mode: number };

/** Wire result of the gad-store DO's `applyEditOps` / `revertWorking` — the
 *  DO-composed working advance the host follows with a disk projection. */
interface AppliedEditOpsResult {
  editSeq: number;
  stateHash: string;
  baseStateHash: string;
  changedPaths: string[];
}

/** Result of {@link WorkspaceVcs.recordEdit} — a tracked WORKING edit (no commit
 *  head advance, no `vcs.log` entry, no build). */
interface RecordEditResult {
  head: string;
  /** The working state hash (committed base + uncommitted ops) projected to disk. */
  stateHash: string;
  committed: false;
  status: "uncommitted";
  /** The shared per-call edit sequence assigned to this edit's ops. */
  editSeq: number;
  changedPaths: string[];
}

/** Result of {@link WorkspaceVcs.commit}. */
interface CommitEditsResult {
  head: string;
  stateHash: string;
  eventId: string | null;
  headHash: string | null;
  /** Number of edit-op rows folded into this commit. */
  editCount: number;
  status: "committed" | "unchanged";
  changedPaths: string[];
  /** Actors other than the committer whose working edits this commit sealed
   *  (shared context heads) — provenance keeps both parties. */
  coAuthors?: Array<{ id: string; kind: string; subject?: { userId?: string } }>;
}

/** A commit on the source head not yet on the target — the upstream-commit shape
 *  shared by `vcs.merge` and the push-divergence error. */
interface UpstreamCommit {
  eventId: string;
  message: string;
  stateHash: string;
  createdAt: string | null;
}

/** Result of the explicit merge reconcile ({@link WorkspaceVcs.mergeHeads}). */
interface MergeReconcileResult {
  status: "up-to-date" | "merged" | "conflicted";
  stateHash: string | null;
  conflicts: MergeConflict[];
  mergeable: "clean" | "conflict";
  upstreamCommits: UpstreamCommit[];
  conflictPaths?: string[];
}

type GadMergeOutcome =
  | {
      status: "up-to-date";
      stateHash: string;
      conflicts: [];
      mergeable: "clean";
      upstreamCommits: UpstreamCommit[];
    }
  | {
      status: "merged";
      stateHash: string;
      eventId: string;
      headHash: string;
      previousStateHash: string;
      conflicts: [];
      mergeable: "clean";
      upstreamCommits: UpstreamCommit[];
    }
  | {
      status: "conflicted";
      stateHash: string;
      conflicts: MergeConflict[];
      mergeable: "conflict";
      conflictPaths: string[];
      theirsHead: string;
      upstreamCommits: UpstreamCommit[];
    };

function readContentFromBytes(bytes: Buffer): VcsFileReadContent {
  try {
    const text = UTF8_DECODER.decode(bytes);
    if (!text.includes("\u0000")) return { kind: "text", text };
  } catch {
    // Fall through to binary transport.
  }
  return { kind: "bytes", base64: bytes.toString("base64") };
}

/** True when a DO dispatch failed because the method is not (yet) registered —
 *  the host surfaces such a miss as a 404 "Unknown method" from doDispatch. Lets
 *  a scheduler call an @rpc whose DO implementation lands in a later wave
 *  without failing until it does. */
function isUnknownDoMethodError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Unknown method|dispatch failed \(404\)/.test(message);
}

interface LocalWorkspaceState {
  stateHash: string;
  subtreeHash(path: string): string | null;
}

/**
 * Bootstrap design: the build system must run BEFORE workerd (it builds the
 * gad-store worker itself), so WorkspaceVcs starts in local-first mode —
 * hashing the working tree with the shared worktree-hash implementation
 * (byte-identical to the DO's) and mirroring the scanned tree into the
 * content store, which then serves build sources exactly as it does
 * post-attach. `attachGad()` later ingests the pending local state; the
 * state hash is unchanged by construction, so no EV churn and no rebuilds
 * happen at the handover.
 */
export class WorkspaceVcs implements WorkspaceStateSource, BuildSourceProvider {
  readonly worktrees: WorktreeStore;
  readonly repositories: WorkspaceRepositories;
  readonly memory: WorkspaceVcsMemory;
  private gadCaller: VcsGadCaller | null = null;
  private readonly emitter = new EventEmitter();
  /** Last known state per head — diff basis for changedPaths. */
  private readonly lastState = new Map<string, string>();
  /** Serialize snapshots per directory (concurrent scans of one tree race). */
  private readonly snapshotLocks = new Map<string, Promise<unknown>>();
  private ensureFreshInFlight: Promise<{ stateHash: string }> | null = null;
  /** Local main-head state served while the gad store is unreachable. */
  private localMain: LocalWorkspaceState | null = null;
  /**
   * Attach-time disk adoption seeds the protected-ref table from the already
   * scanned source tree. Those seed rows are not authored workspace advances;
   * letting them flow through `onMainsUpdated` exposes partial repo sets while
   * bootstrap is still walking the workspace.
   */
  private suppressMainRefReactions = 0;
  /**
   * The disk-projection FOLLOWER (P5c): the one module that writes working
   * trees. Every operation path invokes it POST-advance with the state hash
   * the (userland) VCS semantics decided on; no projection logic is inlined
   * in operations and the projector never decides what a tree should be.
   */
  private readonly projector: DiskProjector;

  constructor(private readonly deps: WorkspaceVcsDeps) {
    const gadBridge: VcsGadCaller = {
      call: <T>(method: string, input: unknown, opts?: { invocationToken?: string }) => {
        if (!this.gadCaller) {
          return Promise.reject(
            new Error(`gad store not attached yet (call to ${method} during bootstrap)`)
          );
        }
        return this.gadCaller.call<T>(method, input, opts);
      },
    };
    this.worktrees = new WorktreeStore({
      blobsDir: deps.blobsDir,
      gad: gadBridge,
    });
    this.projector = new DiskProjector({
      worktrees: this.worktrees,
      workspaceRoot: deps.workspaceRoot,
      contextsRoot: deps.contextsRoot,
    });
    this.repositories = new WorkspaceRepositories({
      blobsDir: deps.blobsDir,
      refs: deps.refs,
      worktrees: this.worktrees,
      discoverGraph: (stateHash) => this.discoverGraph(stateHash),
    });
    this.memory = new WorkspaceVcsMemory({
      blobsDir: deps.blobsDir,
      gad: gadBridge,
      isAttached: () => this.attached,
      subscribeStateAdvanced: (listener) => this.onStateAdvanced(listener),
      discoverRepositories: () => this.repositories.discover(),
      resolveMain: (repoPath) => this.resolveHead(VCS_MAIN_HEAD, repoPath),
      diffStates: (leftStateHash, rightStateHash) => this.diffStates(leftStateHash, rightStateHash),
      worktrees: this.worktrees,
    });
    // Register the SINGLE post-advance reaction on the shared protected-ref
    // store (narrow-host P3): every successful updateMains drives source export
    // (when enabled) plus the build trigger from HERE. No operation path re-does
    // these effects.
    this.deps.refs.onRefsChanged((changes) => {
      if (this.suppressMainRefReactions > 0) return;
      return this.onMainsUpdated(changes);
    });
  }

  /**
   * Post-advance reaction (narrow-host P3 item 1). Fired once per successful
   * `refs.updateMains` batch, after the swap commits. For each changed repo it
   * updates the optional one-way dev source export and emits the `state-advanced`
   * event consumed by the build trigger. `main` remains a pure ref with no
   * checkout. Batches once: the composed workspace view is computed a single time. The
   * provenance commit identity (`eventId`/`headHash`) is NOT available here —
   * provenance is recorded downstream (gad-owned, eventual), so main-advance
   * events now carry null commit identity. Best-effort per repo: a projection
   * failure is logged and never fails the already-committed advance.
   */
  private async onMainsUpdated(changes: RefChange[]): Promise<void> {
    if (!this.attached) return;
    let workspaceStateHash: string;
    try {
      workspaceStateHash = (await this.repositories.workspaceView()).stateHash;
    } catch (error) {
      console.error("[Vcs] onMainsUpdated: failed to compose workspace view:", error);
      return;
    }
    // `main` is a pure ref (D1): a main advance is always a plain state
    // replacement from the consumer's view. Operation classification (the old
    // `operation → transitionKind` shard) is DO-owned semantics the host no
    // longer inspects — every main advance is a snapshot transition here.
    // Provenance/attribution (writer/onBehalfOf) also moved to the DO; the dumb
    // `onRefsChanged` signal carries no principal, so the host emits a neutral
    // (null) actor and the DO owns advance attribution.
    const transitionKind: StateAdvancedEvent["transitionKind"] = "snapshot";
    for (const change of changes) {
      const repoPath = normalizeRepoPathForLog(change.repoPath);
      const logId = logIdForRepo(repoPath);
      const sk = this.stateKey(logId, VCS_MAIN_HEAD);
      // The dumb signal carries only the NEW value; recover the prior state from
      // the local cache (updated below) so the emitted diff is precise. Absent
      // (cold cache) ⇒ null, which stateAdvancedEvent treats as an all-added diff.
      const previousStateHash = this.lastState.get(sk) ?? null;
      try {
        if (change.stateHash === null) {
          // Delete: the repo left the workspace. This reaction is THE
          // exactly-once host effect for a committed deletion (narrow-host P4):
          // drop the state cache, remove the on-disk projection, and emit a
          // workspace-rooted removal advance (the repo diffed old→empty) so the
          // build trigger / tree scanner re-discover without it. The gad-owned
          // lifecycle has already archived the lineage before committing this
          // ref deletion; this reaction owns only the resulting host effects.
          this.lastState.delete(sk);
          // Dev extraction (§3): drop the repo's subtree from the source dir on a
          // `main` removal, the counterpart of exportMainToSource. Gated — a
          // production ephemeral workspace has no source dir to extract to.
          if (this.deps.extractMainToSource) {
            await this.projector.removeRepo(repoPath);
          }
          const removalEvent = await this.stateAdvancedEvent({
            head: VCS_MAIN_HEAD,
            previousStateHash,
            stateHash: EMPTY_STATE_HASH,
            eventId: null,
            headHash: null,
            actor: null,
            transitionKind,
            repoPath,
            workspaceStateHash,
          });
          this.emitter.emit("state-advanced", removalEvent);
          continue;
        }
        this.lastState.set(sk, change.stateHash);
        // D1: `main` has NO on-disk checkout for context logic. The ONLY disk
        // effect of a main advance is the write-only dev extraction (§3): project
        // the new main state OUT to the source dir (`workspaceRoot/{repoPath}`) so
        // a push flows back into the real monorepo. Gated on a configured source
        // dir (dev) — a production ephemeral workspace has nowhere to extract to.
        // This is a dedicated one-way export, NOT a `dirForRepoHead(main)` mapping;
        // `main` stays a pure ref everywhere else.
        if (this.deps.extractMainToSource) {
          await this.projector.exportMainToSource(repoPath, change.stateHash);
        }
        // Emit the build-driving `state-advanced` event so a push (main advance)
        // promotes the recorded EV baseline reactively via the build trigger.
        const advanceEvent = await this.stateAdvancedEvent({
          head: VCS_MAIN_HEAD,
          previousStateHash,
          stateHash: change.stateHash,
          eventId: null,
          headHash: null,
          actor: null,
          transitionKind,
          repoPath,
          workspaceStateHash,
        });
        this.emitter.emit("state-advanced", advanceEvent);
      } catch (error) {
        console.error(`[Vcs] onMainsUpdated: reaction failed for ${repoPath}:`, error);
      }
    }
  }

  get attached(): boolean {
    return this.gadCaller !== null;
  }

  /**
   * Attach the gad store once workerd is up. Drops the bootstrap local state,
   * then seeds every present repo's `main` log + protected ref from the on-disk
   * source dir (per-repo, see {@link ensureRepoLogsFromDisk}) — set-if-absent, so
   * idempotent across restarts and never moving an existing ref. The ref VALUE is
   * host-computed from disk (or the already-persisted ref store), never sourced
   * from the DO head rows.
   */
  async attachGad(gad: VcsGadCaller): Promise<void> {
    this.gadCaller = gad;
    if (this.localMain) {
      this.localMain = null;
      this.lastState.delete(VCS_MAIN_HEAD);
    }
    await this.withSuppressedMainRefReactions(() => this.ensureRepoLogsFromDisk());
    // Attach-time publish-intent heal is GAD-owned. The DO records every main
    // advance synchronously in its publish path (push/import) and replays any
    // parked publish intents with full provenance here; remaining no-intent ref
    // drift is fatal, because refs alone cannot reconstruct the missing authored
    // transition.
    await this.gad().call("vcsHealPublishDrift", {});
  }

  // -------------------------------------------------------------------------
  // Protected main refs (ProtectedRefStore) — the single main-head authority
  // -------------------------------------------------------------------------

  /** The authoritative `main` state of a repo, from the protected-ref store. */
  private mainRefState(repoPath: string): string | null {
    return this.deps.refs.readMain(normalizeRepoPathForLog(repoPath))?.stateHash ?? null;
  }

  // -------------------------------------------------------------------------
  // Heads / dirs
  // -------------------------------------------------------------------------

  private contextDir(contextId: string): string {
    return this.projector.contextDir(contextId);
  }

  // -------------------------------------------------------------------------
  // Per-repo routing (W2)
  //
  // Every repo (`packages/foo`, `panels/chat`, `projects/<vault>`, `meta`) has
  // its own GAD log `vcs:repo:<path>` with heads `main`/`ctx:*`. A repo's state
  // is subtree-rooted. There is no whole-tree log — every head is keyed by a
  // repoPath.
  // -------------------------------------------------------------------------

  /** Log id for a repo (per-repo VCS); there is no whole-tree log. */
  private repoLogId(repoPath: string): string {
    if (!repoPath) {
      throw new Error(
        "per-repo VCS: a repoPath is required (no whole-tree vcs:workspace log exists)"
      );
    }
    return logIdForRepo(repoPath);
  }

  /** Working-tree dir for a (repoPath, head) — the projector owns the layout. */
  private dirForRepoHead(repoPath: string, head: string): string {
    return this.projector.dirForRepoHead(repoPath, head);
  }

  /**
   * The disk-scan PRIMITIVE (host `worktree.scan` RPC) — resolve the
   * (repoPath, head) working tree and read it into the content store, returning
   * its content-addressed `{ stateHash, files }`. Pure and semantics-free: it
   * composes {@link DiskProjector.dirForRepoHead} with
   * {@link WorktreeStore.localState} (scan + hash + CAS-mirror + sidecar
   * refresh) and NOTHING ELSE — no commit, no ref advance, no gad-log append, no
   * DO round trip. The gad-store DO drives it to capture external disk drift and
   * owns every VCS decision made from the result.
   *
   * Head → dir mapping: every `ctx:*` head resolves through
   * {@link DiskProjector.dirForRepoHead} to its `.contexts/{id}/{repoPath}`
   * subtree checkout (there is no workspace-root mapping for context heads;
   * `main` has no checkout at all — D1). `updateSidecar` refreshes the `.gad`
   * baseline against which the NEXT scan diffs, so the scan reports only
   * genuine external drift. Un-projected DO working edits must be projected
   * to disk BEFORE a scan (the DO working state is authoritative); otherwise the
   * scan would read stale disk and misattribute the projected-but-not-yet-written
   * edits as deletions.
   */
  async scanWorktree(
    repoPath: string,
    head: string
  ): Promise<{
    stateHash: string;
    files: Array<{ path: string; contentHash: string; size: number; mode: number }>;
    /** Non-regular directory entries the scan skipped (symlinks, sockets, …)
     *  — NOT captured in the state; surfaced so callers can warn. */
    skipped: Array<{ path: string; kind: string }>;
    /** The scan found an existing-but-empty tree where the head previously had
     *  files — a whole-repo wipe. Drift adoption must not adopt this silently. */
    wipedRepo: boolean;
  }> {
    const dir = this.dirForRepoHead(repoPath, head);
    const { stateHash, files, skipped } = await this.worktrees.localState(dir, {
      updateSidecar: true,
    });
    const priorState = await this.worktrees.resolveWorktreeRef(head, this.repoLogId(repoPath));
    const wipedRepo = files.length === 0 && priorState !== null && priorState !== EMPTY_STATE_HASH;
    return { stateHash, files, skipped, wipedRepo };
  }

  /**
   * The disk-projection PRIMITIVE (host `worktree.project` RPC) — materialize a
   * content-addressed `stateHash` onto the (repoPath, head) working tree. Pure
   * and semantics-free: composes {@link DiskProjector.dirForRepoHead} with
   * {@link WorktreeStore.materializeState} (hardlink CAS tree onto disk) and
   * NOTHING ELSE — no commit, no ref advance, no gad-log append. The gad-store
   * DO drives it to re-materialize a restored/forked repo into a `ctx:{id}`
   * folder checkout; `main` is never projected here (D1 — the write-only source
   * export goes through {@link DiskProjector.exportMainToSource}). Best effort (a
   * disk hiccup never fails the DO saga — the checkout re-syncs on the next ctx
   * edit/scan).
   */
  async projectWorktree(
    repoPath: string,
    head: string,
    stateHash: string
  ): Promise<{ stateHash: string }> {
    await this.projector.project({ repoPath, head, stateHash, bestEffort: true });
    return { stateHash };
  }

  /** Compose a per-repo state key for `lastState` / lock maps. */
  private stateKey(logId: string, head: string): string {
    return `${logId}\x00${head}`;
  }

  private locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return serializeByKey(this.snapshotLocks, key, fn);
  }

  // -------------------------------------------------------------------------
  // Commit / scan
  // -------------------------------------------------------------------------

  /**
   * Snapshot a head's working tree. Emits `state-advanced` (with precise
   * changed paths) when the state moved. THE single write path for explicit
   * commits to `ctx:*` heads. `main` is NOT commitable here — it is a pure ref
   * that advances only through the gated push path (`refs.updateMains`,
   * DO-driven).
   */
  async commitHead(
    head: string,
    opts: {
      summary?: string;
      actor?: { id: string; kind: string };
      /** Repo the head lives on (per-repo VCS). */
      repoPath: string;
    }
  ): Promise<CommitResult> {
    if (head === VCS_MAIN_HEAD) {
      throw new Error(
        "commitHead: `main` is a pure ref — it advances only via push (refs.updateMains), " +
          "never by a host-side snapshot; adopt out-of-band disk edits into the active context head"
      );
    }

    const repoPath = opts.repoPath;
    const logId = this.repoLogId(repoPath);
    const sk = this.stateKey(logId, head);
    return this.locked(sk, async () => {
      const dir = this.dirForRepoHead(repoPath, head);
      const actor = opts.actor ?? USER_ACTOR;
      const prevState =
        this.lastState.get(sk) ?? (await this.worktrees.resolveWorktreeRef(head, logId));
      // A pending conflicted merge turns this commit into the merge
      // resolution: record the merge parents and the merge transition kind.
      const pending = this.attached
        ? (
            await this.gad().call<{
              info: {
                theirsStateHash: string;
                theirsEventId?: string | null;
                provisionalStateHash: string;
                materialized?: boolean;
              } | null;
            }>("getPendingMerge", { logId, head })
          ).info
        : null;
      // Recovery invariant: a pending merge whose conflict markers never
      // reached the worktree (crash between setPendingMerge and
      // materializeState) must be re-materialized before this commit —
      // otherwise the pre-merge tree would be recorded as the resolution and
      // the source side's changes silently dropped.
      if (pending && pending.materialized === false) {
        await this.projector.project({ repoPath, head, stateHash: pending.provisionalStateHash });
        await this.gad().call("setPendingMerge", {
          logId,
          head,
          info: { ...pending, materialized: true },
        });
      }
      const snap = await this.worktrees.snapshotDir(dir, {
        head,
        logId,
        actor,
        ...(opts.summary ? { summary: opts.summary } : {}),
        ...(pending
          ? {
              force: true,
              parentStateHashes: [pending.theirsStateHash],
              ...(pending.theirsEventId ? { parentEventIds: [pending.theirsEventId] } : {}),
              eventKind: "state.merge_applied" as const,
            }
          : {}),
      });
      if (pending) {
        await this.gad().call("clearPendingMerge", { logId, head });
        await this.syncConflictSummary(head, repoPath);
      }
      this.lastState.set(sk, snap.stateHash);
      let changedPaths: string[] = [];
      if (!snap.unchanged) {
        const event = await this.stateAdvancedEvent({
          head,
          previousStateHash: prevState,
          stateHash: snap.stateHash,
          eventId: snap.eventId || null,
          headHash: snap.headHash || null,
          actor,
          transitionKind: pending ? "merge-resolution" : "snapshot",
          repoPath,
        });
        changedPaths = event.changedPaths;
        this.emitter.emit("state-advanced", event);
      }
      return { ...snap, head, changedPaths };
    });
  }

  // -------------------------------------------------------------------------
  // WorkspaceStateSource (buildV2 trigger)
  // -------------------------------------------------------------------------

  async ensureFresh(): Promise<{ stateHash: string }> {
    if (this.ensureFreshInFlight) return this.ensureFreshInFlight;
    this.ensureFreshInFlight = this.ensureFreshUncoalesced().finally(() => {
      this.ensureFreshInFlight = null;
    });
    return this.ensureFreshInFlight;
  }

  private async ensureFreshUncoalesced(): Promise<{ stateHash: string }> {
    if (!this.attached) {
      if (this.deps.refs.listMains().length > 0) {
        const view = await this.repositories.workspaceView();
        this.localMain = null;
        this.lastState.set(VCS_MAIN_HEAD, view.stateHash);
        return view;
      }
      // Bootstrap: hash locally (blobs enter the CAS), no DO involved.
      const local = await this.locked(VCS_MAIN_HEAD, () =>
        this.worktrees.localState(this.deps.workspaceRoot)
      );
      this.localMain = {
        stateHash: local.stateHash,
        subtreeHash: (p) => local.manifest.subtreeHash(p),
      };
      this.lastState.set(VCS_MAIN_HEAD, local.stateHash);
      return { stateHash: local.stateHash };
    }
    // Phase-2 revision §2/§7: there are no out-of-band disk edits to adopt (the
    // source dir is write-only + boot-seed). "Fresh" is simply the current `main`
    // view — the composed union of every repo's `main`, from refs + CAS. No scan,
    // no commit. Per-entity builds serve `resolveContextView(ctx:{id})` instead.
    return this.repositories.workspaceView();
  }

  /**
   * Per-unit content addresses at a state, resolved from the CONTENT STORE
   * (not the gad DO): a unit directory resolves to its `manifest:` subtree
   * hash, a file unit to its content hash, an absent path to null. These are
   * byte-identical to the shared reference implementation
   * (`buildWorktreeManifest().subtreeHash` — pinned by
   * workspaceVcs.unitHashes.test.ts), so buildV2 effective versions and build
   * keys were unchanged by the source swap off the DO.
   */
  async unitHashes(stateHash: string, relPaths: string[]): Promise<Record<string, string | null>> {
    if (relPaths.length === 0) return {};
    const localMain = this.localMain;
    if (!this.attached && localMain && localMain.stateHash === stateHash) {
      // Bootstrap (pre-DO-attach): the local scan's in-memory manifest is the
      // same hash space; avoids tree-node reads for every unit.
      return Object.fromEntries(
        relPaths.map((relPath) => [relPath, localMain.subtreeHash(relPath)])
      );
    }
    await this.worktrees.ensureStateMirrored(stateHash);
    const out: Record<string, string | null> = {};
    for (const relPath of relPaths) {
      const resolved = await resolveTreePath(this.deps.blobsDir, stateHash, relPath);
      out[relPath] =
        resolved === null
          ? null
          : resolved.kind === "dir"
            ? resolved.treeHash
            : resolved.contentHash;
    }
    return out;
  }

  async resolveHead(head: string, repoPath?: string): Promise<string | null> {
    if (!repoPath && !this.attached && head === VCS_MAIN_HEAD) {
      if (this.localMain) return this.localMain.stateHash;
      if (this.deps.refs.listMains().length > 0) {
        return (await this.repositories.workspaceView()).stateHash;
      }
      return null;
    }
    if (!repoPath) {
      throw new Error(`resolveHead: repoPath is required for named ref ${JSON.stringify(head)}`);
    }
    if (head === VCS_MAIN_HEAD) {
      return this.mainRefState(repoPath);
    }
    return await this.worktrees.resolveWorktreeRef(head, this.repoLogId(repoPath));
  }

  async discoverGraph(stateHash: string): Promise<PackageGraph> {
    const sourceRoot = await this.materializeStateForGraphDiscovery(stateHash);
    return discoverPackageGraph(sourceRoot);
  }

  private gad(): VcsGadCaller {
    if (!this.gadCaller) throw new Error("gad store not attached");
    return this.gadCaller;
  }

  /**
   * Three-way merge computed IN THE GAD DO (`computeMerge`, backed by the
   * userland `@workspace/vcs-engine`). Merge inputs must satisfy the mirroring
   * invariant (they do — every handed-out state resolves to a mirrored tree);
   * the DO lists locally-recorded states from its manifest index and falls
   * back to the content store for server-minted ones.
   */
  private async computeMerge(
    oursStateHash: string,
    theirsStateHash: string,
    labels: { ours: string; theirs: string }
  ): Promise<MergeComputation> {
    return await this.gad().call<MergeComputation>("computeMerge", {
      oursStateHash,
      theirsStateHash,
      labels,
    });
  }

  /**
   * Authoritative diff between two states over the CONTENT STORE (Merkle
   * `diffTrees`; the gad DO is not consulted). Lazily mirrors both sides.
   */
  async diffStates(leftStateHash: string, rightStateHash: string): Promise<TreeDiff> {
    await this.worktrees.ensureStateMirrored(leftStateHash);
    await this.worktrees.ensureStateMirrored(rightStateHash);
    return diffTrees(this.deps.blobsDir, leftStateHash, rightStateHash);
  }

  private async diffFileChanges(
    leftStateHash: string | null,
    rightStateHash: string
  ): Promise<StateAdvancedEvent["fileChanges"]> {
    const diff = await this.diffStates(leftStateHash ?? EMPTY_STATE_HASH, rightStateHash);
    return [
      ...diff.added.map((file) => ({
        kind: "added" as const,
        path: file.path,
        oldContentHash: null,
        newContentHash: file.contentHash,
        oldMode: null,
        newMode: file.mode,
      })),
      ...diff.removed.map((file) => ({
        kind: "removed" as const,
        path: file.path,
        oldContentHash: file.contentHash,
        newContentHash: null,
        oldMode: file.mode,
        newMode: null,
      })),
      ...diff.changed.map((file) => ({
        kind: "changed" as const,
        path: file.path,
        oldContentHash: file.fromContentHash,
        newContentHash: file.toContentHash,
        oldMode: file.fromMode,
        newMode: file.toMode,
      })),
    ];
  }

  private async stateAdvancedEvent(input: {
    head: string;
    previousStateHash: string | null;
    stateHash: string;
    eventId: string | null;
    headHash: string | null;
    actor: { id: string; kind: string } | null;
    transitionKind: StateAdvancedEvent["transitionKind"];
    editOps?: StateAdvanceEditOp[];
    workspaceStateHash?: string;
    /** The diff/state are subtree-rooted on this repo's log; the event is
     *  re-rooted to workspace-relative for the build trigger: changed paths
     *  get the repo prefix and `stateHash` becomes the composed workspace view. */
    repoPath: string;
  }): Promise<StateAdvancedEvent> {
    const fileChanges =
      input.previousStateHash === input.stateHash
        ? []
        : await this.diffFileChanges(input.previousStateHash, input.stateHash);

    // Per-repo advance: re-root the subtree-relative diff to workspace-relative
    // and point the build trigger at the composed workspace view, so
    // unitsForChangedPaths/buildUnit run against a workspace-rooted state and a
    // subtree-rooted repo state never reaches them directly.
    const repoPath = input.repoPath;
    const reroot = (p: string): string => joinRepoPrefix(repoPath, p);
    // The build trigger discovers the graph + EV-diffs against `stateHash` and
    // `sinceStateHash` as WORKSPACE-ROOTED states — a subtree-rooted repo state
    // must never reach it. For `main` advances use the composed workspace view;
    // for a context (`ctx:*`) advance use the composed CONTEXT view (the pinned
    // base with this context's ctx heads overlaid) so a context build sees its
    // own edits. `sinceStateHash` is the same composed view with the edited repo
    // at its prior state, for a precise per-edit changeset.
    const ctxId = input.head.startsWith("ctx:") ? input.head.slice("ctx:".length) : null;
    const workspaceStateHash =
      input.head === VCS_MAIN_HEAD
        ? (input.workspaceStateHash ??
          (await this.repositories.workspaceViewWithRepoAt(repoPath, input.stateHash)))
        : ctxId
          ? await this.resolveContextView(ctxId)
          : input.stateHash;
    const sinceStateHash =
      input.head === VCS_MAIN_HEAD
        ? await this.repositories.workspaceViewWithRepoAt(repoPath, input.previousStateHash)
        : ctxId
          ? await this.gad()
              .call<{ stateHash: string }>("vcsComposedViewWithRepoAt", {
                contextId: ctxId,
                repoPath,
                repoStateHash: input.previousStateHash,
              })
              .then((r) => r.stateHash)
          : input.previousStateHash;
    return {
      head: input.head,
      stateHash: workspaceStateHash,
      // The build trigger's `stateHash` is the composed view above; clients
      // correlating with edit/readFile/revert returns need the raw
      // subtree-rooted repo state, which is `input.stateHash` here.
      repoStateHash: input.stateHash,
      sinceStateHash,
      eventId: input.eventId,
      headHash: input.headHash,
      actor: input.actor,
      transitionKind: input.transitionKind,
      repoPath,
      changedPaths: fileChanges.map((change) => reroot(change.path)),
      fileChanges: fileChanges.map((change) => ({ ...change, path: reroot(change.path) })),
      editOps: (input.editOps ?? []).map((op) => ({ ...op, path: reroot(op.path) })),
    };
  }

  onStateAdvanced(cb: (event: StateAdvancedEvent) => void): () => void {
    this.emitter.on("state-advanced", cb);
    return () => this.emitter.off("state-advanced", cb);
  }

  /** Subscribe to UNCOMMITTED working-content advances (recordEdit). Distinct
   *  from `state-advanced`: the build trigger ignores these; reactive views and
   *  dirty indicators consume them. */
  onWorkingAdvanced(cb: (event: WorkingAdvancedEvent) => void): () => void {
    this.emitter.on("working-advanced", cb);
    return () => this.emitter.off("working-advanced", cb);
  }

  async recordBuild(record: BuildRecord): Promise<void> {
    if (!this.attached) return; // bootstrap builds re-record after attach if rebuilt
    await this.gad().call("appendLogEvent", {
      logId: BUILDS_LOG_ID,
      head: "main",
      logKind: "builds",
      events: [
        {
          envelopeId: `build:${record.buildKey}:${record.status}`,
          actor: SYSTEM_ACTOR,
          payloadKind: "build.completed",
          payload: {
            protocol: "agentic.trajectory.v1",
            inputStateHash: record.inputStateHash,
            unitName: record.unitName,
            subtree: record.subtree,
            ev: record.ev,
            buildKey: record.buildKey,
            status: record.status,
            ...(record.error ? { error: record.error } : {}),
          },
        },
      ],
    });
  }

  // -------------------------------------------------------------------------
  // BuildSourceProvider (builder)
  // -------------------------------------------------------------------------

  /**
   * Materialize each unit's subtree at `stateRef` into the per-state
   * build-source dir straight from the CONTENT STORE (`materializeTree` per
   * unit subtree — no gad-DO manifest queries). The dir is per-state and
   * immutable, so an existing file is trusted as already-correct;
   * non-executables hardlink from the CAS (build sources are never edited).
   * Works identically pre-attach: every state hash handed out is mirrored
   * (bootstrap `localState` mirrors eagerly; `ensureStateMirrored` is one
   * stat when the tree is present).
   */
  async materializeForBuild(
    units: GraphNode[],
    stateRef: string,
    _workspaceRoot: string
  ): Promise<{ sourceRoot: string }> {
    const stateHash = await this.resolveStateRef(stateRef);
    const dirName = crypto.createHash("sha256").update(stateHash).digest("hex").slice(0, 24);
    const sourceRoot = path.join(this.deps.buildSourcesRoot, dirName);
    const prefixes = units.map((unit) => unit.relativePath);
    await this.locked(`build-src:${dirName}`, async () => {
      await this.worktrees.ensureStateMirrored(stateHash);
      for (const prefix of prefixes) {
        const resolved = await resolveTreePath(this.deps.blobsDir, stateHash, prefix);
        if (!resolved) continue; // unit absent at this state — nothing to materialize
        if (resolved.kind === "file") {
          throw new Error(
            `materializeForBuild: unit path ${JSON.stringify(prefix)} resolves to a file at ` +
              `${stateHash}; build units are directories`
          );
        }
        await materializeTree(
          this.deps.blobsDir,
          resolved.treeHash,
          path.join(sourceRoot, ...prefix.split("/"))
        );
      }
    });
    return { sourceRoot };
  }

  /** Full checkout of a state for package-graph discovery — `materializeTree`
   *  of the state root from the content store into a per-state dir (immutable,
   *  hardlinked, no sidecar — the dir is keyed by the state hash). */
  private async materializeStateForGraphDiscovery(stateHash: string): Promise<string> {
    const dirName = crypto
      .createHash("sha256")
      .update(`graph:${stateHash}`)
      .digest("hex")
      .slice(0, 24);
    const sourceRoot = path.join(this.deps.buildSourcesRoot, `graph-${dirName}`);
    await this.locked(`build-graph:${dirName}`, async () => {
      await this.worktrees.ensureStateMirrored(stateHash);
      await materializeTree(this.deps.blobsDir, stateHash, sourceRoot);
    });
    return sourceRoot;
  }

  /** Resolve `state:…` hashes verbatim; head names to their current state on
   *  the given repo's log. A bare head name requires a repoPath (per-repo VCS —
   *  there is no whole-tree head to resolve). */
  private async resolveStateRef(stateRef: string, repoPath?: string): Promise<string> {
    if (stateRef.startsWith("state:")) return stateRef;
    const resolved = await this.resolveHead(stateRef, repoPath);
    if (!resolved) throw new Error(`Unknown vcs ref: ${stateRef}`);
    return resolved;
  }

  // -------------------------------------------------------------------------
  // Context folders (GAD branches)
  // -------------------------------------------------------------------------

  // ── Context state ownership (P5d) ─────────────────────────────────────
  // A context's VCS SEMANTICS — durable pinned base, composed working view,
  // per-repo status, rebase, teardown — live in the gad-store DO behind the
  // userland `vcs` service (`vcsPinContext` / `vcsResolveContextView` /
  // `vcsContextStatus` / `vcsRebaseContext` / `vcsDropContext` /
  // `vcsContextRepoStates`). The host keeps ONLY the disk side: sparse
  // materialization tracking (which repo subtree is on disk at which state)
  // and the projector writes. Everything below is dispatch + follower.

  /** Sparse-materialization tracking: contextId → (repoPath → on-disk state). */
  private readonly contextMaterialized = new Map<string, Map<string, string>>();

  private materializedFor(contextId: string): Map<string, string> {
    let m = this.contextMaterialized.get(contextId);
    if (!m) {
      m = new Map();
      this.contextMaterialized.set(contextId, m);
    }
    return m;
  }

  /** Record that a repo's subtree was (re)materialized on disk for a context
   *  at `stateHash` — called by every path that projects into a context
   *  folder, so the sparse tracking stays fresh without a redundant write. */
  private noteContextMaterialized(contextId: string, repoPath: string, stateHash: string): void {
    this.materializedFor(contextId).set(normalizeRepoPathForLog(repoPath), stateHash);
  }

  /** Pin (or re-pin) a context's base view (gad-store `vcsPinContext`). */
  async pinContext(contextId: string, baseView?: string): Promise<string> {
    const result = await this.gad().call<{ baseView: string }>("vcsPinContext", {
      contextId,
      ...(baseView !== undefined ? { baseView } : {}),
    });
    return result.baseView;
  }

  /**
   * Make a newly-created main repo immediately visible in one existing
   * context without moving that context's pins for any other repo.
   */
  async adoptMainRepoIntoContext(contextId: string, repoPath: string): Promise<void> {
    await this.gad().call("vcsAdoptMainRepoIntoContext", { contextId, repoPath });
    await this.materializeContextRepos(contextId, [repoPath]);
  }

  /**
   * Fork a context's FILE state, LINEAGE-TRUE, for {@link runtime.cloneContext}
   * and subagent spawns — a thin wrapper over the gad-store DO `vcsForkContext`.
   *
   * The DO pins the child to the parent's inherited base, shares the parent's
   * committed state node per touched repo (so `getMergeBase` finds it for free),
   * copies the working (uncommitted) edit rows onto the child head, and records
   * fork provenance. Unlike the former snapshot-and-pin flatten, the child
   * INHERITS the source's per-repo ctx-head lineage: uncommitted stays
   * uncommitted, and a later merge back to the parent has a real merge-base.
   */
  async forkContext(sourceContextId: string, targetContextId: string): Promise<void> {
    await this.gad().call("vcsForkContext", { sourceContextId, targetContextId });
  }

  /** The context's pinned base view state, or null if never pinned. */
  async contextBaseView(contextId: string): Promise<string | null> {
    const base = await this.gad().call<{ stateHash?: string } | null>("getContextBase", {
      contextId,
    });
    return base?.stateHash ?? null;
  }

  /** The context's composed view (touched repos at their working content, the
   *  rest at the pinned base) — gad-store `vcsResolveContextView`. */
  async resolveContextView(contextId: string): Promise<string> {
    const result = await this.gad().call<{ stateHash: string }>("vcsResolveContextView", {
      contextId,
    });
    return result.stateHash;
  }

  /** The state a repo should be on disk at for a context (its WORKING content;
   *  null when the repo doesn't exist anywhere) — gad-store `resolveWorkingState`. */
  async contextRepoState(contextId: string, repoPath: string): Promise<string | null> {
    const result = await this.gad().call<{ stateHash: string | null }>("resolveWorkingState", {
      logId: this.repoLogId(repoPath),
      head: vcsContextHead(contextId),
    });
    return result.stateHash;
  }

  /** True iff `repoPath`'s subtree is currently materialized on disk for the
   *  context. Backs the loud read-time assertion. HOST state — disk is ours. */
  isContextRepoMaterialized(contextId: string, repoPath: string): boolean {
    return this.materializedFor(contextId).has(normalizeRepoPathForLog(repoPath));
  }

  /**
   * Demand-materialize specific repos (or the whole view) into a context's
   * working folder. The DO decides WHICH repos and at WHAT states
   * (`vcsContextRepoStates` — section prefixes expand there); this host side
   * skips repos already on disk at the right state and projects the rest.
   */
  /**
   * The per-repo `{ repoPath, stateHash }` targets a context resolves to (the
   * DO's `vcsContextRepoStates`) WITHOUT touching disk — the read-side of the
   * projector, exposed for the `mirror` service (plan §6.5) so a remote CLI can
   * fetch the targets and stream the CAS tree itself.
   */
  async contextRepoTargets(
    contextId: string,
    repos: string[] | "all" = "all"
  ): Promise<Array<{ repoPath: string; stateHash: string }>> {
    return this.gad().call<Array<{ repoPath: string; stateHash: string }>>("vcsContextRepoStates", {
      contextId,
      repos,
    });
  }

  async materializeContextRepos(contextId: string, repos: string[] | "all"): Promise<void> {
    const targets = await this.contextRepoTargets(contextId, repos);
    const mat = this.materializedFor(contextId);
    // A workspace-root grep/find legitimately asks for every repo. Projection
    // is repo-isolated, so serially materializing a large workspace turns a
    // simple search into a 30s+ tool call. Use bounded concurrency while
    // retaining the existing per-repo lock. Re-check INSIDE that lock so two
    // parallel root searches coalesce instead of projecting every repo twice.
    const queue = targets.filter(
      ({ repoPath, stateHash }) => mat.get(normalizeRepoPathForLog(repoPath)) !== stateHash
    );
    const concurrency = Math.min(8, Math.max(1, queue.length));
    let cursor = 0;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        for (;;) {
          const index = cursor++;
          const target = queue[index];
          if (!target) return;
          const { repoPath, stateHash } = target;
          const norm = normalizeRepoPathForLog(repoPath);
          await this.locked(
            this.stateKey(this.repoLogId(repoPath), `mat:${contextId}`),
            async () => {
              if (mat.get(norm) === stateHash) return;
              await this.projector.project({
                repoPath,
                head: vcsContextHead(contextId),
                stateHash,
                clean: true,
              });
              mat.set(norm, stateHash);
            }
          );
        }
      })
    );
  }

  async ensureContextFolder(contextId: string): Promise<{ dir: string; head: string }> {
    const head = vcsContextHead(contextId);
    const dir = this.contextDir(contextId);
    // Sparse: ensure the folder EXISTS but materialize nothing — repos are
    // written on demand by `materializeContextRepos`.
    await fsp.mkdir(dir, { recursive: true });
    await this.writeContextMarker(contextId, dir);
    return { dir, head };
  }

  /**
   * Write the host-owned per-context marker (`.vibestudio-context.json`) at the
   * context folder root (docs/…channels-plan §6.2). Names the context so CLI +
   * agent scope resolution (cwd-upward search) binds to the right server,
   * workspace, and context with zero flags. Idempotent: only rewrites when the
   * on-disk contents drift (e.g. the advertised serverUrl changed across a
   * restart). Excluded from VCS projection/diff/edit via ALWAYS_IGNORED_FILES.
   */
  private async writeContextMarker(contextId: string, dir: string): Promise<void> {
    const marker: {
      contextId: string;
      workspaceId: string;
      serverUrl?: string;
    } = {
      contextId,
      workspaceId: this.deps.workspaceId,
    };
    const serverUrl = this.deps.getServerUrl?.();
    if (serverUrl) marker.serverUrl = serverUrl;
    const markerPath = path.join(dir, CONTEXT_MARKER_FILE);
    const next = `${JSON.stringify(marker, null, 2)}\n`;
    try {
      const current = await fsp.readFile(markerPath, "utf8");
      if (current === next) return; // no drift — leave it
    } catch {
      // missing/unreadable — (re)write below
    }
    await fsp.writeFile(markerPath, next);
  }

  /**
   * Teardown — drop ALL per-context state when a context retires. The durable
   * side (every `ctx:{contextId}` head + working edits + pending merges + the
   * pin row) dies in ONE place in the DO (`vcsDropContext`); this host side
   * clears its disk-tracking and per-head caches for the touched repos.
   */
  async dropContext(contextId: string): Promise<void> {
    const head = vcsContextHead(contextId);
    const result = await this.gad().call<{ repoPaths: string[] }>("vcsDropContext", { contextId });
    for (const repoPath of result.repoPaths) {
      this.lastState.delete(this.stateKey(this.repoLogId(repoPath), head));
    }
    this.contextMaterialized.delete(contextId);
  }

  /**
   * Rebase — pull the latest `main` into each edited repo, then RE-PIN the
   * base so unedited repos also advance. The SEMANTICS (dirty check, per-repo
   * merges, conflicted-pin rule) run in the DO (`vcsRebaseContext`); this
   * host side synchronizes main provenance first (the merges resolve main
   * through the protected ref) and then FOLLOWS each per-repo outcome:
   * project the merged/provisional state, acknowledge conflict
   * materialization, write summaries, and emit the state-advanced events.
   */
  async rebaseContext(
    contextId: string,
    actor: { id: string; kind: string } = SYSTEM_ACTOR
  ): Promise<{
    repos: Array<{ repoPath: string; status: "up-to-date" | "merged" | "conflicted" }>;
    baseView: string;
  }> {
    const head = vcsContextHead(contextId);
    // The DO records every main advance synchronously in its publish path, so its
    // recorded main lineage is always in lockstep with the protected ref — no
    // host-side provenance drain is needed before dispatching.
    const result = await this.gad().call<{
      repos: Array<{ repoPath: string; status: "up-to-date" | "merged" | "conflicted" }>;
      baseView: string;
      outcomes: Array<
        { repoPath: string } & (
          | { status: "up-to-date"; stateHash: string }
          | {
              status: "merged";
              stateHash: string;
              eventId: string;
              headHash: string;
              previousStateHash: string;
            }
          | { status: "conflicted"; stateHash: string }
        )
      >;
    }>("vcsRebaseContext", { contextId, actor: vcsLogActor(actor) });

    for (const outcome of result.outcomes) {
      const repoPath = outcome.repoPath;
      const logId = this.repoLogId(repoPath);
      if (outcome.status === "merged") {
        this.lastState.set(this.stateKey(logId, head), outcome.stateHash);
        await this.projector.project({
          repoPath,
          head,
          stateHash: outcome.stateHash,
          bestEffort: true,
        });
        this.noteContextMaterialized(contextId, repoPath, outcome.stateHash);
        const event = await this.stateAdvancedEvent({
          head,
          previousStateHash: outcome.previousStateHash,
          stateHash: outcome.stateHash,
          eventId: outcome.eventId,
          headHash: outcome.headHash,
          actor,
          transitionKind: "merge",
          repoPath,
        });
        this.emitter.emit("state-advanced", event);
      } else if (outcome.status === "conflicted") {
        await this.projector.project({ repoPath, head, stateHash: outcome.stateHash });
        await this.gad().call("markPendingMergeMaterialized", { logId, head });
        this.noteContextMaterialized(contextId, repoPath, outcome.stateHash);
        await this.syncConflictSummary(head, repoPath);
      }
    }
    return { repos: result.repos, baseView: result.baseView };
  }

  /**
   * Context status — per-repo `forked`/`uncommitted`/`ahead`/`behind`/`deleted`
   * summary (gad-store `vcsContextStatus`). Only interesting repos are returned.
   */
  contextStatus(contextId: string): Promise<
    Array<{
      repoPath: string;
      forked: boolean;
      uncommitted: boolean;
      ahead: boolean;
      behind: boolean;
      deleted: boolean;
      pendingMerge: { source: string; conflictPaths: string[]; startedAt: string | null } | null;
    }>
  > {
    return this.gad().call("vcsContextStatus", { contextId });
  }

  /**
   * Publish a host-authored metadata snapshot through the same GAD-owned
   * write-ahead intent protocol as user pushes/imports. This is intentionally
   * narrow: callers provide a complete repo file set already mirrored into the
   * CAS; the writer DO creates the state, advances the protected ref, and
   * records provenance before returning.
   */
  async publishHostMutation(input: {
    ctx: ServiceContext;
    repoPath: string;
    expectedOld: string;
    files: Array<{ path: string; contentHash: string; mode: number }>;
    summary: string;
    operation: "push" | "import";
  }): Promise<{ stateHash: string }> {
    const via = this.deps.getVcsWriterIdentity?.() ?? "vcs-writer";
    const invocation = this.deps.vcsInvocations?.mint({
      caller: input.ctx.caller,
      via,
      method: "vcsPublishHostMutation",
    });
    try {
      return await this.gad().call(
        "vcsPublishHostMutation",
        {
          repoPath: normalizeRepoPathForLog(input.repoPath),
          expectedOld: input.expectedOld,
          files: input.files,
          message: input.summary,
          operation: input.operation,
          actor: vcsLogActor({
            id: input.ctx.caller.runtime.id,
            kind: input.ctx.caller.runtime.kind,
          }),
        },
        invocation ? { invocationToken: invocation.token } : undefined
      );
    } finally {
      invocation?.release();
    }
  }

  // -------------------------------------------------------------------------
  // Merge (WS3.P4)
  // -------------------------------------------------------------------------

  /**
   * Explicit reconcile (§4.6): merge `sourceHead` (typically `main`) into
   * `targetHead`, producing a MERGE COMMIT — never auto-done by push.
   *
   * A `ctx:*` target is USERLAND SEMANTICS: the gad-store DO's `vcsMerge`
   * owns the preconditions (pending/working checks), base/tip resolution, the
   * 3-way computation, the merge commit on clean, and the parked pending
   * merge on conflict. This host side is the disk follower: it projects
   * the returned state, acknowledges conflict materialization, writes the
   * conflict summary, and emits build/reactive events.
   *
   * `main` is NOT a mergeable target: main advances only through the gated
   * push path (`refs.updateMains`), never by merging a head into it. A `main`
   * target is rejected outright.
   */
  async mergeHeads(
    targetHead: string,
    sourceHead: string,
    opts: {
      actor?: { id: string; kind: string };
      repoPath: string;
    }
  ): Promise<MergeReconcileResult> {
    if (targetHead === VCS_MAIN_HEAD) {
      throw new Error(
        "vcs merge targets a ctx:* head (pulls a source into it); main advances via push, not merge"
      );
    }
    const repoPath = opts.repoPath;
    const logId = this.repoLogId(repoPath);
    const sk = this.stateKey(logId, targetHead);
    return this.locked(sk, async () => {
      const actor = opts.actor ?? USER_ACTOR;
      // A `main` source resolves through the protected ref inside the DO. The DO
      // records every main advance synchronously in its publish path, so its
      // recorded main lineage is already in lockstep with the ref — no host-side
      // provenance sync is needed before the merge.
      const outcome = await this.gad().call<GadMergeOutcome>("vcsMerge", {
        logId,
        targetHead,
        sourceHead,
        actor: vcsLogActor(actor),
      });

      if (outcome.status === "up-to-date") {
        return {
          status: "up-to-date",
          stateHash: outcome.stateHash,
          conflicts: [],
          mergeable: "clean",
          upstreamCommits: outcome.upstreamCommits,
        };
      }

      if (outcome.status === "merged") {
        this.lastState.set(sk, outcome.stateHash);
        await this.projector.project({
          repoPath,
          head: targetHead,
          stateHash: outcome.stateHash,
          bestEffort: true,
        });
        this.noteContextMaterialized(targetHead.slice("ctx:".length), repoPath, outcome.stateHash);
        const event = await this.stateAdvancedEvent({
          head: targetHead,
          previousStateHash: outcome.previousStateHash,
          stateHash: outcome.stateHash,
          eventId: outcome.eventId,
          headHash: outcome.headHash,
          actor,
          transitionKind: "merge",
          repoPath,
        });
        this.emitter.emit("state-advanced", event);
        return {
          status: "merged",
          stateHash: outcome.stateHash,
          conflicts: [],
          mergeable: "clean",
          upstreamCommits: outcome.upstreamCommits,
        };
      }

      // Conflicted: the DO parked the pending merge (`materialized: false`).
      // Project the conflict-marked provisional tree into the context FS,
      // acknowledge materialization (crash-recovery invariant), and surface
      // the summary file for non-content conflicts.
      await this.projector.project({ repoPath, head: targetHead, stateHash: outcome.stateHash });
      await this.gad().call("markPendingMergeMaterialized", { logId, head: targetHead });
      this.noteContextMaterialized(targetHead.slice("ctx:".length), repoPath, outcome.stateHash);
      await this.syncConflictSummary(targetHead, repoPath);
      return {
        status: "conflicted",
        stateHash: outcome.stateHash,
        conflicts: outcome.conflicts,
        mergeable: "conflict",
        conflictPaths: outcome.conflictPaths,
        upstreamCommits: outcome.upstreamCommits,
      };
    });
  }

  /**
   * Write or remove the worktree merge-conflict summary for a head, driven off
   * its pending-merge record. Non-content conflicts (mode / binary /
   * delete-vs-change) leave no in-file `<<<<<<<` markers, so this file is the
   * only worktree-visible signal for CLI/agent/direct users. It is ignored by
   * snapshots (never committed) and removed when the merge resolves or aborts.
   */
  private async syncConflictSummary(head: string, repoPath: string): Promise<void> {
    const logId = this.repoLogId(repoPath);
    // Resolve the pending-merge DATA here (semantics); the projector owns the
    // disk write (follower).
    const pending = this.attached
      ? (
          await this.gad().call<{
            info: { conflicts?: MergeConflict[]; theirsHead?: string } | null;
          }>("getPendingMerge", { logId, head })
        ).info
      : null;
    await this.projector.writeConflictSummary({
      repoPath,
      head,
      pending: pending
        ? { theirsHead: pending.theirsHead, conflicts: pending.conflicts ?? [] }
        : null,
    });
  }

  /**
   * Abort a pending (conflicted) merge. The SEMANTICS (consume the parked
   * pending, decide what to restore) live in the gad-store DO
   * (`vcsAbortMerge`); this host side restores the pre-merge tree on disk and
   * clears the conflict summary. NOT a ref advance — a pending merge never
   * moved the head (the provisional tree is a disk-only projection), so no
   * protected-ref gate applies, even on `main`.
   */
  async abortMerge(
    targetHead: string,
    opts: {
      actor?: { id: string; kind: string };
      repoPath: string;
    }
  ): Promise<{ aborted: boolean }> {
    const repoPath = opts.repoPath;
    const logId = this.repoLogId(repoPath);
    const sk = this.stateKey(logId, targetHead);
    return this.locked(sk, async () => {
      const outcome = await this.gad().call<{
        aborted: boolean;
        restoreStateHash: string | null;
      }>("vcsAbortMerge", { logId, head: targetHead });
      if (!outcome.aborted) return { aborted: false };
      if (outcome.restoreStateHash) {
        await this.projector.project({
          repoPath,
          head: targetHead,
          stateHash: outcome.restoreStateHash,
        });
        this.lastState.set(sk, outcome.restoreStateHash);
      }
      await this.syncConflictSummary(targetHead, repoPath);
      return { aborted: true };
    });
  }

  async pendingMerge(
    targetHead: string,
    repoPath: string
  ): Promise<{
    theirsHead: string;
    conflicts: Array<{ path: string; kind: string }>;
    startedAt: string | null;
  } | null> {
    const pending = (
      await this.gad().call<{
        info: {
          theirsHead: string;
          conflicts: Array<{ path: string; kind: string }>;
          startedAt?: string | null;
        } | null;
      }>("getPendingMerge", { logId: this.repoLogId(repoPath), head: targetHead })
    ).info;
    return pending
      ? {
          theirsHead: pending.theirsHead,
          conflicts: pending.conflicts,
          startedAt: pending.startedAt ?? null,
        }
      : null;
  }

  // -------------------------------------------------------------------------
  // Edit → commit → push (the three-layer VCS)
  //
  // The edit/commit COMPOSITION lives in the gad-store DO since P5c
  // (`applyEditOps` / `commitWorking` / `revertWorking`, backed by the
  // userland @workspace/vcs-engine EditEngine over the content-store blob
  // bridge, with compose-base resolution against the host `refs.*` bridge).
  // The host side here is transport + coordination only: it forwards the
  // caller-VERIFIED actor and the op batch, then FOLLOWS the returned state —
  // disk projection through the DiskProjector and the build/reactive events.
  // main advances only via push.
  // -------------------------------------------------------------------------

  /**
   * Record a batch of file edits as UNCOMMITTED working edit-ops on a `ctx:*`
   * head. The gad-store DO composes the working content (committed base — ctx
   * head, pinned-base slice, or protected `main` — plus prior uncommitted
   * ops, or a pending merge's provisional tree), applies the ops, persists
   * the rows under a two-part CAS, and stages + mirrors the new working
   * state; this method projects that state to disk (follower) and emits
   * `working-advanced`. No head advance, no log event, no build.
   */
  async recordEdit(input: {
    head: string;
    /** Optional optimistic guard: the composed working state the author saw. */
    baseStateHash?: string;
    edits: EditOp[];
    actor: { id: string; kind: string };
    repoPath: string;
    invocationId?: string;
    turnId?: string;
  }): Promise<RecordEditResult> {
    if (input.head === VCS_MAIN_HEAD || !input.head.startsWith("ctx:")) {
      throw new Error(
        `edit: '${input.head}' — edits target a ctx:* head; main advances only via push`
      );
    }
    contextIdFromVcsHead(input.head);
    const repoPath = input.repoPath;
    const logId = this.repoLogId(repoPath);
    const sk = this.stateKey(logId, input.head);
    return this.locked(sk, async () => {
      const result = await this.gad().call<AppliedEditOpsResult>("applyEditOps", {
        logId,
        head: input.head,
        actorId: input.actor.id,
        actorJson: JSON.stringify(vcsLogActor(input.actor)),
        invocationId: input.invocationId ?? null,
        turnId: input.turnId ?? null,
        edits: input.edits,
        ...(input.baseStateHash !== undefined ? { baseStateHash: input.baseStateHash } : {}),
      });
      return await this.followWorkingAdvance(logId, input.head, repoPath, input.actor, result);
    });
  }

  /**
   * Post-edit FOLLOWER step (shared by edit and revert): project the new
   * working state to disk (best-effort — the on-disk tree is a disposable
   * projection; the durable advance already happened in the DO), refresh the
   * trackers, and emit `working-advanced` when content changed.
   */
  private async followWorkingAdvance(
    logId: string,
    head: string,
    repoPath: string,
    actor: { id: string; kind: string },
    result: AppliedEditOpsResult
  ): Promise<RecordEditResult> {
    if (result.changedPaths.length === 0) {
      return {
        head,
        stateHash: result.stateHash,
        committed: false,
        status: "uncommitted",
        editSeq: result.editSeq,
        changedPaths: [],
      };
    }
    // Single-context sync rule (D2): the DO working state is authoritative, so
    // project it to disk immediately. For the active context this writes the
    // workspace root; a subsequent freshness scan then diffs disk against this
    // just-projected baseline and sees no drift, so it never misreads this DO
    // edit as an external change (or, worse, a deletion).
    await this.projector.project({
      repoPath,
      head,
      stateHash: result.stateHash,
      bestEffort: true,
    });
    this.lastState.set(this.stateKey(logId, head), result.stateHash);
    if (head.startsWith("ctx:")) {
      this.noteContextMaterialized(head.slice("ctx:".length), repoPath, result.stateHash);
    }
    const changedPaths = result.changedPaths.map((p) => joinRepoPrefix(repoPath, p));
    this.emitter.emit("working-advanced", {
      head,
      repoPath,
      actor,
      stateHash: result.stateHash,
      baseStateHash: result.baseStateHash,
      editSeq: result.editSeq,
      changedPaths,
    } satisfies WorkingAdvancedEvent);
    return {
      head,
      stateHash: result.stateHash,
      committed: false,
      status: "uncommitted",
      editSeq: result.editSeq,
      changedPaths,
    };
  }

  /**
   * Commit the uncommitted edits on a `ctx:*` head as ONE deliberate, messaged
   * snapshot — composed and sealed INSIDE the gad-store DO (`commitWorking`:
   * committed base + included ops − `exclude`, re-keying the included rows to
   * the new commit; a pending merge on the head makes this the merge-resolution
   * commit, and unresolved conflict markers are refused). The host re-projects
   * the working tree (follower) and emits the state-advanced event off the
   * returned identities. `unchanged` only when no included rows remain AND
   * there is no pending merge. Mandatory message. `main` is rejected (push
   * only). Multi-repo commit loops per repo (non-atomic; atomicity is push's
   * job).
   */
  async commit(input: {
    head: string;
    repoPath: string;
    message: string;
    exclude?: string[];
    /** Include selector (`git add <paths>`): seal ONLY these repo-relative
     *  paths' working edits. Mutually exclusive with `exclude`. */
    paths?: string[];
    actor: { id: string; kind: string };
    invocationId?: string;
    turnId?: string;
  }): Promise<CommitEditsResult> {
    if (input.head === VCS_MAIN_HEAD || !input.head.startsWith("ctx:")) {
      throw new Error(
        `commit: '${input.head}' — commit targets a ctx:* head; main advances only via push`
      );
    }
    if (!input.message || !input.message.trim()) {
      throw new Error("commit: a message is required");
    }
    const repoPath = input.repoPath;
    const logId = this.repoLogId(repoPath);
    const sk = this.stateKey(logId, input.head);
    return this.locked(sk, async () => {
      const result = await this.gad().call<{
        status: "committed" | "unchanged";
        stateHash: string;
        eventId: string | null;
        headHash: string | null;
        committedSeq: number | null;
        editCount: number;
        previousStateHash: string;
        editOps: StateAdvanceEditOp[];
        transitionKind: "snapshot" | "merge-resolution";
        coAuthors?: Array<{ id: string; kind: string; subject?: { userId?: string } }>;
      }>("commitWorking", {
        logId,
        head: input.head,
        message: input.message,
        actor: vcsLogActor(input.actor),
        invocationId: input.invocationId ?? null,
        turnId: input.turnId ?? null,
        exclude: input.exclude ?? null,
        paths: input.paths ?? null,
      });
      if (result.status === "unchanged") {
        return {
          head: input.head,
          stateHash: result.stateHash,
          eventId: null,
          headHash: null,
          editCount: 0,
          status: "unchanged",
          changedPaths: [],
        };
      }
      // Re-project the working content (new ctx head + any remaining excluded
      // ops) to disk — the pending merge (if any) was consumed by the commit.
      await this.reprojectWorking(logId, input.head, repoPath);
      const event = await this.stateAdvancedEvent({
        head: input.head,
        previousStateHash: result.previousStateHash,
        stateHash: result.stateHash,
        eventId: result.eventId,
        headHash: result.headHash,
        actor: input.actor,
        transitionKind:
          result.transitionKind === "merge-resolution" ? "merge-resolution" : "snapshot",
        editOps: result.editOps,
        repoPath,
      });
      this.emitter.emit("state-advanced", event);
      return {
        head: input.head,
        stateHash: result.stateHash,
        eventId: result.eventId,
        headHash: result.headHash,
        editCount: result.editCount,
        status: "committed",
        changedPaths: event.changedPaths,
        ...(result.coAuthors && result.coAuthors.length > 0 ? { coAuthors: result.coAuthors } : {}),
      };
    });
  }

  /**
   * Drop a repo's uncommitted edits on a head AND clear any pending merge (aborts
   * an in-progress reconcile), then re-materialize the committed ctx head to disk
   * (the "abort / stash-drop").
   */
  async discardEdits(input: {
    head: string;
    repoPath: string;
  }): Promise<{ discarded: number; stateHash: string }> {
    const repoPath = input.repoPath;
    const logId = this.repoLogId(repoPath);
    const sk = this.stateKey(logId, input.head);
    return this.locked(sk, async () => {
      const { discarded } = await this.gad().call<{ discarded: number }>("discardWorkingEdits", {
        logId,
        head: input.head,
      });
      const stateHash = await this.reprojectWorking(logId, input.head, repoPath);
      return { discarded, stateHash };
    });
  }

  // ── Working-content composition helpers ────────────────────────────────────

  /** The committed base a `main`-target merge composes on when the repo has
   *  no main yet (ref creation): the protected ref, else the empty state.
   *  Ctx-head base resolution lives in the DO with the merge semantics. */
  private async resolveCommittedBase(head: string, repoPath: string): Promise<string> {
    if (head !== VCS_MAIN_HEAD) {
      throw new Error(`resolveCommittedBase: only main-target merges resolve here (got ${head})`);
    }
    return this.mainRefState(repoPath) ?? EMPTY_STATE_HASH;
  }

  /** Re-derive a head's working content IN THE DO (committed base + remaining
   *  uncommitted ops; staged + mirrored there) and project it to disk;
   *  returns the working state hash. */
  private async reprojectWorking(logId: string, head: string, repoPath: string): Promise<string> {
    const resolved = await this.gad().call<{ stateHash: string | null }>("resolveWorkingState", {
      logId,
      head,
    });
    const stateHash = resolved.stateHash ?? EMPTY_STATE_HASH;
    await this.projector.project({ repoPath, head, stateHash, clean: true, bestEffort: true });
    if (head.startsWith("ctx:")) {
      this.noteContextMaterialized(head.slice("ctx:".length), repoPath, stateHash);
    }
    this.lastState.set(this.stateKey(logId, head), stateHash);
    return stateHash;
  }

  /**
   * Content read at a ref (head name or `state:` hash). Returns the file
   * bytes/text PLUS the resolved `stateHash` the caller should pin as the base
   * for a subsequent `edit` (CAS). Resolved through the CONTENT STORE (the
   * tree authority) — works for server-minted composed views and fresh main
   * states the gad DO has not recorded yet.
   */
  async readFile(ref: string, filePath: string, repoPath?: string): Promise<VcsFileContent | null> {
    const stateHash = await this.resolveStateRef(ref, repoPath);
    await this.worktrees.ensureStateMirrored(stateHash);
    const meta = await readFileAtTree(this.deps.blobsDir, stateHash, filePath);
    if (!meta) return null;
    const bytes = await getBytes(this.deps.blobsDir, meta.contentHash);
    if (!bytes) throw new Error(`readFile: blob missing from CAS: ${meta.contentHash}`);
    return {
      content: readContentFromBytes(bytes),
      stateHash,
      contentHash: meta.contentHash,
      mode: meta.mode,
      size: bytes.length,
    };
  }

  /**
   * List every file path (+ content hash, mode) at a ref (head name or
   * `state:` hash). The path index, wikilink resolution, and file tree read
   * through this — content-store backed, never an `fs` walk of the working
   * tree and never a gad-DO dependency.
   */
  async listFiles(
    ref: string,
    repoPath?: string
  ): Promise<Array<{ path: string; contentHash: string; mode: number }>> {
    const stateHash = await this.resolveStateRef(ref, repoPath);
    const files = await this.worktrees.listStateFiles(stateHash);
    return files.map((f) => ({ path: f.path, contentHash: f.content_hash, mode: f.mode }));
  }

  // -------------------------------------------------------------------------
  // Traversal reads (edit/commit graph) are userland-owned (P5c). The trusted
  // host VCS service still needs the bounded log query below for its explicit
  // `log` endpoint and for resolving an omitted revert target.
  // -------------------------------------------------------------------------

  /** Bounded commit-log query used by the trusted host VCS service. */
  async readVcsLog(
    repoPath: string,
    limit = 50,
    head = VCS_MAIN_HEAD
  ): Promise<
    Array<{
      seq: number;
      envelopeId: string;
      actor: unknown;
      summary: string | null;
      outputStateHash: string | null;
      appendedAt: string;
    }>
  > {
    return this.gad().call("vcsLog", { repoPath, limit, head });
  }

  /**
   * On-demand build of a head's WORKING content scoped to repos/units, WITHOUT
   * touching the published EV baseline (build is authoritative only at push).
   */
  async previewBuild(input: {
    head: string;
    repoPaths?: string[];
    units?: string[];
    getBuildSystem?: () => RepoPushValidator | null;
  }): Promise<RepoBuildReport[]> {
    const buildSystem = input.getBuildSystem?.();
    if (!buildSystem) return [];
    const workingView = input.head.startsWith("ctx:")
      ? await this.resolveContextView(input.head.slice("ctx:".length))
      : (await this.repositories.workspaceView()).stateHash;
    return buildSystem.previewBuild(workingView, {
      ...(input.repoPaths ? { repoPaths: input.repoPaths } : {}),
      ...(input.units ? { units: input.units } : {}),
    });
  }

  /**
   * Revert a transition by computing its **inverse patch** and applying it
   * **forward** onto the current head as a WORKING edit — a `git revert`,
   * never a `git reset` (the head ref only ever moves forward). Computed
   * ENTIRELY in the gad-store DO (`revertWorking`, P5c): the transition is
   * resolved by the state it produced (`stateHash` = its `outputStateHash`)
   * or by `eventId`, the inverse references pre-transition content by blob
   * digest (no bytes move), and the result lands as uncommitted edit-ops the
   * caller commits later. The host follows with the disk projection and the
   * `working-advanced` event. Because the inverse is staged off the
   * transition's *after* state and applied to the live working content, later
   * non-overlapping edits are preserved.
   */
  async revert(input: {
    head: string;
    target: { stateHash?: string; eventId?: string };
    actor: { id: string; kind: string };
    repoPath: string;
    invocationId?: string;
    turnId?: string;
  }): Promise<RecordEditResult> {
    const repoPath = input.repoPath;
    const logId = this.repoLogId(repoPath);
    const sk = this.stateKey(logId, input.head);
    return this.locked(sk, async () => {
      const result = await this.gad().call<AppliedEditOpsResult>("revertWorking", {
        logId,
        head: input.head,
        target: input.target,
        actorId: input.actor.id,
        actorJson: JSON.stringify(vcsLogActor(input.actor)),
        invocationId: input.invocationId ?? null,
        turnId: input.turnId ?? null,
      });
      return await this.followWorkingAdvance(logId, input.head, repoPath, input.actor, result);
    });
  }

  /**
   * PICK — the forward dual of {@link revert}: land a selected change onto a
   * `ctx:*` head as UNCOMMITTED working edits (never a head advance). A `commit`
   * pick 3-way-applies a commit's patch; a `paths` pick injects another
   * context's working content at repo-relative paths. Computed ENTIRELY in the
   * gad-store DO (`vcsPick`), which tags the resulting rows with `pickedFrom`
   * provenance; this host side follows with the disk projection and the
   * `working-advanced` event, exactly like {@link revert}.
   */
  async pick(input: {
    head: string;
    repoPath: string;
    actor: { id: string; kind: string };
    pick:
      | { kind: "commit"; eventId: string }
      | { kind: "paths"; sourceContextId: string; paths: string[] };
  }): Promise<RecordEditResult> {
    const repoPath = input.repoPath;
    const logId = this.repoLogId(repoPath);
    const sk = this.stateKey(logId, input.head);
    return this.locked(sk, async () => {
      const result = await this.gad().call<AppliedEditOpsResult>("vcsPick", {
        logId,
        head: input.head,
        actor: vcsLogActor(input.actor),
        pick: input.pick,
      });
      return await this.followWorkingAdvance(logId, input.head, repoPath, input.actor, result);
    });
  }

  /**
   * Context diff — the added/removed/changed files a context's branch
   * introduced relative to a baseline: its `fork-base` (the pinned state it
   * inherited when forked) or the current workspace `main`. A pure content-store
   * projection: resolve the context's composed working view and the baseline
   * state, then {@link diffStates}. The DO is consulted only for the view/base
   * resolution.
   */
  async contextDiff(contextId: string, against: "fork-base" | "main"): Promise<TreeDiff> {
    const right = await this.resolveContextView(contextId);
    const left =
      against === "main"
        ? (await this.repositories.workspaceView()).stateHash
        : ((await this.contextBaseView(contextId)) ?? EMPTY_STATE_HASH);
    return this.diffStates(left, right);
  }

  /**
   * Push status for a repo — the SEMANTICS (ahead/diverged/deleted, the
   * unpublished delta against the protected `main`) live in the gad-store DO
   * (`vcsPushStatus`, behind the userland `vcs` service); this is a pure
   * dispatch. The follower is not drained first: status is a read, and the
   * DO's answer is computed against the protected ref it reads through the
   * refs bridge.
   */
  async pushStatus(
    repoPath: string,
    head: string = VCS_MAIN_HEAD
  ): Promise<{
    repoPath: string;
    head: string;
    headStateHash: string | null;
    mainStateHash: string | null;
    ahead: number;
    uncommitted: number;
    uncommittedPaths: string[];
    diverged: boolean;
    behind: boolean;
    /** The repo was deleted from the workspace (its `main` is archived/gone). A
     *  push will be refused — restore or drop the context rather than re-push. */
    deleted: boolean;
    files: Array<{ path: string; kind: "added" | "removed" | "changed" }>;
  }> {
    return await this.gad().call("vcsPushStatus", {
      repoPath: normalizeRepoPathForLog(repoPath),
      head,
    });
  }

  /**
   * Kick the DO's provenance soft-state prune (C6 `pruneProvenanceSoftState`):
   * age out low-value touches, stale render-log rows, and disposable provenance
   * cache entries. Wired into the hourly GC scheduler next to `runGc`. The DO
   * @rpc lands in a later wave; until then a "method not found" from the DO is
   * tolerated so the scheduler stays green — any other failure propagates to
   * the scheduler's per-run guard.
   */
  async pruneProvenanceSoftState(): Promise<void> {
    if (!this.attached) return;
    try {
      await this.gad().call("pruneProvenanceSoftState", {});
    } catch (error) {
      if (isUnknownDoMethodError(error)) return;
      throw error;
    }
  }

  /**
   * Enumerate the repo set from the ON-DISK workspace tree (not the GAD logs).
   * The bootstrap counterpart of {@link discoverRepos}: it scans the workspace
   * root so repos can be seeded into their logs before any `vcs:repo:*` `main`
   * exists. Walks each section (container sections one level deep, flat sections
   * by their own files), feeds the discovered relative file paths through the
   * shared {@link discoverRepos}, and returns the repo descriptors.
   */
  private async discoverReposFromDisk(): Promise<DiscoveredRepo[]> {
    const filePaths = await this.scanWorkspaceRepoPaths();
    return discoverRepos(filePaths);
  }

  /**
   * Collect enough workspace-relative paths from disk for {@link discoverRepos}
   * to enumerate every present repo. `discoverRepos` only needs `section/<name>`
   * (or `meta/<file>`) representatives, so we walk one level into each container
   * section and read the flat sections' immediate files — no full-tree walk.
   */
  private async scanWorkspaceRepoPaths(): Promise<string[]> {
    const root = this.deps.workspaceRoot;
    const out: string[] = [];
    let sections: import("node:fs").Dirent[];
    try {
      sections = await fsp.readdir(root, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const section of sections) {
      if (!section.isDirectory()) continue;
      const sectionName = section.name;
      if (CONTAINER_SECTIONS.has(sectionName)) {
        let children: import("node:fs").Dirent[];
        try {
          children = await fsp.readdir(path.join(root, sectionName), { withFileTypes: true });
        } catch {
          continue;
        }
        for (const child of children) {
          if (child.isDirectory()) out.push(`${sectionName}/${child.name}/.repo`);
        }
      } else if (FLAT_SECTIONS.has(sectionName)) {
        let files: import("node:fs").Dirent[];
        try {
          files = await fsp.readdir(path.join(root, sectionName), { withFileTypes: true });
        } catch {
          continue;
        }
        // A single representative file is enough; flat sections map the section
        // dir itself to one repo. Use a marker if the dir is otherwise empty.
        const file = files.find((f) => f.isFile());
        out.push(`${sectionName}/${file?.name ?? ".repo"}`);
      }
    }
    return out;
  }

  /**
   * Bootstrap on-disk: for every repo present in the workspace tree whose
   * `vcs:repo:<repoPath>` `main` is missing, snapshot that repo's subtree into
   * its own log. Replaces the old whole-tree migrate/finalize: there is no
   * `vcs:workspace` log; each repo is seeded independently and directly from the
   * working tree. Idempotent — repos that already have a `main` are skipped, and
   * a repo whose on-disk state already matches its `main` no-ops in `snapshotDir`.
   */
  async ensureRepoLogsFromDisk(): Promise<void> {
    if (!this.attached) return;
    const repos = await this.discoverReposFromDisk();
    for (const repo of repos) {
      const repoPath = repo.repoPath;
      const logId = this.repoLogId(repoPath);
      const existing = await this.worktrees.resolveWorktreeRef(VCS_MAIN_HEAD, logId);
      if (existing) {
        // Already in the store — adopt into the protected-ref store (no-op
        // when already seeded).
        const seeded = await this.deps.refs.seedMain({ repoPath, value: existing });
        this.lastState.set(this.stateKey(logId, VCS_MAIN_HEAD), seeded.record.stateHash);
        continue;
      }
      // BOOTSTRAP/ADOPTION DOOR (the one remaining disk→main seed): read the
      // repo subtree straight from the source dir (`workspaceRoot/{repoPath}`) —
      // `main` has no `dirForRepoHead` mapping — and seed the repo's `main` log +
      // protected ref from it. Set-if-absent; runs only for repos with no `main`
      // yet. The ref value is host-computed from disk, never sourced from the DO.
      const dir = path.join(
        this.deps.workspaceRoot,
        ...normalizeRepoPathForLog(repoPath).split("/")
      );
      const snap = await this.locked(this.stateKey(logId, VCS_MAIN_HEAD), () =>
        this.worktrees.snapshotDir(dir, {
          head: VCS_MAIN_HEAD,
          logId,
          actor: SYSTEM_ACTOR,
          summary: `seed ${repoPath} from disk`,
        })
      );
      // Bootstrap adoption of on-disk content — seed, not a gated advance.
      const seeded = await this.deps.refs.seedMain({ repoPath, value: snap.stateHash });
      this.lastState.set(this.stateKey(logId, VCS_MAIN_HEAD), seeded.record.stateHash);
    }
  }

  private async withSuppressedMainRefReactions<T>(fn: () => Promise<T>): Promise<T> {
    this.suppressMainRefReactions += 1;
    try {
      return await fn();
    } finally {
      this.suppressMainRefReactions -= 1;
    }
  }

  // -------------------------------------------------------------------------
  // GC (WS3.P5)
  // -------------------------------------------------------------------------

  /**
   * Run a full GC cycle: mark in the store (also prunes orphaned value
   * rows), then sweep blob candidates older than `minAgeMs` and delete
   * their bytes from the filesystem CAS (two-phase deletion).
   */
  async runGc(opts: { minAgeMs?: number } = {}): Promise<{
    keptStates: number;
    sweptStates: number;
    sweptManifests: number;
    sweptFileVersions: number;
    sweptBlobs: number;
    sweptTreeObjects: number;
  }> {
    const roots = await this.collectGcRoots();
    const mark = await this.gad().call<{
      keptStates: number;
      sweptStates: number;
      sweptManifests: number;
      sweptFileVersions: number;
      blobCandidates: number;
      liveStateHashes: string[];
      liveBlobDigests?: string[];
    }>("runGadGcMark", roots);
    const sweep = await this.gad().call<{ digests: string[] }>("runGadGcSweep", {
      minAgeMs: opts.minAgeMs ?? 60_000,
      protectedBlobDigests: roots.protectedBlobDigests,
      protectedTreeDigests: roots.protectedTreeDigests,
    });
    for (const digest of sweep.digests) {
      await fsp.rm(blobPath(this.deps.blobsDir, digest), { force: true }).catch(() => {});
    }
    const liveTreeDigests = new Set(roots.protectedTreeDigests);
    const liveContentDigests = new Set([
      ...roots.protectedBlobDigests,
      ...(mark.liveBlobDigests ?? []),
    ]);
    for (const stateHash of mark.liveStateHashes) {
      if (!stateHash.startsWith("state:")) continue;
      const reachable = await collectTreeReachableDigests(this.deps.blobsDir, stateHash);
      if (!reachable) {
        throw new Error(`GC live state ${stateHash} is missing its canonical content-store tree`);
      }
      for (const digest of reachable.treeDigests) liveTreeDigests.add(digest);
      for (const digest of reachable.contentDigests) liveContentDigests.add(digest);
    }
    const treeSweep = await pruneUnreferencedTreeObjects(this.deps.blobsDir, {
      referenced: [...new Set([...liveContentDigests, ...liveTreeDigests])],
      olderThanMs: opts.minAgeMs ?? 60_000,
    });
    return {
      keptStates: mark.keptStates,
      sweptStates: mark.sweptStates,
      sweptManifests: mark.sweptManifests,
      sweptFileVersions: mark.sweptFileVersions,
      sweptBlobs: sweep.digests.length,
      sweptTreeObjects: treeSweep.deleted.length,
    };
  }

  private async collectGcRoots(): Promise<WorkspaceGcRoots> {
    // The empty state is a real canonical content-tree root, not a sentinel.
    // Fresh workspaces can reach their first scheduled GC before any view has
    // needed to materialize it, so establish the invariant before handing the
    // root to the GAD marker.
    await this.worktrees.ensureStateMirrored(EMPTY_STATE_HASH);
    const rootStateHashes = new Set<string>([EMPTY_STATE_HASH]);
    const protectedBlobDigests = new Set<string>();
    const protectedTreeDigests = new Set<string>();

    for (const record of this.deps.refs.listMains()) {
      const value = record.stateHash;
      if (value.startsWith("state:")) {
        rootStateHashes.add(value);
        await this.worktrees.ensureStateMirrored(value);
      }
      const reachable = await collectTreeReachableDigests(this.deps.blobsDir, value);
      if (!reachable) {
        throw new Error(
          `GC root ${record.repoPath}#main points at missing content-store tree ${value}`
        );
      }
      for (const digest of reachable.contentDigests) protectedBlobDigests.add(digest);
      for (const digest of reachable.treeDigests) protectedTreeDigests.add(digest);
    }

    const cachedViewDigests = await this.repositories.collectCachedReachableDigests();
    for (const digest of cachedViewDigests.contentDigests) protectedBlobDigests.add(digest);
    for (const digest of cachedViewDigests.treeDigests) protectedTreeDigests.add(digest);

    return {
      rootStateHashes: [...rootStateHashes].sort(),
      protectedBlobDigests: [...protectedBlobDigests].sort(),
      protectedTreeDigests: [...protectedTreeDigests].sort(),
    };
  }

  // `readVcsLog` moved USERLAND (P5c): the gad-store DO's `vcsLog` is
  // dispatched to directly via the `vcs` manifest service.

  /**
   * Status of a head against its repo's `main` — the SEMANTICS (unpublished
   * delta, dirty, deleted) live in the gad-store DO (`vcsStatus`, behind the
   * userland `vcs` service); this is a pure dispatch. Per-repo VCS: a
   * repoPath is required.
   */
  async statusHead(
    head: string,
    repoPath: string
  ): Promise<{
    committedStateHash: string | null;
    workingStateHash: string | null;
    dirty: boolean;
    committed: { added: string[]; removed: string[]; changed: string[] };
    working: { added: string[]; removed: string[]; changed: string[] };
    uncommitted: number;
    diverged: boolean;
    behind: boolean;
    /** The repo was deleted from the workspace (its `main` is archived/gone). */
    deleted: boolean;
    pendingMerge: { source: string; conflictPaths: string[]; startedAt: string | null } | null;
  }> {
    return await this.gad().call("vcsStatus", {
      repoPath: normalizeRepoPathForLog(repoPath),
      head,
    });
  }

  /**
   * Content diff with real hunks — the SEMANTICS (endpoint resolution per
   * scope, text diffing via the shared vcs-engine, binary detection) live in
   * the gad-store DO (`vcsDiffContent`); this is a pure dispatch.
   */
  async diffContent(input: {
    repoPath?: string;
    head: string;
    scope: "committed" | "working" | "all";
    left?: string;
    right?: string;
    paths?: string[];
    contextLines?: number;
  }): Promise<{
    left: string;
    right: string;
    files: Array<{
      path: string;
      status: "added" | "removed" | "changed";
      binary: boolean;
      oldMode: number | null;
      newMode: number | null;
      oldSize: number | null;
      newSize: number | null;
      hunks: Array<{
        oldStart: number;
        oldLines: number;
        newStart: number;
        newLines: number;
        lines: string[];
      }>;
    }>;
    unified: string;
  }> {
    return await this.gad().call("vcsDiffContent", {
      ...input,
      ...(input.repoPath ? { repoPath: normalizeRepoPathForLog(input.repoPath) } : {}),
    });
  }
}
