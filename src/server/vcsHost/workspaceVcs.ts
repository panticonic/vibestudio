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
import { serializeByKey } from "@vibez1/shared/keyedSerializer";
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
  mirrorWorktreeTree,
  pruneUnreferencedTreeObjects,
  readFileAtTree,
  resolveTreePath,
  type TreeDiff,
} from "../services/blobstoreService.js";
import { isRefConflictError, type RefService, type RefChange } from "../services/refService.js";
import { writeJsonFileAtomic } from "../services/atomicFile.js";
import type { RefAdvanceGateContext } from "../services/mainAdvanceApproval.js";
import type { VerifiedCaller } from "@vibez1/shared/serviceDispatcher";

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
import { CONTAINER_SECTIONS, FLAT_SECTIONS } from "@vibez1/shared/runtime/entitySpec";
import {
  VCS_MAIN_HEAD,
  VCS_ACTIVE_CONTEXT_ID,
  VCS_ACTIVE_CONTEXT_HEAD,
  VCS_REPO_LOG_PREFIX,
  contextIdFromVcsHead,
  logIdForRepo,
  repoPathFromLogId,
  normalizeRepoPathForLog,
  joinRepoPrefix,
  vcsContextHead,
  vcsLogActor,
} from "./paths.js";
import { WorktreeStore, collectTreeFiles } from "./worktreeStore.js";
import { discoverRepos } from "./repoDiscovery.js";
import { EMPTY_STATE_HASH } from "@vibez1/shared/contentTree/worktreeHash";
import { DiskProjector } from "./diskProjector.js";

/** Narrow call surface onto the gad-store DO. */
interface GadCaller {
  /**
   * Dispatch a method to the gad-store DO. `opts.invocationToken` (register row
   * 12) attaches a host-minted on-behalf-of nonce to the dispatch so a
   * host-driven main advance (chrome merge-to-main) attributes to the
   * originating principal — the DO echoes it into `refs.updateMains`.
   */
  call<T = unknown>(
    method: string,
    input: unknown,
    opts?: { invocationToken?: string }
  ): Promise<T>;
}

type WorktreeHeadRef = NonNullable<Awaited<ReturnType<WorktreeStore["resolveWorktreeHead"]>>>;
type VcsFileEntry = Awaited<ReturnType<WorktreeStore["localState"]>>["files"][number];
type SnapshotResult = Awaited<ReturnType<WorktreeStore["snapshotDir"]>>;
type DiscoveredRepo = ReturnType<typeof discoverRepos>[number];

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
/** Bounded in-line retry backoff for a direct `main` provenance recording. On
 *  exhaustion the record gives up and the next explicit provenance
 *  synchronization replays the durable host scan record before surfacing any
 *  remaining uncovered drift. */
const RECORD_RETRY_DELAYS_MS = [25, 100, 400];
const MAIN_RECORD_STORE_VERSION = 1;

interface WorkspaceVcsDeps {
  blobsDir: string;
  /** The user's live workspace directory (main head working tree). */
  workspaceRoot: string;
  /** Root for context-folder working trees (`{contextsRoot}/{contextId}`). */
  contextsRoot: string;
  /** Root for per-state build-source checkouts. */
  buildSourcesRoot: string;
  /**
   * The server-owned protected-ref store — THE single authority for every
   * repo's `main`. All main reads resolve through it and all main advances go
   * through its gated group compare-and-swap (`updateMains`); the gad store keeps the
   * commit/provenance chain but is no longer the main-head authority.
   */
  refs: RefService;
  /**
   * Host-side on-behalf-of invocation table (narrow-host-vcs §4). A host-driven
   * main advance that dispatches to the DO OUTSIDE the token-minting RPC relay —
   * chrome merge-to-main (register row 12) — mints a record here for the
   * verified originating caller and threads the token to the DO's `vcsMerge`, so
   * the advance attributes to that caller instead of the writer DO. Absent in
   * in-process test fixtures (the merge then attributes to the DO, as before).
   */
  vcsInvocations?: import("../services/vcsInvocationTable.js").VcsInvocationTable;
  /** The single-writer vcs DO identity, for the `via` field of a minted
   *  merge-attribution record. */
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

/** Server-internal main advances (scan/bootstrap/adoption) — ungated by design:
 *  they adopt the user's own on-disk edits or already-approved content. */
const SYSTEM_ADVANCE: RefAdvanceGateContext = { kind: "system" };

/** A locally prepared (DO-free) `main` scan candidate: the ref CAS pair, the
 *  scan's file listing (already mirrored in the content store), and the
 *  build-trigger event to emit once the ref adopts it. */
interface PreparedMainScan {
  /** Ref value the scan was computed against (null = ref creation). */
  prev: string | null;
  stateHash: string;
  files: VcsFileEntry[];
  fileCount: number;
  event: StateAdvancedEvent;
}

type VcsActor = { id: string; kind: string };

interface MainRecordTask {
  id?: string;
  repoPath: string;
  logId: string;
  prev: string | null;
  next: string;
  files: VcsFileEntry[];
  actor: VcsActor;
  summary: string;
}

interface DurableMainRecord extends MainRecordTask {
  version: typeof MAIN_RECORD_STORE_VERSION;
  id: string;
  createdAt: number;
}

function readContentFromBytes(bytes: Buffer): VcsFileReadContent {
  try {
    const text = UTF8_DECODER.decode(bytes);
    if (!text.includes("\u0000")) return { kind: "text", text };
  } catch {
    // Fall through to binary transport.
  }
  return { kind: "bytes", base64: bytes.toString("base64") };
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
  private gadCaller: GadCaller | null = null;
  private readonly emitter = new EventEmitter();
  /** Last known state per head — diff basis for changedPaths. */
  private readonly lastState = new Map<string, string>();
  /** Serialize snapshots per directory (concurrent scans of one tree race). */
  private readonly snapshotLocks = new Map<string, Promise<unknown>>();
  private ensureFreshInFlight: Promise<{ stateHash: string }> | null = null;
  /** Local main-head state served while the gad store is unreachable. */
  private localMain: LocalWorkspaceState | null = null;
  /** Pending-record ids that have been written but whose ref CAS has not
   *  returned yet in this process. Durable replay skips them so a concurrent
   *  flush cannot discard a live pre-CAS record as stale. */
  private readonly preCasMainRecords = new Set<string>();
  /**
   * In-flight direct provenance recordings, keyed by repo `logId` (P5a, narrow
   * host). Each scan/freshness `main` advance records its ref transition in the
   * gad DO AFTER the fact via a DIRECT ingest. The full scan payload is first
   * persisted as a host write-ahead record before the protected ref CAS; once
   * the CAS lands the async path either records it in the DO and deletes the
   * file, or leaves the file for attach/on-demand replay. Fire-and-forget from
   * the build path (which never blocks on the DO), but chained PER REPO through
   * this map so recordings land in ref order (and independently across repos).
   * The settled promise per repo lets lineage ops ({@link syncMainProvenance})
   * await a record that is still landing before reading the DO's main lineage.
   */
  private readonly inFlightRecords = new Map<string, Promise<void>>();
  /**
   * The disk-projection FOLLOWER (P5c): the one module that writes working
   * trees. Every operation path invokes it POST-advance with the state hash
   * the (userland) VCS semantics decided on; no projection logic is inlined
   * in operations and the projector never decides what a tree should be.
   */
  private readonly projector: DiskProjector;

  constructor(private readonly deps: WorkspaceVcsDeps) {
    this.worktrees = new WorktreeStore({
      blobsDir: deps.blobsDir,
      gad: {
        call: <T>(method: string, input: unknown): Promise<T> => {
          if (!this.gadCaller) {
            return Promise.reject(
              new Error(`gad store not attached yet (call to ${method} during bootstrap)`)
            );
          }
          return this.gadCaller.call<T>(method, input);
        },
      },
    });
    this.projector = new DiskProjector({
      worktrees: this.worktrees,
      workspaceRoot: deps.workspaceRoot,
      contextsRoot: deps.contextsRoot,
      // D2: the workspace root is the ACTIVE context's checkout, not `main`.
      activeContextId: VCS_ACTIVE_CONTEXT_ID,
    });
    // Register the SINGLE post-advance reaction on the shared protected-ref
    // store (narrow-host P3): every successful updateMains — the in-process host
    // push path AND the DO's refs.updateMains RPC — projects + drives the build
    // trigger from HERE, exactly once. No operation path re-does these effects.
    this.deps.refs.onRefsChanged((changes) => this.onMainsUpdated(changes));
  }

  /**
   * Post-advance reaction (narrow-host P3 item 1). Fired once per successful
   * `refs.updateMains` batch, AFTER the swap committed, for BOTH the host push
   * path and the DO's RPC advance. For each advanced repo it projects the new
   * `main` tree to disk and emits the `state-advanced` event the build trigger
   * consumes (build-baseline promotion is reactive, off exactly this event).
   * Batches once: the composed workspace view is computed a single time. The
   * provenance commit identity (`eventId`/`headHash`) is NOT available here —
   * provenance is recorded downstream (gad-owned, eventual), so main-advance
   * events now carry null commit identity. Best-effort per repo: a projection
   * failure is logged and never fails the already-committed advance.
   */
  private async onMainsUpdated(changes: RefChange[]): Promise<void> {
    if (!this.attached) return;
    let workspaceStateHash: string | undefined;
    try {
      workspaceStateHash = await this.composeRepoStatesLocal(await this.collectRepoMainStates());
    } catch {
      workspaceStateHash = undefined;
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
          // archive of the store lineage happens in the deleteRepo lifecycle
          // AFTER this ref delete; disk/build effects never wait on it.
          this.lastState.delete(sk);
          await this.projector.removeRepo(repoPath);
          const removalEvent = await this.stateAdvancedEvent({
            head: VCS_MAIN_HEAD,
            previousStateHash,
            stateHash: EMPTY_STATE_HASH,
            eventId: null,
            headHash: null,
            actor: null,
            transitionKind,
            repoPath,
            ...(workspaceStateHash ? { workspaceStateHash } : {}),
          });
          this.emitter.emit("state-advanced", removalEvent);
          continue;
        }
        this.lastState.set(sk, change.stateHash);
        // D1: `main` has NO on-disk checkout — do not project it. The workspace
        // root is the ACTIVE context's checkout, kept in sync through the ctx
        // edit/commit/scan paths (not from main advances). We still emit the
        // build-driving `state-advanced` event so a push (main advance) promotes
        // the recorded EV baseline reactively via the build trigger.
        const advanceEvent = await this.stateAdvancedEvent({
          head: VCS_MAIN_HEAD,
          previousStateHash,
          stateHash: change.stateHash,
          eventId: null,
          headHash: null,
          actor: null,
          transitionKind,
          repoPath,
          ...(workspaceStateHash ? { workspaceStateHash } : {}),
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
   * seeds every present repo's `main` log from the on-disk workspace tree
   * (per-repo, see {@link ensureRepoLogsFromDisk}), then adopts every repo
   * main into the protected-ref store (`seedMain` — set-if-absent, through
   * `updateMains`, so this is idempotent across restarts and never moves an
   * existing ref while still firing the normal post-advance reaction).
   */
  async attachGad(gad: GadCaller): Promise<void> {
    this.gadCaller = gad;
    if (this.localMain) {
      this.localMain = null;
      this.lastState.delete(VCS_MAIN_HEAD);
    }
    await this.ensureRepoLogsFromDisk();
    await this.seedMainRefsFromStore();
    // Host scan records are host-owned write-ahead data; replay them before the
    // DO's publish-intent heal so ordinary freshness advances never look like
    // uncovered drift after a crash or a bounded retry exhaustion.
    await this.replayDurableMainRecords();
    // Attach-time publish-intent heal is GAD-owned. DO publish intents replay
    // with full provenance; remaining no-intent ref drift is fatal, because
    // refs alone cannot reconstruct the missing authored transition.
    await this.gad().call("vcsHealPublishDrift", {});
  }

  /**
   * Adopt every repo `main` the gad store knows into the protected-ref store.
   * Set-if-absent per repo: an existing ref is NEVER moved (the ref store is
   * the authority; the DO enumeration only bootstraps refs that predate it).
   * Runs on every attach — idempotent across restarts.
   */
  private async seedMainRefsFromStore(): Promise<void> {
    for (const { repoPath, stateHash } of await this.collectRepoMainStatesFromStore()) {
      await this.deps.refs.seedMain({ repoPath, value: stateHash });
    }
  }

  // -------------------------------------------------------------------------
  // Protected main refs (RefService) — the single main-head authority
  // -------------------------------------------------------------------------

  /** The authoritative `main` state of a repo, from the protected-ref store. */
  private mainRefState(repoPath: string): string | null {
    return this.deps.refs.readMain(normalizeRepoPathForLog(repoPath))?.stateHash ?? null;
  }

  /**
   * The authoritative `main` head of a repo AS a worktree-head ref: the state
   * comes from the protected ref; the commit event identity from the gad
   * store's provenance row. Because scan advances record provenance
   * ASYNCHRONOUSLY (a direct fire-and-forget DO ingest), this is a
   * synchronization point for lineage ops: await the repo's in-flight
   * recording, replay any durable host scan record, then — if the DO is still
   * behind — ask the DO to heal publish-intent drift. Only a DO that STILL
   * disagrees after reconciliation is true corruption, and that fails loudly
   * here.
   */
  private async mainWorktreeHead(repoPath: string, logId: string): Promise<WorktreeHeadRef | null> {
    const value = this.mainRefState(repoPath);
    if (!value) return null;
    await this.syncMainProvenance(repoPath, logId, value);
    const doHead = await this.worktrees.resolveWorktreeHead(VCS_MAIN_HEAD, logId);
    if (doHead && doHead.stateHash === value) return doHead;
    throw new Error(
      `main lineage for ${repoPath} is corrupt: protected ref is ${value} but the gad store ` +
        `records ${doHead?.stateHash ?? "<absent>"} even after reconciliation`
    );
  }

  /**
   * Bring the gad DO's main lineage for a repo into lockstep with the
   * protected ref: drain direct recordings, replay landed durable host scan
   * records, then reconcile any remaining DO-authored publish drift. First
   * await any in-flight direct recording for the repo (the fire-and-forget scan
   * record may still be landing); then replay host scan records whose protected
   * ref CAS is present in the ref log; then, if the DO's recorded main still
   * lags the ref, drive the DO's publish-drift heal. The synchronous-DO entry
   * gate for user-initiated lineage ops (push/merge/fork/delete) — the build
   * path never calls this.
   */
  private async syncMainProvenance(
    repoPath: string,
    logId: string,
    refValue?: string | null
  ): Promise<void> {
    const norm = normalizeRepoPathForLog(repoPath);
    await this.awaitInFlightRecord(logId);
    await this.replayDurableMainRecords(norm);
    const value = refValue !== undefined ? refValue : this.mainRefState(norm);
    if (!value) return;
    const doState = await this.worktrees.resolveWorktreeRef(VCS_MAIN_HEAD, logId);
    if (doState === value) return;
    // Still behind: the DO owns the reconcile now (narrow-host P3). Its
    // publish-drift heal completes any covering publish intent with full
    // fidelity; uncovered drift fails closed because refs alone cannot
    // reconstruct the missing authored transition.
    await this.gad().call("vcsHealPublishDrift", {});
  }

  /** Await the in-flight direct provenance recording for a repo (no-op when
   *  none is pending). Never rejects — recording failures are swallowed into
   *  the later durable-replay/publish-drift synchronization point, where
   *  uncovered drift is surfaced to lineage callers. */
  private async awaitInFlightRecord(logId: string): Promise<void> {
    await (this.inFlightRecords.get(logId) ?? Promise.resolve());
  }

  /**
   * Await EVERY in-flight direct recording, replay durable host scan records,
   * then heal any residual DO publish drift — the all-repos flush lineage ops
   * that span the whole workspace (rebase) need before dispatching to the DO.
   * Also the test oracle's drain point.
   */
  async flushMainProvenance(): Promise<void> {
    await Promise.allSettled([...this.inFlightRecords.values()]);
    if (this.attached) {
      await this.replayDurableMainRecords();
      await this.gad().call("vcsHealPublishDrift", {});
    }
  }

  private durableMainRecordDir(): string {
    return path.join(this.deps.contextsRoot, ".main-provenance-records");
  }

  private durableMainRecordPath(id: string): string {
    if (!/^[0-9a-f-]+$/.test(id)) {
      throw new Error(`invalid durable main provenance record id: ${id}`);
    }
    return path.join(this.durableMainRecordDir(), `${id}.json`);
  }

  private async createDurableMainRecord(
    task: Omit<MainRecordTask, "id">
  ): Promise<DurableMainRecord> {
    const record: DurableMainRecord = {
      ...task,
      version: MAIN_RECORD_STORE_VERSION,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
    };
    this.preCasMainRecords.add(record.id);
    try {
      writeJsonFileAtomic(this.durableMainRecordPath(record.id), record);
    } catch (error) {
      this.preCasMainRecords.delete(record.id);
      throw error;
    }
    return record;
  }

  private async discardDurableMainRecord(id: string): Promise<void> {
    this.preCasMainRecords.delete(id);
    try {
      await fsp.rm(this.durableMainRecordPath(id), { force: true });
    } catch (error) {
      console.warn(
        `[Vcs] failed to remove durable main provenance record ${id}:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  private parseDurableMainRecord(value: unknown, source: string): DurableMainRecord | null {
    if (!value || typeof value !== "object") return null;
    const record = value as Partial<DurableMainRecord>;
    const actor = record.actor as Partial<VcsActor> | null | undefined;
    if (
      record.version !== MAIN_RECORD_STORE_VERSION ||
      typeof record.id !== "string" ||
      typeof record.createdAt !== "number" ||
      typeof record.repoPath !== "string" ||
      typeof record.logId !== "string" ||
      (record.prev !== null && typeof record.prev !== "string") ||
      typeof record.next !== "string" ||
      !Array.isArray(record.files) ||
      !actor ||
      typeof actor.id !== "string" ||
      typeof actor.kind !== "string" ||
      typeof record.summary !== "string"
    ) {
      console.warn(`[Vcs] ignoring malformed durable main provenance record: ${source}`);
      return null;
    }
    return record as DurableMainRecord;
  }

  private async readDurableMainRecords(): Promise<DurableMainRecord[]> {
    const dir = this.durableMainRecordDir();
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: DurableMainRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = path.join(dir, entry.name);
      try {
        const parsed = this.parseDurableMainRecord(
          JSON.parse(await fsp.readFile(filePath, "utf8")),
          filePath
        );
        if (parsed) records.push(parsed);
      } catch (error) {
        console.warn(
          `[Vcs] failed to read durable main provenance record ${filePath}:`,
          error instanceof Error ? error.message : error
        );
      }
    }
    return records.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  private durableMainRecordLanded(record: DurableMainRecord): boolean {
    // PHASE-3-OWNED (host main-provenance reconciliation, slated for deletion in
    // narrow-host-boundary-refactor Phase 3). The host main-ref LOG was removed
    // in Phase 5 (`refService` is a semantics-free CAS with no movement log), so
    // "did this transition land?" can no longer consult a per-repo log. Minimal
    // compile-restoring stub: a durable record's transition is considered landed
    // iff the protected ref now holds the record's `next` value (the CAS target).
    // This whole durable-record replay path only ever sees records created by the
    // freshness→main scan, which Phase 2 retargeted off `main`, so no NEW records
    // are produced in production; the stub keeps the dormant replay compiling
    // until Phase 3 deletes it wholesale.
    const repoPath = normalizeRepoPathForLog(record.repoPath);
    return this.mainRefState(repoPath) === record.next;
  }

  private async replayDurableMainRecords(repoPath?: string): Promise<void> {
    const target = repoPath ? normalizeRepoPathForLog(repoPath) : null;
    const blockedRepos = new Set<string>();
    for (const record of await this.readDurableMainRecords()) {
      const norm = normalizeRepoPathForLog(record.repoPath);
      if (target && norm !== target) continue;
      if (blockedRepos.has(norm)) continue;
      if (!this.durableMainRecordLanded(record)) {
        if (this.preCasMainRecords.has(record.id)) continue;
        await this.discardDurableMainRecord(record.id);
        continue;
      }
      const recorded = await this.recordMainAdvance(record);
      if (!recorded) blockedRepos.add(norm);
    }
  }

  /**
   * Record a `main` ref advance (scan/freshness commit) in the gad DO AFTER the
   * fact — the direct replacement for the deleted ProvenanceFollower. Launched
   * fire-and-forget from {@link commitMainHead} and chained per repo through
   * {@link inFlightRecords} so recordings apply in ref order. Never a blocking
   * dependency of the build path.
   *
   * Payload fidelity matches the old follower path: the scan's file listing
   * (no per-file editOps — scan advances adopt the user's on-disk tree and carry
   * no recorded hunks), plus actor/summary/merge-parents. Idempotent: a
   * transition the DO already holds (its head == `next`) is skipped; a DO whose
   * head is neither `next` nor our base `prev` has DRIFTED (a prior record
   * failed / crash gap) — we do NOT force a false-parent record. The later
   * publish-drift synchronization either completes a covering intent or fails
   * closed.
   *
   * A transient DO failure gets a small bounded retry; on exhaustion (or an
   * unattached store) it leaves the durable record for the next explicit
   * synchronization point.
   */
  private async recordMainAdvance(task: MainRecordTask): Promise<boolean> {
    for (let attempt = 0; ; attempt += 1) {
      const gad = this.gadCaller;
      if (!gad) return false; // unattached (bootstrap window) — attach/replay covers it
      try {
        const doState =
          (
            await gad.call<{ stateHash: string } | null>("resolveWorktreeHead", {
              logId: task.logId,
              head: VCS_MAIN_HEAD,
            })
          )?.stateHash ?? null;
        if (doState !== task.next) {
          if (task.prev === null ? doState !== null : doState !== task.prev) {
            // Drift: the DO is off the base this transition extends. Leave the
            // mismatch visible for the next explicit synchronization point.
            return false;
          }
          const result = await gad.call<{ stateHash: string }>("ingestWorktreeState", {
            logId: task.logId,
            head: VCS_MAIN_HEAD,
            logKind: "vcs",
            actor: vcsLogActor(task.actor),
            files: task.files,
            baseStateHash: task.prev ?? EMPTY_STATE_HASH,
            expectedRefStateHash: task.prev ?? EMPTY_STATE_HASH,
            eventKind: "state.snapshot_ingested",
            summary: task.summary,
          });
          if (result.stateHash !== task.next) {
            // Deterministic corruption (shared worktree hashing diverged):
            // retrying cannot help. Scream and leave it to the heal / integrity.
            console.error(
              `[Vcs] main provenance for ${task.repoPath}: DO recorded ${result.stateHash} but ` +
                `the ref advanced to ${task.next} (shared worktree hashing diverged)`
            );
            return false;
          }
        }
        if (task.id) await this.discardDurableMainRecord(task.id);
        return true;
      } catch (error) {
        if (attempt >= RECORD_RETRY_DELAYS_MS.length) {
          console.warn(
            `[Vcs] main provenance record for ${task.repoPath} failed after retries; ` +
              `leaving drift for the next provenance synchronization:`,
            error instanceof Error ? error.message : error
          );
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, RECORD_RETRY_DELAYS_MS[attempt]));
      }
    }
  }

  /** Launch a per-repo-ordered direct provenance recording for a `main`
   *  advance. Fire-and-forget: the build path never awaits it, but each repo's
   *  recordings are serialized so they apply in ref order. */
  private enqueueMainRecord(
    logId: string,
    task: Parameters<WorkspaceVcs["recordMainAdvance"]>[0]
  ): void {
    const prior = this.inFlightRecords.get(logId) ?? Promise.resolve();
    const next = prior.then(async () => {
      await this.recordMainAdvance(task);
    });
    // A record body never rejects (it converts failure into explicit drift at
    // the next synchronization point); guard anyway so an unexpected throw never
    // surfaces as an unhandled rejection.
    next.catch((error) => {
      console.error(`[Vcs] unexpected main provenance record error for ${task.repoPath}:`, error);
    });
    this.inFlightRecords.set(logId, next);
    void next.finally(() => {
      if (this.inFlightRecords.get(logId) === next) this.inFlightRecords.delete(logId);
    });
  }

  /** Advance a repo's protected `main` ref (CAS + injected approval gate). The
   *  in-process host-internal advance path — the freshness/scan-adopt commit
   *  ({@link commitMainHead}) still drives it (Phase 2 moves that to the DO).
   *  The delete/restore/fork sagas that also used it are now DO-owned. */
  private async advanceMainRef(input: {
    repoPath: string;
    expectedOld: string | null;
    next: string;
    actor: { id: string; kind: string };
    reason: string;
    context: RefAdvanceGateContext;
  }): Promise<void> {
    await this.deps.refs.updateMains({
      entries: [
        {
          repoPath: normalizeRepoPathForLog(input.repoPath),
          expectedOld: input.expectedOld,
          next: input.next,
        },
      ],
      gateContext: input.context,
    });
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

  /**
   * Log id for a repo (per-repo VCS). A repoPath is required — there is no
   * whole-tree log to fall back to. The argument is typed `string | undefined`
   * only so the many internal head-routing paths can forward an optional
   * `opts.repoPath` through one chokepoint; an undefined value is a programming
   * error (a head operation reached the store without a repo).
   */
  private repoLogId(repoPath: string | undefined): string {
    if (!repoPath) {
      throw new Error(
        "per-repo VCS: a repoPath is required (no whole-tree vcs:workspace log exists)"
      );
    }
    return logIdForRepo(repoPath);
  }

  /** Working-tree dir for a (repoPath, head) — the projector owns the layout. */
  private dirForRepoHead(repoPath: string | undefined, head: string): string {
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
   * Single-context sync rule (D2): for the active context head this resolves to
   * the workspace root — the context's ONE checkout. `updateSidecar` refreshes
   * the `.gad` baseline against which the NEXT scan diffs, so the scan reports
   * only genuine external drift. Un-projected DO working edits must be projected
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
  }> {
    const dir = this.dirForRepoHead(repoPath, head);
    const { stateHash, files } = await this.worktrees.localState(dir, { updateSidecar: true });
    return { stateHash, files };
  }

  /**
   * The disk-projection PRIMITIVE (host `worktree.project` RPC) — materialize a
   * content-addressed `stateHash` onto the (repoPath, head) working tree. Pure
   * and semantics-free: composes {@link DiskProjector.dirForRepoHead} with
   * {@link WorktreeStore.materializeState} (hardlink CAS tree onto disk) and
   * NOTHING ELSE — no commit, no ref advance, no gad-log append. The gad-store
   * DO drives it to re-materialize a restored/forked repo into the ACTIVE
   * context checkout (`ctx:workspace`); `main` is never projected (D1). Best
   * effort (a disk hiccup never fails the DO saga — the checkout re-syncs on the
   * next ctx edit/scan).
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

  private commitEventIdForHead(ref: WorktreeHeadRef | null, label: string): string | null {
    if (!ref || ref.stateHash === EMPTY_STATE_HASH) return null;
    if (!ref.commitEventId) {
      throw new Error(`${label} has state ${ref.stateHash} but no commit event identity`);
    }
    return ref.commitEventId;
  }

  // -------------------------------------------------------------------------
  // Commit / scan
  // -------------------------------------------------------------------------

  /**
   * Snapshot a head's working tree. Emits `state-advanced` (with precise
   * changed paths) when the state moved. THE single write path for both
   * explicit commits and scan-on-demand freshness. A `main` head routes
   * through the protected-ref CAS ({@link commitMainHead}); ctx heads
   * snapshot directly onto their gad log.
   */
  async commitHead(
    head: string,
    opts: {
      summary?: string;
      actor?: { id: string; kind: string };
      /** Repo the head lives on (per-repo VCS). Required in practice — there is
       *  no whole-tree log; an undefined value throws in `repoLogId`. */
      repoPath?: string;
      /** Advance context for the protected-ref gate when `head` is main.
       *  Defaults to the (ungated) system context — scans adopt the user's own
       *  on-disk edits. */
      mainAdvance?: RefAdvanceGateContext;
    } = {}
  ): Promise<CommitResult> {
    if (head === VCS_MAIN_HEAD) {
      return this.commitMainHead(opts);
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

  /**
   * REMAINING UNGATED disk→main door (narrow-host boundary refactor P2). This
   * scans the workspace-root disk (now the active context's checkout) and
   * advances the protected `main` ref ungated (SYSTEM_ADVANCE). It is NO LONGER
   * reachable from the freshness path — `snapshotRepoLogsFromDisk`/`ensureFresh`
   * now adopt disk drift into the ACTIVE context head, not `main`. It survives
   * ONLY as a bootstrap/import adoption door (`commitHead(VCS_MAIN_HEAD, …)`),
   * and the whole host main-provenance/`advanceMainRef` suite it drives is
   * slated for deletion in P3. Do not re-route ordinary edits/scans through it.
   *
   * Snapshot the `main` working tree through the protected-ref path — the
   * DO-FREE build/freshness commit (P5a): PREPARE the candidate locally
   * (scan + shared-implementation hash + eager content-store mirror, zero DO
   * round trips), then ADVANCE the ref (compare-and-swap against the value
   * the candidate was computed from + the injected approval gate — a denial
   * or a lost race aborts with zero state change and the loop re-prepares).
   * Once the ref adopts the candidate the commit IS complete for every build
   * consumer (trees/diffs/build sources all resolve from the content store);
   * the gad-store provenance recording is handed to the async direct recorder,
   * backed by the durable scan record, so a failing or slow DO can delay
   * history, never builds.
   *
   * The per-head lock is NOT held across the ref advance, so a parked
   * approval never blocks reads/scans of other repos.
   */
  private async commitMainHead(opts: {
    summary?: string;
    actor?: { id: string; kind: string };
    repoPath?: string;
    mainAdvance?: RefAdvanceGateContext;
  }): Promise<CommitResult> {
    const actor = opts.actor ?? USER_ACTOR;
    const context = opts.mainAdvance ?? SYSTEM_ADVANCE;
    const repoPath = normalizeRepoPathForLog(
      opts.repoPath ??
        (() => {
          throw new Error("per-repo VCS: a repoPath is required to commit main");
        })()
    );
    const logId = this.repoLogId(repoPath);
    const sk = this.stateKey(logId, VCS_MAIN_HEAD);
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const prepared = await this.prepareMainScan(repoPath, logId, actor);
      if (prepared.kind === "unchanged") return prepared.result;
      const candidate = prepared.candidate;
      const durableRecord = await this.createDurableMainRecord({
        repoPath,
        logId,
        prev: candidate.prev,
        next: candidate.stateHash,
        files: candidate.files,
        actor,
        summary: opts.summary ?? "workspace scan",
      });

      try {
        // CAS from the value the candidate was COMPUTED against (not a fresh
        // read): a concurrent advance between prepare and here must conflict
        // and re-prepare — a stale scan may never overwrite a newer ref.
        await this.advanceMainRef({
          repoPath,
          expectedOld: candidate.prev,
          next: candidate.stateHash,
          actor,
          reason: opts.summary ?? "workspace scan",
          context,
        });
      } catch (error) {
        await this.discardDurableMainRecord(durableRecord.id);
        if (isRefConflictError(error)) {
          lastError = error;
          continue;
        }
        throw error;
      }
      this.preCasMainRecords.delete(durableRecord.id);

      // The ref moved — the commit is complete. The `updateMains` post-advance
      // reaction already projected main and emitted the single build-driving
      // `state-advanced` event. Everything below is bookkeeping + ASYNC
      // provenance; nothing here may block on the DO.
      this.lastState.set(sk, candidate.stateHash);
      this.enqueueMainRecord(logId, durableRecord);
      return {
        stateHash: candidate.stateHash,
        // The provenance event is recorded asynchronously (direct DO ingest) —
        // there is no DO event identity at commit time (pre-release break).
        eventId: "",
        headHash: "",
        fileCount: candidate.fileCount,
        unchanged: false,
        head: VCS_MAIN_HEAD,
        changedPaths: candidate.event.changedPaths,
      };
    }
    throw new Error(
      `commit main: gave up after concurrent-advance retries on ${repoPath}: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`
    );
  }

  /**
   * Prepare a `main` scan candidate entirely locally: scan + hash the repo's
   * working tree (shared worktree hashing; blobs + tree mirrored into the
   * content store eagerly), diff against the protected ref, and build the
   * state-advanced event. No gad-store involvement — the scan is fully DO-free.
   */
  private async prepareMainScan(
    repoPath: string,
    logId: string,
    actor: { id: string; kind: string }
  ): Promise<
    { kind: "candidate"; candidate: PreparedMainScan } | { kind: "unchanged"; result: CommitResult }
  > {
    const sk = this.stateKey(logId, VCS_MAIN_HEAD);
    return this.locked(sk, async () => {
      // The workspace-root disk (now the active context's checkout, D1) is the
      // source for this bootstrap/import-only main seed.
      const dir = this.dirForRepoHead(repoPath, VCS_ACTIVE_CONTEXT_HEAD);
      const prev = this.mainRefState(repoPath);

      // Missing working dir: a no-op against the ref (sparse/unmaterialized —
      // deletion is an explicit, gated op, never inferred from absent disk).
      try {
        await fsp.access(dir);
      } catch {
        return {
          kind: "unchanged" as const,
          result: {
            stateHash: prev ?? EMPTY_STATE_HASH,
            eventId: "",
            headHash: "",
            fileCount: 0,
            unchanged: true,
            head: VCS_MAIN_HEAD,
            changedPaths: [],
          },
        };
      }

      const local = await this.worktrees.localState(dir, { updateSidecar: true });
      // Unchanged fast path — compared against the PROTECTED REF (the
      // authority), never the gad store's possibly-lagging head.
      if (prev && prev === local.stateHash) {
        this.lastState.set(sk, local.stateHash);
        return {
          kind: "unchanged" as const,
          result: {
            stateHash: local.stateHash,
            eventId: "",
            headHash: "",
            fileCount: local.files.length,
            unchanged: true,
            head: VCS_MAIN_HEAD,
            changedPaths: [],
          },
        };
      }

      const event = await this.stateAdvancedEvent({
        head: VCS_MAIN_HEAD,
        previousStateHash: prev,
        stateHash: local.stateHash,
        eventId: null,
        headHash: null,
        actor,
        transitionKind: "snapshot",
        repoPath,
      });
      return {
        kind: "candidate" as const,
        candidate: {
          prev,
          stateHash: local.stateHash,
          files: local.files,
          fileCount: local.files.length,
          event,
        },
      };
    });
  }

  // -------------------------------------------------------------------------
  // Worktree ingest (FS → GAD)
  //
  // The internal worktree-snapshot primitive: scan a head's working tree and
  // ingest any out-of-band changes onto the head. This is the FS→GAD boundary
  // — needed because `main` IS the real workspace (direct edits, `git push`),
  // and used by bootstrap, merge resolution, and tests. It is NOT exposed over
  // RPC: sandboxed callers commit through `edit` (edit-first), never by
  // snapshotting their context worktree behind GAD's back.
  // -------------------------------------------------------------------------

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
    // D2: freshness adopts out-of-band disk drift into the ACTIVE context
    // (working edits on its `ctx:*` heads via the ungated ctx path), NOT an
    // ungated `main` advance. The fresh state consumers build against is the
    // active context's composed view (the live union of repo mains overlaid
    // with this context's working edits), not the plain `main` union.
    await this.snapshotRepoLogsFromDisk();
    return { stateHash: await this.resolveContextView(VCS_ACTIVE_CONTEXT_ID) };
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
      return this.localMain?.stateHash ?? null;
    }
    if (head === VCS_MAIN_HEAD) {
      this.repoLogId(repoPath); // per-repo VCS: a repoPath is required
      return this.mainRefState(repoPath!);
    }
    return await this.worktrees.resolveWorktreeRef(head, this.repoLogId(repoPath));
  }

  async discoverGraph(stateHash: string): Promise<PackageGraph> {
    const sourceRoot = await this.materializeStateForGraphDiscovery(stateHash);
    return discoverPackageGraph(sourceRoot);
  }

  private gad(): GadCaller {
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
    /** When set, the diff/state are subtree-rooted on this repo's log; the
     *  event is re-rooted to workspace-relative for the build trigger (finding
     *  #1): changedPaths/fileChanges get the repo prefix and the build
     *  `stateHash` becomes the composed workspace view. `repoPath` is carried as
     *  routing metadata. */
    repoPath?: string;
  }): Promise<StateAdvancedEvent> {
    const fileChanges =
      input.previousStateHash === input.stateHash
        ? []
        : await this.diffFileChanges(input.previousStateHash, input.stateHash);

    if (!input.repoPath) {
      return {
        head: input.head,
        stateHash: input.stateHash,
        repoStateHash: input.stateHash,
        sinceStateHash: input.previousStateHash,
        eventId: input.eventId,
        headHash: input.headHash,
        actor: input.actor,
        transitionKind: input.transitionKind,
        changedPaths: fileChanges.map((change) => change.path),
        fileChanges,
        editOps: input.editOps ?? [],
      };
    }

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
          (await this.workspaceViewWithRepoAtSafe(repoPath, input.stateHash)) ??
          input.stateHash)
        : ctxId
          ? await this.resolveContextView(ctxId).catch(() => input.stateHash)
          : input.stateHash;
    const sinceStateHash =
      input.head === VCS_MAIN_HEAD
        ? ((await this.workspaceViewWithRepoAtSafe(repoPath, input.previousStateHash)) ??
          input.previousStateHash)
        : ctxId
          ? await this.gad()
              .call<{ stateHash: string }>("vcsComposedViewWithRepoAt", {
                contextId: ctxId,
                repoPath,
                repoStateHash: input.previousStateHash,
              })
              .then((r) => r.stateHash)
              .catch(() => input.previousStateHash)
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

  /** Best-effort composed workspace view with one repo overlaid. Used while a
   *  candidate `main` advance is still uncommitted, so approval/build events see
   *  the state that WOULD exist after the candidate rather than stale live main. */
  private async workspaceViewWithRepoAtSafe(
    repoPath: string,
    repoStateHash: string | null
  ): Promise<string | null> {
    try {
      return await this.workspaceViewWithRepoAt(repoPath, repoStateHash);
    } catch {
      return null;
    }
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
   * Fork a context's FILE state for {@link runtime.cloneContext}: snapshot the
   * SOURCE's full working view (every edited repo at its committed ctx head
   * COMPOSED WITH its uncommitted edits; unedited repos at the pinned base) and
   * pin it as the TARGET context's base. The target materializes the source's
   * exact files and then diverges with its own ctx heads.
   *
   * Trade-off (intended): the target reads the snapshot as a CLEAN base — it does
   * NOT inherit the source's per-repo ctx-head lineage or ahead/behind/uncommitted
   * status. The file CONTENT is identical; the VCS history is flattened to a pin.
   */
  async forkContext(sourceContextId: string, targetContextId: string): Promise<void> {
    const snapshot = await this.resolveContextView(sourceContextId);
    await this.pinContext(targetContextId, snapshot);
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
  async materializeContextRepos(contextId: string, repos: string[] | "all"): Promise<void> {
    const targets = await this.gad().call<Array<{ repoPath: string; stateHash: string }>>(
      "vcsContextRepoStates",
      { contextId, repos }
    );
    const mat = this.materializedFor(contextId);
    for (const { repoPath, stateHash } of targets) {
      const norm = normalizeRepoPathForLog(repoPath);
      if (mat.get(norm) === stateHash) continue; // already on disk at the right state
      await this.locked(this.stateKey(this.repoLogId(repoPath), `mat:${contextId}`), () =>
        this.projector.project({
          repoPath,
          head: vcsContextHead(contextId),
          stateHash,
          clean: true,
        })
      );
      mat.set(norm, stateHash);
    }
  }

  async ensureContextFolder(contextId: string): Promise<{ dir: string; head: string }> {
    const head = vcsContextHead(contextId);
    const dir = this.contextDir(contextId);
    // Sparse: ensure the folder EXISTS but materialize nothing — repos are
    // written on demand by `materializeContextRepos`.
    await fsp.mkdir(dir, { recursive: true });
    return { dir, head };
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
    // The DO resolves each repo's `main` through the protected ref and
    // requires its own lineage in lockstep — await every in-flight recording
    // (and heal crash gaps) before dispatching.
    await this.flushMainProvenance();
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
    }>
  > {
    return this.gad().call("vcsContextStatus", { contextId });
  }

  /**
   * Fork a repo's entire `main` history into a NEW repo at `toPath` — a no-copy
   * lineage fork (`forkLog`): the new repo's `vcs:repo:<toPath>` history descends
   * from the source, so `log --repo <toPath>` shows the inherited events and
   * later edits build on that lineage. The `package.json` `name` leaf is rewritten
   * to the new path so the fork doesn't collide with the source in the build graph
   * (it is immediately build-valid). Deeper renames (component/class names) are the
   * caller's job. Errors if the source has no history or the destination exists.
   */
  async forkRepo(
    fromPath: string,
    toPath: string,
    actor: { id: string; kind: string } = USER_ACTOR
  ): Promise<{ repoPath: string; head: string; inherited: number; stateHash: string }> {
    // Phase 4: the fork SAGA is DO-owned (`vcsForkRepo`) — lineage fork, the
    // package-rename bootstrap commit, the gated ref creation, and disk
    // projection all run in the gad-store DO over the host primitives. In-process
    // shim ONLY for the host integration tests; production routes userland → DO.
    return this.gad().call("vcsForkRepo", { fromPath, toPath, actor });
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
   * merge on conflict. This host side is the disk follower: synchronize main
   * provenance first when the SOURCE is `main` (the DO resolves main through
   * the protected ref and requires its own lineage in lockstep), then project
   * the returned state, acknowledge conflict materialization, write the
   * conflict summary, and emit build/reactive events.
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
      repoPath?: string;
    } = {}
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
      // A `main` source resolves through the protected ref inside the DO,
      // which requires its recorded main lineage to be in lockstep.
      if (sourceHead === VCS_MAIN_HEAD && repoPath) {
        await this.syncMainProvenance(repoPath, logId);
      }
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
        if (repoPath) {
          this.noteContextMaterialized(
            targetHead.slice("ctx:".length),
            repoPath,
            outcome.stateHash
          );
        }
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
      if (repoPath) {
        this.noteContextMaterialized(targetHead.slice("ctx:".length), repoPath, outcome.stateHash);
      }
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

  /** The source head's commits not yet on the target (first-parent walk from
   *  `theirs` back to `oursState`) — the structured upstream-commits list
   *  shared by `vcs.merge` and the push-divergence error. */
  private async upstreamCommitsBetween(
    oursState: string,
    theirsState: string,
    theirsEventId?: string | null
  ): Promise<
    Array<{ eventId: string; message: string; stateHash: string; createdAt: string | null }>
  > {
    if (theirsEventId) {
      return this.upstreamCommitsBetweenEvents(oursState, theirsEventId);
    }
    const out: Array<{
      eventId: string;
      message: string;
      stateHash: string;
      createdAt: string | null;
    }> = [];
    let cur: string | null = theirsState;
    for (let i = 0; i < 100; i++) {
      if (!cur || cur === oursState || cur === EMPTY_STATE_HASH) break;
      const stateHash: string = cur;
      const prod = await this.gad().call<{
        event_id?: string;
        summary?: string | null;
        input_state_hash?: string | null;
        created_at?: string | null;
      } | null>("getGadStateProducer", { stateHash });
      if (!prod?.event_id) break;
      out.push({
        eventId: String(prod.event_id),
        message: prod.summary ? String(prod.summary) : "",
        stateHash: cur,
        createdAt: prod.created_at ? String(prod.created_at) : null,
      });
      cur = prod.input_state_hash ? String(prod.input_state_hash) : null;
    }
    return out;
  }

  private async upstreamCommitsBetweenEvents(
    stopState: string,
    tipEventId: string
  ): Promise<
    Array<{ eventId: string; message: string; stateHash: string; createdAt: string | null }>
  > {
    const out: Array<{
      eventId: string;
      message: string;
      stateHash: string;
      createdAt: string | null;
    }> = [];
    let cur: string | null = tipEventId;
    for (let i = 0; i < 100; i++) {
      if (!cur) break;
      const transition = await this.gad().call<{
        output_state_hash?: string | null;
        summary?: string | null;
        created_at?: string | null;
      } | null>("getGadStateTransition", { eventId: cur });
      const stateHash = transition?.output_state_hash ? String(transition.output_state_hash) : null;
      if (!stateHash || stateHash === stopState || stateHash === EMPTY_STATE_HASH) break;
      out.push({
        eventId: cur,
        message: transition?.summary ? String(transition.summary) : "",
        stateHash,
        createdAt: transition?.created_at ? String(transition.created_at) : null,
      });
      const ancestors: Array<{
        eventId: string;
        stateHash: string | null;
        parentEventIds: string[];
      }> = await this.gad().call("commitAncestors", { eventId: cur, limit: 1 });
      cur = ancestors[0]?.parentEventIds[0] ?? null;
    }
    return out;
  }
  /**
   * Write or remove the worktree merge-conflict summary for a head, driven off
   * its pending-merge record. Non-content conflicts (mode / binary /
   * delete-vs-change) leave no in-file `<<<<<<<` markers, so this file is the
   * only worktree-visible signal for CLI/agent/direct users. It is ignored by
   * snapshots (never committed) and removed when the merge resolves or aborts.
   */
  private async syncConflictSummary(head: string, repoPath?: string): Promise<void> {
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
      repoPath?: string;
    } = {}
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
    repoPath?: string
  ): Promise<{
    theirsHead: string;
    conflicts: Array<{ path: string; kind: string }>;
  } | null> {
    const pending = (
      await this.gad().call<{
        info: { theirsHead: string; conflicts: Array<{ path: string; kind: string }> } | null;
      }>("getPendingMerge", { logId: this.repoLogId(repoPath), head: targetHead })
    ).info;
    return pending ? { theirsHead: pending.theirsHead, conflicts: pending.conflicts } : null;
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
    repoPath?: string;
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
    repoPath: string | undefined,
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
    if (repoPath && head.startsWith("ctx:")) {
      this.noteContextMaterialized(head.slice("ctx:".length), repoPath, result.stateHash);
    }
    const changedPaths = repoPath
      ? result.changedPaths.map((p) => joinRepoPrefix(repoPath, p))
      : result.changedPaths;
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
      }>("commitWorking", {
        logId,
        head: input.head,
        message: input.message,
        actor: vcsLogActor(input.actor),
        invocationId: input.invocationId ?? null,
        turnId: input.turnId ?? null,
        exclude: input.exclude ?? null,
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
  private async resolveCommittedBase(head: string, repoPath: string | undefined): Promise<string> {
    this.repoLogId(repoPath); // per-repo VCS: a repoPath is required
    if (head !== VCS_MAIN_HEAD) {
      throw new Error(`resolveCommittedBase: only main-target merges resolve here (got ${head})`);
    }
    return this.mainRefState(repoPath!) ?? EMPTY_STATE_HASH;
  }

  /** Re-derive a head's working content IN THE DO (committed base + remaining
   *  uncommitted ops; staged + mirrored there) and project it to disk;
   *  returns the working state hash. */
  private async reprojectWorking(
    logId: string,
    head: string,
    repoPath: string | undefined
  ): Promise<string> {
    const resolved = await this.gad().call<{ stateHash: string | null }>("resolveWorkingState", {
      logId,
      head,
    });
    const stateHash = resolved.stateHash ?? EMPTY_STATE_HASH;
    await this.projector.project({ repoPath, head, stateHash, clean: true, bestEffort: true });
    if (head.startsWith("ctx:") && repoPath) {
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
  // Traversal reads (edit/commit graph) moved USERLAND (P5c): the gad-store
  // DO's `vcs*` read surface (vcsFileHistory / vcsCommitEdits /
  // vcsCommitAncestors / vcsEditsBy* / vcsLog) is dispatched to directly via
  // the `vcs` manifest service — no host wrappers remain.
  // -------------------------------------------------------------------------

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
      : (await this.workspaceView()).stateHash;
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
    repoPath?: string;
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
    diverged: boolean;
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

  // -------------------------------------------------------------------------
  // Memory file indexing (WS4) — bytes live in the CAS, so the server feeds
  // changed file text to the store's FTS index after main-head advances.
  // -------------------------------------------------------------------------

  private memoryIndexQueue: Promise<void> = Promise.resolve();

  /**
   * Start incremental per-repo file indexing on a repo's `main`-head advances
   * (W8). Each repo's index is keyed by its own `memidx:<repoPath>` marker
   * (rebuilt after cache amnesia). Indexed paths are re-rooted to
   * workspace-relative so recall returns globally-addressable paths regardless
   * of which repo owns the file.
   */
  enableMemoryIndexing(): void {
    this.onStateAdvanced((event) => {
      if (event.head !== VCS_MAIN_HEAD) return;
      const repoPath = event.repoPath;
      if (!repoPath) return; // per-repo only; legacy whole-tree advances ignored
      this.memoryIndexQueue = this.memoryIndexQueue
        .then(() => this.indexRepoFiles(repoPath))
        .catch((error) => console.warn("[VcsMemory] index failed:", error));
    });
    // Catch up on whatever happened while the server was down: index each
    // discovered repo's current main.
    this.memoryIndexQueue = this.memoryIndexQueue
      .then(async () => {
        for (const repo of await this.discoverRepos()) {
          await this.indexRepoFiles(repo.repoPath).catch((error) =>
            console.warn(`[VcsMemory] initial index for ${repo.repoPath} failed:`, error)
          );
        }
      })
      .catch((error) => console.warn("[VcsMemory] initial index failed:", error));
  }

  /** Index a single repo's `main` head into the FTS index (W8). */
  async indexRepoFiles(repoPath: string): Promise<void> {
    if (!this.attached) return;
    const norm = normalizeRepoPathForLog(repoPath);
    const stateHash = await this.resolveHead(VCS_MAIN_HEAD, norm);
    if (!stateHash) return;
    const markerKey = `memidx:${norm}`;
    const marker = (
      await this.gad().call<{ value: string | null }>("getMemoryIndexMarker", { key: markerKey })
    ).value;
    if (marker === stateHash) return;

    const MAX_INDEXED_FILE_BYTES = 256 * 1024;
    const reroot = (p: string): string => joinRepoPrefix(norm, p);
    const files: Array<{ path: string; contentHash: string; text: string }> = [];
    let removedPaths: string[] = [];
    const wanted: Array<{ path: string; content_hash: string }> = [];
    if (marker) {
      // Content-store diff: the fresh main state may not be recorded in the
      // gad DO yet (async provenance recorder) but is always mirrored.
      const diff = await this.diffStates(marker, stateHash);
      wanted.push(
        ...diff.added.map((file) => ({ path: file.path, content_hash: file.contentHash })),
        ...diff.changed.map((file) => ({ path: file.path, content_hash: file.toContentHash }))
      );
      removedPaths = diff.removed.map((file) => reroot(file.path));
    } else {
      wanted.push(...(await this.worktrees.listStateFiles(stateHash)));
    }
    for (const file of wanted) {
      const bytes = await getBytes(this.deps.blobsDir, file.content_hash);
      if (!bytes) {
        // A missing CAS blob is transient (content-bridge lag / GC race): abort
        // the whole pass WITHOUT advancing the marker, so the next main advance
        // retries this state. Advancing here would permanently un-index this
        // file version with no trace (a later diff starts from the advanced
        // marker and never revisits it).
        console.warn(
          `[VcsMemory] index aborted for ${norm}: missing CAS blob ${file.content_hash} ` +
            `for ${reroot(file.path)}; marker left at prior state, will retry on next advance`
        );
        return;
      }
      if (bytes.length > MAX_INDEXED_FILE_BYTES) {
        console.warn(
          `[VcsMemory] skip ${reroot(file.path)}: over index size cap ` +
            `(${bytes.length} > ${MAX_INDEXED_FILE_BYTES} bytes)`
        );
        continue;
      }
      if (bytes.subarray(0, 8192).includes(0)) {
        console.warn(`[VcsMemory] skip ${reroot(file.path)}: binary content (null byte sniff)`);
        continue;
      }
      files.push({
        path: reroot(file.path),
        contentHash: file.content_hash,
        text: bytes.toString("utf8"),
      });
    }
    if (files.length > 0 || removedPaths.length > 0) {
      await this.gad().call("indexMemoryFiles", { files, removedPaths });
    }
    await this.gad().call("setMemoryIndexMarker", { key: markerKey, value: stateHash });
  }

  /**
   * Provenance-carrying memory search (messages, claims, files). `repoPaths`
   * scopes file results to the selected repos; omit to search across all. The
   * SCOPING SEMANTICS live in the gad-store DO: the prefix predicate is
   * pushed into its query so `limit` bounds the already-scoped result set —
   * this side only normalizes repo paths and dispatches.
   */
  async recallMemory(input: {
    query: string;
    kinds?: string[];
    limit?: number;
    repoPaths?: string[];
  }): Promise<unknown> {
    const { repoPaths, ...rest } = input;
    const prefixes =
      repoPaths && repoPaths.length > 0 ? repoPaths.map((r) => normalizeRepoPathForLog(r)) : null;
    return await this.gad().call("recallMemory", {
      ...rest,
      ...(prefixes ? { pathPrefixes: prefixes } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // Workspace view — live union of repo mains (W3)
  // -------------------------------------------------------------------------

  /**
   * Enumerate the repo set from the live composed workspace view's file list
   * (build-unit repos ∪ content-only repos ∪ `meta`). Purely a function of the
   * tracked paths of every repo's `main`. An empty workspace (no repo mains)
   * composes to the empty state ⇒ no repos.
   */
  async discoverRepos(): Promise<DiscoveredRepo[]> {
    const repoStates = await this.collectRepoMainStates();
    if (repoStates.length === 0) return [];
    const composed = await this.composeRepoStatesLocal(repoStates);
    const files = await collectTreeFiles(this.deps.blobsDir, composed);
    if (files === null) throw new Error(`discoverRepos: composed view ${composed} not resolvable`);
    return discoverRepos(files.map((f) => f.path));
  }

  /**
   * Severe, global-state action: permanently remove a repo from the workspace.
   * Distinct from an edit/snapshot — it does not ADVANCE a repo head, it RETIRES
   * one. The repo's `main` history is ARCHIVED (moved to a non-`main` archive
   * head — fully preserved and restorable), the repo is dropped from the composed
   * workspace view (so build discovery / materialize stop seeing it — the proper
   * close to the deletion gap that `snapshotDir` deliberately cannot infer), its
   * on-disk subtree is removed, and a synthetic `main` advance is emitted so the
   * build trigger / tree scanner re-discover without it. User approval is gated
   * upstream in the service layer (a dedicated severe per-repo capability); this
   * performs the already-authorized deletion. Idempotent only insofar as it
   * throws when the repo has no committed `main`.
   */
  /** Workspace-relative paths of repos whose build unit directly depends on
   *  `repoPath`'s unit, at a workspace state. Empty when `repoPath` is content-
   *  only (not a build unit) or has no dependents — used to gate deletion. */
  private async dependentRepoPaths(repoPath: string, atStateHash: string): Promise<string[]> {
    const graph = await this.discoverGraph(atStateHash);
    const node = graph.allNodes().find((n) => normalizeRepoPathForLog(n.relativePath) === repoPath);
    if (!node) return []; // content-only repo (not in the build graph)
    const deps = new Set<string>();
    for (const depName of graph.getReverseDeps(node.name)) {
      const depNode = graph.tryGet(depName);
      if (depNode) deps.add(normalizeRepoPathForLog(depNode.relativePath));
    }
    deps.delete(repoPath);
    return [...deps].sort();
  }

  /**
   * Dependents lookup for the DELETION approval gate (narrow-host-vcs-plan §5):
   * repos whose build unit imports `repoPath`, resolved against the LIVE
   * workspace view. Host-computed from the build dependency graph and surfaced
   * in the severe deletion prompt so the user sees what will break. Best-effort
   * (a graph/view failure yields no dependents rather than blocking the prompt).
   */
  async deleteDependents(repoPath: string): Promise<string[]> {
    try {
      const view = await this.workspaceView();
      return await this.dependentRepoPaths(normalizeRepoPathForLog(repoPath), view.stateHash);
    } catch {
      return [];
    }
  }

  async deleteRepo(input: {
    repoPath: string;
    actor: { id: string; kind: string };
    caller: VerifiedCaller;
    force?: boolean;
  }): Promise<{
    repoPath: string;
    archived: boolean;
    archiveHead: string | null;
    removedPaths: string[];
    dependents: string[];
    stateHash: string;
  }> {
    // Phase 4: the delete SAGA is DO-owned (`vcsDeleteRepo`). The severe deletion
    // prompt still fires HOST-side, classified from the null-next CAS shape (D3);
    // production attributes it to the originating caller via the relay-minted
    // token. `caller` is dropped here — this in-process shim exists ONLY for the
    // host integration tests, which supply the gate caller through the bridge.
    return this.gad().call("vcsDeleteRepo", {
      repoPath: input.repoPath,
      actor: input.actor,
      ...(input.force ? { force: true } : {}),
    });
  }

  /**
   * Recover a deleted repo: re-point its `main` at its most recent archive head
   * (the reverse of {@link deleteRepo}'s archival), re-materialize it on disk and
   * emit a `main` advance so build/tree re-discover it. FAILS if a live `main`
   * already exists for the path — i.e. a DIFFERENT repo was created there since
   * the deletion — rather than clobbering it. Approval is raised ONCE by the ref
   * gate's restore classification when the re-creating `updateMains` runs (the
   * host ref log shows the prior delete). Throws when there is nothing archived
   * to restore.
   */
  async restoreRepo(input: {
    repoPath: string;
    actor: { id: string; kind: string };
    caller: VerifiedCaller;
  }): Promise<{
    repoPath: string;
    restored: boolean;
    fromArchiveHead: string | null;
    restoredPaths: string[];
    stateHash: string;
  }> {
    // Phase 4: the restore SAGA is DO-owned (`vcsRestoreRepo`) — un-archive, the
    // gated ref re-creation (an add-repo prompt classified from the CAS shape,
    // D3), and disk re-projection into `ctx:workspace`. In-process shim ONLY for
    // the host integration tests (which drive the DO via `this.gad()` and supply
    // the gate caller through the bridge); production routes userland → DO.
    return this.gad().call("vcsRestoreRepo", {
      repoPath: input.repoPath,
      actor: input.actor,
    });
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
        await this.deps.refs.seedMain({ repoPath, value: existing });
        continue;
      }
      // BOOTSTRAP/ADOPTION DOOR (the one remaining disk→main seed): read the
      // repo subtree from the workspace root — which is now the ACTIVE context's
      // checkout (D1: `main` has no dir of its own) — and seed the repo's `main`
      // log + protected ref from it. This is a set-if-absent bootstrap, not the
      // freshness path (freshness adopts into the active context, above); it
      // runs only for repos with no `main` yet.
      const dir = this.dirForRepoHead(repoPath, VCS_ACTIVE_CONTEXT_HEAD);
      const snap = await this.locked(this.stateKey(logId, VCS_MAIN_HEAD), () =>
        this.worktrees.snapshotDir(dir, {
          head: VCS_MAIN_HEAD,
          logId,
          actor: SYSTEM_ACTOR,
          summary: `seed ${repoPath} from disk`,
        })
      );
      // Bootstrap adoption of on-disk content — seed, not a gated advance.
      await this.deps.refs.seedMain({ repoPath, value: snap.stateHash });
      this.lastState.set(this.stateKey(logId, VCS_MAIN_HEAD), snap.stateHash);
    }
  }

  /**
   * Snapshot every present on-disk repo subtree onto the ACTIVE context's
   * `ctx:*` head (D2). The workspace root IS that context's checkout, so this
   * is the freshness-adopt of out-of-band disk drift: it captures external
   * edits (direct edits, `git pull`, import config writes in `meta/vibez1.yml`)
   * as WORKING edits on the active context — never an ungated `main` advance.
   *
   * Routes through {@link commitHead}'s ctx branch: it snapshots directly onto
   * the gad log with NO protected-ref CAS and NO approval gate, preserving the
   * `.gad` sidecar (size/mtime) fast path (`snapshotDir` reads + refreshes it),
   * so a clean workspace scan re-produces the ctx head's last projected state
   * and is a cheap no-op (single-context sync rule — projected DO edits are not
   * re-adopted).
   */
  async snapshotRepoLogsFromDisk(
    opts: {
      summary?: string;
      actor?: { id: string; kind: string };
    } = {}
  ): Promise<void> {
    if (!this.attached) return;
    for (const repo of await this.discoverReposFromDisk()) {
      await this.commitHead(VCS_ACTIVE_CONTEXT_HEAD, {
        summary: opts.summary ?? "workspace scan",
        actor: opts.actor ?? SYSTEM_ACTOR,
        repoPath: repo.repoPath,
      });
    }
  }

  /**
   * Every repo's current `main`, from the PROTECTED-REF STORE (the single
   * main-head authority). Returns `{ repoPath, stateHash }` pairs for
   * `composeRepoStatesLocal`, sorted by repo path.
   */
  private collectRepoMainStates(): Promise<Array<{ repoPath: string; stateHash: string }>> {
    return Promise.resolve(
      this.deps.refs
        .listMains()
        .filter((record) => record.stateHash !== EMPTY_STATE_HASH)
        .map((record) => ({ repoPath: record.repoPath, stateHash: record.stateHash }))
    );
  }

  /**
   * Enumerate repo mains from the gad store's worktree-head rows — ONLY for
   * seeding the protected-ref store at attach ({@link seedMainRefsFromStore})
   * and for git-import adoption. Never a main-head authority read.
   */
  private collectRepoMainStatesFromStore(): Promise<
    Array<{ repoPath: string; stateHash: string }>
  > {
    return this.collectRepoHeadStates(VCS_MAIN_HEAD);
  }

  /**
   * Every repo log that has the given head (`main` or `ctx:{contextId}`), as
   * `{ repoPath, stateHash }`. This reads structured worktree-head rows instead
   * of parsing storage-encoded ref names.
   */
  private async collectRepoHeadStates(
    headName: string
  ): Promise<Array<{ repoPath: string; stateHash: string }>> {
    const heads = await this.gad().call<Array<{ logId: string; head: string; stateHash: string }>>(
      "listWorktreeHeads",
      { logIdPrefix: VCS_REPO_LOG_PREFIX, head: headName }
    );
    const out: Array<{ repoPath: string; stateHash: string }> = [];
    for (const head of heads) {
      const repoPath = repoPathFromLogId(head.logId);
      if (!repoPath) continue;
      out.push({ repoPath, stateHash: head.stateHash });
    }
    return out.sort((a, b) => a.repoPath.localeCompare(b.repoPath));
  }

  /**
   * Compose repo subtree states into one workspace-rooted view ENTIRELY in
   * the content store — no gad DO. Byte-identical to the DO's own composition
   * (both re-root each repo's file listing under its repoPath and hash with
   * the shared canonical implementation), but works
   * for states the DO has not (yet) recorded — which is exactly the
   * freshness-path situation now that provenance recording is asynchronous.
   * Cached by the (repoPath=state) composition key; compositions are
   * content-addressed so the cache can never go stale.
   */
  private readonly composedViewCache = new Map<string, string>();
  private async composeRepoStatesLocal(
    repos: Array<{ repoPath: string; stateHash: string }>
  ): Promise<string> {
    if (repos.length === 0) {
      await mirrorWorktreeTree(this.deps.blobsDir, []);
      return EMPTY_STATE_HASH;
    }
    const key = repos
      .map((repo) => `${normalizeRepoPathForLog(repo.repoPath)}=${repo.stateHash}`)
      .sort()
      .join("\n");
    const cached = this.composedViewCache.get(key);
    if (cached) return cached;
    const files: Array<{ path: string; contentHash: string; mode: number }> = [];
    for (const repo of repos) {
      await this.worktrees.ensureStateMirrored(repo.stateHash);
      const listing = await collectTreeFiles(this.deps.blobsDir, repo.stateHash);
      if (listing === null) {
        throw new Error(
          `composeRepoStatesLocal: repo ${repo.repoPath} state ${repo.stateHash} is not resolvable`
        );
      }
      const prefix = normalizeRepoPathForLog(repo.repoPath);
      for (const file of listing) {
        files.push({
          path: `${prefix}/${file.path}`,
          contentHash: file.contentHash,
          mode: file.mode,
        });
      }
    }
    const { stateHash } = await mirrorWorktreeTree(this.deps.blobsDir, files);
    if (this.composedViewCache.size >= 128) {
      const oldest = this.composedViewCache.keys().next().value;
      if (oldest !== undefined) this.composedViewCache.delete(oldest);
    }
    this.composedViewCache.set(key, stateHash);
    return stateHash;
  }

  /**
   * The live workspace view: the composed union of every repo's `main` head
   * state. A workspace-rooted state for whole-tree consumers (build discovery,
   * materialize, diff, git export). No pins, no lockfile. Composed in the
   * CONTENT STORE (never the gad DO) so freshness/build consumers work even
   * while the async provenance recorder is still draining.
   */
  async workspaceView(): Promise<{ stateHash: string }> {
    const repoStates = await this.collectRepoMainStates();
    // Empty workspace (no repo mains) composes to the empty state — there is no
    // whole-tree log to fall back to.
    return { stateHash: await this.composeRepoStatesLocal(repoStates) };
  }

  /**
   * The composed workspace view with ONE repo overridden to a candidate state
   * (or removed when `stateHash` is null): the workspace AS IT WOULD BE if
   * `repoPath` advanced to that state. Used to give main-advance approval and
   * push validation the CANDIDATE composed view, so pre-commit checks analyze the
   * new state rather than the still-current one.
   */
  async workspaceViewWithRepoAt(repoPath: string, stateHash: string | null): Promise<string> {
    return this.workspaceViewWithReposAt([{ repoPath, stateHash }]);
  }

  /**
   * The composed workspace view with a BATCH of repos overridden to candidate
   * states (`stateHash: null` removes the repo): the workspace AS IT WOULD BE
   * after an atomic {@link RefService.updateMains} batch. The batch form of
   * {@link workspaceViewWithRepoAt} — used by the reshaped main-advance gate to
   * compute ONE candidate view (and dedup key) for a whole batch.
   */
  async workspaceViewWithReposAt(
    overrides: Array<{ repoPath: string; stateHash: string | null }>
  ): Promise<string> {
    const overrideByNorm = new Map<string, string | null>();
    for (const o of overrides) overrideByNorm.set(normalizeRepoPathForLog(o.repoPath), o.stateHash);
    const repos = (await this.collectRepoMainStates()).filter(
      (r) => !overrideByNorm.has(normalizeRepoPathForLog(r.repoPath))
    );
    for (const [norm, stateHash] of overrideByNorm) {
      if (stateHash) repos.push({ repoPath: norm, stateHash });
    }
    return this.composeRepoStatesLocal(repos);
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
    const treeSweep = await pruneUnreferencedTreeObjects(this.deps.blobsDir, {
      referenced: [
        ...new Set([
          ...roots.protectedBlobDigests,
          ...roots.protectedTreeDigests,
          ...(mark.liveBlobDigests ?? []),
        ]),
      ],
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
    repoPath?: string
  ): Promise<{
    stateHash: string | null;
    dirty: boolean;
    uncommitted: number;
    added: string[];
    removed: string[];
    changed: string[];
    /** The repo was deleted from the workspace (its `main` is archived/gone). */
    deleted: boolean;
  }> {
    this.repoLogId(repoPath); // per-repo VCS: a repoPath is required
    return await this.gad().call("vcsStatus", {
      repoPath: normalizeRepoPathForLog(repoPath!),
      head,
    });
  }
}
