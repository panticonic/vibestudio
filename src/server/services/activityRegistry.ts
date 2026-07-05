/**
 * activityRegistry — lightweight in-process registry of long-running background
 * work (agent/eval runs, builds, future schedulers).
 *
 * Work sources report `begin`/`end` as runs start and finish; the idle-exit
 * monitor reads the aggregate to decide when a detached server has gone idle,
 * without querying DOs on demand.
 */

export interface HostActivity {
  activeRuns: number;
  oldestStartedAt: number | null;
}

export interface ActivityRegistry {
  /** Mark a unit of background work as active. Ids are source-scoped, e.g. `eval:<runId>`. */
  begin(id: string): void;
  /** Mark a unit of background work as finished. Unknown ids are ignored. */
  end(id: string): void;
  getActivity(): HostActivity;
}

export function createActivityRegistry(now: () => number = Date.now): ActivityRegistry {
  const active = new Map<string, number>();
  return {
    begin(id: string): void {
      if (!active.has(id)) active.set(id, now());
    },
    end(id: string): void {
      active.delete(id);
    },
    getActivity(): HostActivity {
      let oldest: number | null = null;
      for (const startedAt of active.values()) {
        if (oldest === null || startedAt < oldest) oldest = startedAt;
      }
      return { activeRuns: active.size, oldestStartedAt: oldest };
    },
  };
}
