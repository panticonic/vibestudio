import { createDevLogger } from "@vibestudio/dev-log";
import type { WorkspaceVcs } from "../vcsHost/workspaceVcs.js";

const log = createDevLogger("VcsGcScheduler");

export const DEFAULT_VCS_GC_MIN_AGE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_VCS_GC_INTERVAL_MS = 60 * 60 * 1000;
export const DEFAULT_VCS_GC_INITIAL_DELAY_MS = 60_000;

/** The maintenance surface the hourly scheduler drives: blob GC plus the two
 *  provenance-adjacent passes (the U5 post-replay reindex kick and the DO's
 *  soft-state prune). */
type SchedulerVcs = Pick<
  WorkspaceVcs,
  "attached" | "runGc" | "reindexKnownRepos" | "pruneProvenanceSoftState"
>;

export interface VcsGcSchedulerDeps {
  workspaceVcs: SchedulerVcs;
  minAgeMs?: number;
  intervalMs?: number;
  initialDelayMs?: number;
  logger?: { warn: (msg: string, ...args: unknown[]) => void };
}

export class VcsGcScheduler {
  private readonly workspaceVcs: SchedulerVcs;
  private readonly minAgeMs: number;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly logger: { warn: (msg: string, ...args: unknown[]) => void };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private running = false;

  constructor(deps: VcsGcSchedulerDeps) {
    this.workspaceVcs = deps.workspaceVcs;
    this.minAgeMs = deps.minAgeMs ?? DEFAULT_VCS_GC_MIN_AGE_MS;
    this.intervalMs = deps.intervalMs ?? DEFAULT_VCS_GC_INTERVAL_MS;
    this.initialDelayMs = deps.initialDelayMs ?? DEFAULT_VCS_GC_INITIAL_DELAY_MS;
    this.logger = deps.logger ?? log;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(this.initialDelayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async runOnce(): Promise<boolean> {
    if (this.running || !this.workspaceVcs.attached) return false;
    this.running = true;
    try {
      let ok = true;
      // Blob/tree GC (owner-derived roots ∪ the DO's live blob set).
      try {
        await this.workspaceVcs.runGc({ minAgeMs: this.minAgeMs });
      } catch (err) {
        ok = false;
        this.logger.warn("[VcsGcScheduler] GC run failed:", err);
      }
      // Periodic file-index kick — closes the post-replay `memidx:` wipe window
      // (U5); the per-repo marker fast-path keeps already-indexed repos cheap.
      try {
        await this.workspaceVcs.reindexKnownRepos();
      } catch (err) {
        ok = false;
        this.logger.warn("[VcsGcScheduler] reindex kick failed:", err);
      }
      // Provenance soft-state prune (touches / render log / provenance cache).
      // Tolerant of the DO method not having landed yet (see WorkspaceVcs).
      try {
        await this.workspaceVcs.pruneProvenanceSoftState();
      } catch (err) {
        ok = false;
        this.logger.warn("[VcsGcScheduler] provenance soft-state prune failed:", err);
      }
      return ok;
    } finally {
      this.running = false;
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.runOnce().finally(() => {
          this.schedule(this.intervalMs);
        });
      },
      Math.max(0, delayMs)
    );
    if (typeof this.timer.unref === "function") this.timer.unref();
  }
}
