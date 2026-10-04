/**
 * cleanupReaper — background task that retries cleanup hooks for entities
 * whose durable retire succeeded but whose post-retire hooks failed.
 *
 * The reaper queries WorkspaceDO for rows with `retired_at IS NOT NULL AND
 * cleanup_complete = 0` and calls the shared exact-lifetime cleanup owner.
 * It's a safety net; on a clean run there is nothing to do.
 */

import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import type { DoDispatcher, DORef } from "@vibestudio/shared/doDispatcher";

export interface CleanupReaperDeps {
  doDispatch: DoDispatcher;
  workspaceDORef: DORef;
  onRetire: (record: EntityRecord) => Promise<void>;
  intervalMs?: number;
  logger?: { warn: (msg: string, ...args: unknown[]) => void };
}

export interface CleanupReaper {
  start: () => void;
  stop: () => Promise<void>;
  /** Run one pass synchronously. Returns count processed. */
  sweep: () => Promise<number>;
}

const DEFAULT_INTERVAL_MS = 30_000;

export function createCleanupReaper(deps: CleanupReaperDeps): CleanupReaper {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let flight: Promise<number> | null = null;

  async function runSweep(): Promise<number> {
    const rows = (await deps.doDispatch.dispatch(
      deps.workspaceDORef,
      "entityFindIncompleteCleanups"
    )) as EntityRecord[];
    let processed = 0;
    for (const record of rows) {
      try {
        await deps.onRetire(record);
        processed += 1;
      } catch (err) {
        deps.logger?.warn(`cleanupReaper: retry failed for ${record.id}:`, err);
      }
    }
    return processed;
  }

  function sweep(): Promise<number> {
    if (flight) return Promise.resolve(0);
    const current = runSweep();
    flight = current;
    const release = () => {
      if (flight === current) flight = null;
    };
    void current.then(release, release);
    return current;
  }

  return {
    start: () => {
      if (timer) return;
      timer = setInterval(() => {
        void sweep().catch((err) => {
          deps.logger?.warn("cleanupReaper sweep crashed:", err);
        });
      }, intervalMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop: async () => {
      if (timer) clearInterval(timer);
      timer = null;
      if (flight) await flight;
    },
    sweep,
  };
}
