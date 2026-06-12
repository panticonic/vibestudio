/**
 * Coalesce refresh calls while still honoring invalidations that arrive
 * during an in-flight refresh. The latest task is run, and if another
 * caller asks for a refresh before it settles, one follow-up pass runs
 * immediately after the current pass.
 */

export interface QueuedRefresh {
  run(task: () => void | Promise<void>): Promise<void>;
  reset(): void;
}

export function createQueuedRefresh(): QueuedRefresh {
  let inFlight: Promise<void> | null = null;
  let queued = false;
  let latestTask: (() => void | Promise<void>) | null = null;
  let generation = 0;

  return {
    run(task) {
      latestTask = task;
      if (inFlight) {
        queued = true;
        return inFlight;
      }
      const runGeneration = generation;
      let currentTask: (() => void | Promise<void>) | null = task;
      inFlight = Promise.resolve().then(async () => {
        while (runGeneration === generation) {
          if (!currentTask) return;
          await currentTask();
          if (!queued) return;
          queued = false;
          currentTask = latestTask;
        }
      }).finally(() => {
        if (runGeneration === generation) {
          inFlight = null;
        }
      });
      return inFlight;
    },
    reset() {
      generation += 1;
      inFlight = null;
      queued = false;
      latestTask = null;
    },
  };
}
