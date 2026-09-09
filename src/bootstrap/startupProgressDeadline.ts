import type { StartupConnectionProgress } from "../startupConnectionProgress.js";

/**
 * How long the host may report nothing new before startup is declared stuck.
 *
 * This is a *silence* budget, not a cap on startup duration. A cold first run
 * provisions and builds an entire workspace inside a single startup phase, and
 * on a slow machine that one phase can run for minutes while everything is
 * working. Failing such a startup on total elapsed time punishes slow machines
 * for succeeding slowly; only an absence of news is evidence of a wedge.
 */
export const STARTUP_NO_PROGRESS_TIMEOUT_MS = 180_000;

export interface StartupProgressReport {
  mode: string;
  startupProgress?: StartupConnectionProgress | null;
}

/**
 * The part of a host report that changes when startup moves forward. Two equal
 * signatures mean the host has told us nothing new.
 */
export function startupProgressSignature(state: StartupProgressReport): string {
  const progress = state.startupProgress;
  if (!progress) return `${state.mode}:none`;
  const plan = progress.phases.map((phase) => phase.id).join(",");
  return `${state.mode}:${plan}>${progress.currentPhase}`;
}

export interface StartupProgressDeadline {
  /** Restart the budget — a new startup attempt begins. */
  restart(now?: number): void;
  /** Restart the budget only if this deadline has never been started. */
  restartIfIdle(now?: number): void;
  /** Record a host report, restarting the budget if it says something new. */
  note(state: StartupProgressReport, now?: number): void;
  /** True once the host has been silent for longer than the budget. */
  stalled(now?: number): boolean;
}

export function createStartupProgressDeadline(
  budgetMs: number = STARTUP_NO_PROGRESS_TIMEOUT_MS
): StartupProgressDeadline {
  let advancedAt = 0;
  let signature: string | null = null;
  return {
    restart(now = Date.now()) {
      advancedAt = now;
      signature = null;
    },
    restartIfIdle(now = Date.now()) {
      if (!advancedAt) advancedAt = now;
    },
    note(state, now = Date.now()) {
      const next = startupProgressSignature(state);
      // An unchanged report is not news: the budget keeps running so a wedged
      // host still fails, while any advance buys another full budget.
      if (next === signature) return;
      signature = next;
      advancedAt = now;
    },
    stalled(now = Date.now()) {
      return now - advancedAt >= budgetMs;
    },
  };
}
