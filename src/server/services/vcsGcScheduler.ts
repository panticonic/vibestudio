import type { WorkspaceVcs } from "../vcsHost/workspaceVcs.js";

export const DEFAULT_VCS_GC_MIN_AGE_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_VCS_GC_INTERVAL_MS = 60 * 60 * 1_000;
export const DEFAULT_VCS_GC_INITIAL_DELAY_MS = 60_000;

/** Drives the one owner-derived semantic/content reachability collector. */
export class VcsGcScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly deps: {
      workspaceVcs: Pick<WorkspaceVcs, "attached" | "runGc">;
      minAgeMs?: number;
      intervalMs?: number;
      initialDelayMs?: number;
      logger?: { warn(message: string, error: unknown): void };
    }
  ) {}

  start(): void {
    if (this.timer) return;
    this.schedule(this.deps.initialDelayMs ?? DEFAULT_VCS_GC_INITIAL_DELAY_MS);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<boolean> {
    if (this.running || !this.deps.workspaceVcs.attached) return false;
    this.running = true;
    try {
      await this.deps.workspaceVcs.runGc({
        minAgeMs: this.deps.minAgeMs ?? DEFAULT_VCS_GC_MIN_AGE_MS,
      });
      return true;
    } catch (error) {
      (this.deps.logger ?? console).warn("[VcsGcScheduler] GC run failed", error);
      return false;
    } finally {
      this.running = false;
    }
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce().finally(() =>
        this.schedule(this.deps.intervalMs ?? DEFAULT_VCS_GC_INTERVAL_MS)
      );
    }, delay);
    this.timer.unref?.();
  }
}
