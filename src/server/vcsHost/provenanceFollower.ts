/**
 * ProvenanceFollower — the ASYNC provenance recorder for protected-ref
 * `main` advances (eviction stage P5a).
 *
 * The protected-ref store (RefService) is the sole `main` authority; the gad
 * DO holds downstream provenance (commit chain / history). On the
 * build/freshness path (workspace scans, `ensureFresh`) the ref advance is
 * the WHOLE commit: the state is mirrored in the content store and the ref
 * has moved, so builds proceed immediately. Recording the transition in the
 * gad DO is this follower's job — per-repo serialized, retried with backoff,
 * and NEVER a blocking dependency of the build path. A DO failure only delays
 * provenance, never builds.
 *
 * Two task kinds flow through each repo's FIFO queue:
 *
 *  - `record` — append the exact ref transition (prev → next, with the scan's
 *    file listing and actor/summary/parents) as an `ingestWorktreeState` on
 *    the repo's log. Idempotent: a task whose `next` the DO already has (or
 *    whose ref seq was already applied) is skipped.
 *  - `reconcile` — the ref→DO half of drift healing: when the DO's main
 *    lineage is BEHIND the ref (crash between ref advance and provenance
 *    recording, or a wedged synchronous ingest), ingest the target state's
 *    tree from the CONTENT STORE (listing via `collectTreeFiles`; bytes are
 *    already in the CAS) as a coarse catch-up transition based on the DO's
 *    current head. `record` invokes this implicitly when the DO head does not
 *    match the task's `prev` — so orderly recording never needs the DO CAS to
 *    reject anything.
 *
 * Failure surface: transient DO errors retry on a bounded quick schedule and
 * then park the queue in `stalled` (visible via {@link status}; flush()
 * waiters reject) while a slow timer keeps retrying until the DO recovers.
 * Deterministic impossibilities — the content store cannot resolve the tree,
 * or the DO computes a different hash for the same listing — are TRUE
 * corruption: they log loudly and drop the task (`onPermanentFailure` hook
 * for tests/telemetry); the next attach-time reconcile is the recovery path.
 */

import { EMPTY_STATE_HASH } from "@vibez1/shared/contentTree/worktreeHash";
import { vcsLogActor, VCS_MAIN_HEAD, type VcsActor } from "./paths.js";
import { collectTreeFiles } from "./worktreeStore.js";

/** Narrow call surface onto the gad-store DO. */
interface GadCaller {
  call<T = unknown>(method: string, input: unknown): Promise<T>;
}

/** A ref transition to record in the gad DO after the fact. */
interface FollowerRecordTask {
  kind: "record";
  repoPath: string;
  logId: string;
  /** RefService seq of the advance that produced this task — the idempotence
   *  / ordering key (a task at or below the last applied seq is skipped). */
  seq: number;
  /** Ref value the advance replaced (null = ref creation). */
  prev: string | null;
  /** Ref value the advance installed (the recorded transition's output). */
  next: string;
  /** Scan file listing for `next` (sizes known — the scan held them). */
  files: Array<{ path: string; contentHash: string; size?: number; mode: number }>;
  actor: VcsActor;
  summary: string;
  eventKind: "state.snapshot_ingested" | "state.merge_applied";
  parentStateHashes?: string[];
  parentEventIds?: string[];
  /** Consume the parked pending merge on this head after recording (the scan
   *  was a merge-resolution commit). */
  clearPendingMerge?: boolean;
}

interface FollowerReconcileTask {
  kind: "reconcile";
  repoPath: string;
  logId: string;
  /** Ref value the DO must catch up to. */
  target: string;
}

type FollowerTask = (FollowerRecordTask | FollowerReconcileTask) & {
  resolve: () => void;
  reject: (err: unknown) => void;
  attempts: number;
};

/** Deterministic — retrying cannot help; drop the task and scream. */
class FollowerPermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FollowerPermanentError";
  }
}

interface FollowerDeps {
  blobsDir: string;
  /** Live gad caller, or null while unattached (tasks wait for attach). */
  gad: () => GadCaller | null;
  /** Quick in-band retry delays before the queue is declared stalled. */
  retryDelaysMs?: number[];
  /** Slow-poll interval while stalled (the DO may come back much later). */
  slowRetryMs?: number;
  /** Observability hook: a task was dropped as permanently failed. */
  onPermanentFailure?: (task: FollowerRecordTask | FollowerReconcileTask, err: unknown) => void;
  /** Hook run after a record task lands (clear pending merge bookkeeping). */
  onRecorded?: (task: FollowerRecordTask) => Promise<void> | void;
}

const DEFAULT_RETRY_DELAYS_MS = [250, 1000, 3000, 10_000];
const DEFAULT_SLOW_RETRY_MS = 30_000;

interface RepoQueue {
  tasks: FollowerTask[];
  pumping: boolean;
  stalled: boolean;
  /** Highest ref seq applied to the DO this process lifetime. */
  lastAppliedSeq: number;
  /** Resolvers waiting for the queue to drain. */
  flushWaiters: Array<{ resolve: () => void; reject: (err: unknown) => void }>;
  timer: NodeJS.Timeout | null;
}

export class ProvenanceFollower {
  private readonly queues = new Map<string, RepoQueue>();
  private stopped = false;

  constructor(private readonly deps: FollowerDeps) {}

  /** Stop background retries (tests / teardown). Queued tasks are abandoned. */
  stop(): void {
    this.stopped = true;
    for (const queue of this.queues.values()) {
      if (queue.timer) clearTimeout(queue.timer);
      queue.timer = null;
      const err = new Error("provenance follower stopped");
      for (const task of queue.tasks) task.reject(err);
      queue.tasks = [];
      for (const waiter of queue.flushWaiters) waiter.reject(err);
      queue.flushWaiters = [];
    }
  }

  /** Pending task count (all repos, or one). */
  pendingCount(repoPath?: string): number {
    if (repoPath !== undefined) return this.queue(repoPath).tasks.length;
    let count = 0;
    for (const queue of this.queues.values()) count += queue.tasks.length;
    return count;
  }

  status(): Array<{ repoPath: string; pending: number; stalled: boolean }> {
    return [...this.queues.entries()]
      .filter(([, queue]) => queue.tasks.length > 0 || queue.stalled)
      .map(([repoPath, queue]) => ({
        repoPath,
        pending: queue.tasks.length,
        stalled: queue.stalled,
      }));
  }

  /**
   * Enqueue a ref transition for asynchronous DO recording. Fire-and-forget
   * by design (the build path never awaits it); the returned promise settles
   * when the DO recording lands (tests, flush-style callers) and REJECTS only
   * on permanent failure or stop — transient DO failures keep retrying.
   */
  enqueueRecord(task: Omit<FollowerRecordTask, "kind">): Promise<void> {
    return this.enqueue({ ...task, kind: "record" });
  }

  /**
   * Heal the DO's main lineage up to `target` (the ref value) — the on-demand
   * ref→DO reconciler. Serialized through the repo's queue so it can never
   * interleave with in-flight record tasks. No-op when already in lockstep.
   */
  reconcile(repoPath: string, logId: string, target: string): Promise<void> {
    return this.enqueue({ kind: "reconcile", repoPath, logId, target });
  }

  /**
   * Resolve when the repo's queue (or every queue) is drained. Rejects when a
   * queue is/becomes stalled — callers needing synchronous DO semantics (push,
   * merge, lineage reads) must not wait indefinitely on a dead DO.
   */
  flush(repoPath?: string): Promise<void> {
    const repoPaths = repoPath !== undefined ? [repoPath] : [...this.queues.keys()];
    return Promise.all(
      repoPaths.map((repo) => {
        const queue = this.queue(repo);
        if (queue.tasks.length === 0 && !queue.pumping) return Promise.resolve();
        if (queue.stalled) {
          return Promise.reject(
            new Error(`gad provenance follower stalled for ${repo} (DO unreachable?)`)
          );
        }
        return new Promise<void>((resolve, reject) => {
          queue.flushWaiters.push({ resolve, reject });
        });
      })
    ).then(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Queue machinery
  // -------------------------------------------------------------------------

  private queue(repoPath: string): RepoQueue {
    let queue = this.queues.get(repoPath);
    if (!queue) {
      queue = {
        tasks: [],
        pumping: false,
        stalled: false,
        lastAppliedSeq: 0,
        flushWaiters: [],
        timer: null,
      };
      this.queues.set(repoPath, queue);
    }
    return queue;
  }

  private enqueue(task: FollowerRecordTask | FollowerReconcileTask): Promise<void> {
    if (this.stopped) {
      const rejected = Promise.reject(new Error("provenance follower stopped"));
      rejected.catch(() => undefined); // fire-and-forget callers never observe it
      return rejected;
    }
    const queue = this.queue(task.repoPath);
    const promise = new Promise<void>((resolve, reject) => {
      queue.tasks.push({ ...task, resolve, reject, attempts: 0 });
    });
    // Settlement is surfaced through the returned promise / flush(); an
    // un-awaited enqueue (the build path) must never surface as unhandled.
    promise.catch(() => undefined);
    this.pump(task.repoPath);
    return promise;
  }

  private pump(repoPath: string): void {
    const queue = this.queue(repoPath);
    if (queue.pumping) return;
    queue.pumping = true;
    void this.drain(repoPath, queue).finally(() => {
      queue.pumping = false;
      if (queue.tasks.length === 0 && !queue.stalled) {
        for (const waiter of queue.flushWaiters) waiter.resolve();
        queue.flushWaiters = [];
      }
    });
  }

  private async drain(repoPath: string, queue: RepoQueue): Promise<void> {
    while (!this.stopped) {
      const task = queue.tasks[0];
      if (!task) return;
      try {
        await this.runTask(queue, task);
        queue.tasks.shift();
        queue.stalled = false;
        task.resolve();
      } catch (err) {
        if (err instanceof FollowerPermanentError) {
          // True corruption / impossibility: drop LOUDLY, keep the queue
          // moving (attach-time reconcile is the recovery path).
          queue.tasks.shift();
          console.error(
            `[GadFollower] PERMANENT failure recording ${task.kind} for ${repoPath}: ${err.message}`
          );
          this.deps.onPermanentFailure?.(task, err);
          task.reject(err);
          continue;
        }
        task.attempts += 1;
        const delays = this.deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
        const exhausted = task.attempts > delays.length;
        const delay = exhausted
          ? (this.deps.slowRetryMs ?? DEFAULT_SLOW_RETRY_MS)
          : delays[task.attempts - 1]!;
        console.warn(
          `[GadFollower] ${task.kind} for ${repoPath} failed (attempt ${task.attempts}` +
            `${exhausted ? ", stalled" : ""}), retrying in ${delay}ms:`,
          err instanceof Error ? err.message : err
        );
        if (exhausted && !queue.stalled) {
          queue.stalled = true;
          const stallErr = new Error(
            `gad provenance follower stalled for ${repoPath}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
          for (const waiter of queue.flushWaiters) waiter.reject(stallErr);
          queue.flushWaiters = [];
        }
        queue.timer = setTimeout(() => {
          queue.timer = null;
          this.pump(repoPath);
        }, delay);
        queue.timer.unref?.();
        return; // leave drain; the timer re-pumps
      }
    }
  }

  // -------------------------------------------------------------------------
  // Task bodies
  // -------------------------------------------------------------------------

  private gadOrThrow(): GadCaller {
    const gad = this.deps.gad();
    if (!gad) throw new Error("gad store not attached");
    return gad;
  }

  private async doHeadState(gad: GadCaller, logId: string): Promise<string | null> {
    const head = await gad.call<{ stateHash: string } | null>("resolveWorktreeHead", {
      logId,
      head: VCS_MAIN_HEAD,
    });
    return head?.stateHash ?? null;
  }

  private async runTask(queue: RepoQueue, task: FollowerTask): Promise<void> {
    const gad = this.gadOrThrow();
    if (task.kind === "reconcile") {
      await this.reconcileToState(gad, task.logId, task.repoPath, task.target);
      return;
    }

    // Idempotence / ordering: never re-apply (or apply out of order) a ref
    // transition this process already recorded. Cross-restart idempotence is
    // the DO-head check below plus the attach-time reconcile.
    if (task.seq <= queue.lastAppliedSeq) return;
    const doState = await this.doHeadState(gad, task.logId);
    if (doState === task.next) {
      queue.lastAppliedSeq = Math.max(queue.lastAppliedSeq, task.seq);
      await this.deps.onRecorded?.(task);
      return;
    }
    // Crash gap / lineage behind: catch the DO up to the transition's base
    // BEFORE recording, so the recorded transition always attaches to real,
    // in-order lineage (and the DO's known-parent guard never fires).
    if (task.prev !== null && doState !== task.prev) {
      await this.reconcileToState(gad, task.logId, task.repoPath, task.prev);
    }
    const result = await gad.call<{ stateHash: string }>("ingestWorktreeState", {
      logId: task.logId,
      head: VCS_MAIN_HEAD,
      logKind: "vcs",
      actor: vcsLogActor(task.actor),
      files: task.files,
      baseStateHash: task.prev ?? undefined,
      ...(task.prev !== null ? { expectedRefStateHash: task.prev } : {}),
      eventKind: task.eventKind,
      summary: task.summary,
      ...(task.parentStateHashes?.length ? { parentStateHashes: task.parentStateHashes } : {}),
      ...(task.parentEventIds?.length ? { parentEventIds: task.parentEventIds } : {}),
    });
    if (result.stateHash !== task.next) {
      throw new FollowerPermanentError(
        `DO recorded ${result.stateHash} for ${task.logId} but the ref advanced to ${task.next} ` +
          `(shared worktree hashing diverged)`
      );
    }
    queue.lastAppliedSeq = Math.max(queue.lastAppliedSeq, task.seq);
    await this.deps.onRecorded?.(task);
  }

  /**
   * The reconciler primitive: ingest `target`'s tree (content-store listing)
   * onto the repo's main log as a coarse catch-up transition from the DO's
   * CURRENT head. No-op when already there. Throws FollowerPermanentError
   * when the content store cannot resolve the target tree — that is real
   * corruption (the mirroring invariant says every ref value resolves), and
   * retrying cannot fix it.
   */
  private async reconcileToState(
    gad: GadCaller,
    logId: string,
    repoPath: string,
    target: string
  ): Promise<void> {
    const doState = await this.doHeadState(gad, logId);
    if (doState === target) return;
    if (target === EMPTY_STATE_HASH) return; // nothing to materialize for an empty ref
    const files = await collectTreeFiles(this.deps.blobsDir, target);
    if (files === null) {
      throw new FollowerPermanentError(
        `cannot reconcile ${repoPath} main to ${target}: tree not resolvable in the content store`
      );
    }
    const result = await gad.call<{ stateHash: string }>("ingestWorktreeState", {
      logId,
      head: VCS_MAIN_HEAD,
      logKind: "vcs",
      actor: vcsLogActor({ id: "system", kind: "system" }),
      files,
      // Honest lineage: the catch-up transition is based on whatever the DO
      // last recorded (its head), not on a claimed intermediate.
      baseStateHash: doState ?? undefined,
      eventKind: "state.snapshot_ingested",
      summary: `reconcile ${repoPath} main provenance to protected ref ${target}`,
      metadata: { reconcile: true },
    });
    if (result.stateHash !== target) {
      throw new FollowerPermanentError(
        `reconcile of ${repoPath} main produced ${result.stateHash}, expected ${target} ` +
          `(shared worktree hashing diverged)`
      );
    }
    console.warn(
      `[GadFollower] reconciled ${repoPath} main provenance: DO was at ` +
        `${doState ?? "<absent>"}, caught up to ref ${target}`
    );
  }
}
