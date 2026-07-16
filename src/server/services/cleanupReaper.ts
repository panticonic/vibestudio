/**
 * cleanupReaper — background task that retries cleanup hooks for entities
 * whose durable retire succeeded but whose post-retire hooks failed.
 *
 * The reaper queries WorkspaceDO for rows with `retired_at IS NOT NULL AND
 * cleanup_complete = 0`, re-runs the hooks, then marks cleanup_complete=1.
 * It's a safety net; on a clean run there is nothing to do.
 */

import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import type { ContextCleanupRecord } from "@vibestudio/shared/runtime/contextCleanup";
import type { DoDispatcher, DORef } from "@vibestudio/shared/doDispatcher";

export interface CleanupReaperDeps {
  doDispatch: DoDispatcher;
  workspaceDORef: DORef;
  onRetire: (record: EntityRecord) => Promise<void>;
  onContextCleanup?: (record: ContextCleanupRecord) => Promise<void>;
  intervalMs?: number;
  logger?: { warn: (msg: string, ...args: unknown[]) => void };
}

export interface CleanupReaper {
  start: () => void;
  stop: () => void;
  /** Run one pass synchronously. Returns count processed. */
  sweep: () => Promise<number>;
}

const DEFAULT_INTERVAL_MS = 30_000;

export function createCleanupReaper(deps: CleanupReaperDeps): CleanupReaper {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function sweep(): Promise<number> {
    if (running) return 0;
    running = true;
    try {
      const rows = (await deps.doDispatch.dispatch(
        deps.workspaceDORef,
        "entityFindIncompleteCleanups"
      )) as EntityRecord[];
      let processed = 0;
      for (const record of rows) {
        try {
          await deps.onRetire(record);
          await deps.doDispatch.dispatch(deps.workspaceDORef, "entityCleanupComplete", record.id);
          processed += 1;
        } catch (err) {
          deps.logger?.warn(`cleanupReaper: retry failed for ${record.id}:`, err);
        }
      }
      if (deps.onContextCleanup) {
        const contexts = (await deps.doDispatch.dispatch(
          deps.workspaceDORef,
          "contextCleanupListPending"
        )) as ContextCleanupRecord[];
        for (const record of contexts) {
          try {
            await deps.onContextCleanup(record);
            processed += 1;
          } catch (err) {
            deps.logger?.warn(`cleanupReaper: context retry failed for ${record.contextId}:`, err);
          }
        }
      }
      return processed;
    } finally {
      running = false;
    }
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
    stop: () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    sweep,
  };
}
