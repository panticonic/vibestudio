import { createDevLogger } from "@vibez1/dev-log";
import type { WorkspaceVcs } from "../vcsHost/workspaceVcs.js";

const log = createDevLogger("VcsGcScheduler");

export const DEFAULT_VCS_GC_MIN_AGE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_VCS_GC_INTERVAL_MS = 60 * 60 * 1000;
export const DEFAULT_VCS_GC_INITIAL_DELAY_MS = 60_000;

export interface VcsGcSchedulerDeps {
  workspaceVcs: Pick<WorkspaceVcs, "attached" | "runGc">;
  minAgeMs?: number;
  intervalMs?: number;
  initialDelayMs?: number;
  logger?: { warn: (msg: string, ...args: unknown[]) => void };
}

export class VcsGcScheduler {
  private readonly workspaceVcs: Pick<WorkspaceVcs, "attached" | "runGc">;
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
      await this.workspaceVcs.runGc({ minAgeMs: this.minAgeMs });
      return true;
    } catch (err) {
      this.logger.warn("[VcsGcScheduler] GC run failed:", err);
      return false;
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
