import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import { serializeByKey } from "@vibestudio/shared/keyedSerializer";

export interface EntityRetirementCleanupDeps {
  resolveRecord(id: string): Promise<EntityRecord | null>;
  /** All resources and credentials must be released before this operation returns. */
  cleanup(record: EntityRecord): Promise<void>;
  /** Completion is conditional on the same retired authority lifetime. */
  complete(id: string, authoritySessionId: string): Promise<void>;
}

export interface EntityRetirementCleanup {
  retire(record: EntityRecord): Promise<void>;
  quiesce(): Promise<void>;
}

/** One owner for runtime, startup and reaper cleanup of each exact entity lifetime. */
export function createEntityRetirementCleanup(
  deps: EntityRetirementCleanupDeps
): EntityRetirementCleanup {
  const chains = new Map<string, Promise<unknown>>();
  const flights = new Map<string, Map<string, Promise<void>>>();
  let closed = false;

  const retire = (record: EntityRecord): Promise<void> => {
    const id = record.id;
    const lifetime = record.authoritySessionId;
    if (closed) return Promise.reject(new Error("Entity retirement cleanup stopped"));
    if (record.status !== "retired" || !lifetime)
      return Promise.reject(new Error(`Entity ${id} has no retired authority lifetime`));
    const existing = flights.get(id)?.get(lifetime);
    if (existing) return existing;
    const flight = serializeByKey(chains, id, async () => {
      const current = await deps.resolveRecord(id);
      if (
        !current ||
        current.status !== "retired" ||
        current.authoritySessionId !== lifetime ||
        current.cleanupComplete
      )
        return;
      // Reactivation remains fenced by cleanupComplete=false until every owned
      // teardown finishes. Completion is the final durable mutation in this flight.
      await deps.cleanup(current);
      await deps.complete(current.id, lifetime);
    });
    const lifetimes = flights.get(id) ?? new Map<string, Promise<void>>();
    flights.set(id, lifetimes);
    lifetimes.set(lifetime, flight);
    const release = () => {
      lifetimes.delete(lifetime);
      if (lifetimes.size === 0 && flights.get(id) === lifetimes) flights.delete(id);
    };
    void flight.then(release, release);
    return flight;
  };

  return {
    retire,
    async quiesce() {
      closed = true;
      const results = await Promise.allSettled(
        [...flights.values()].flatMap((values) => [...values.values()])
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (failures.length > 0)
        throw new AggregateError(failures, "Entity retirement cleanup failed during shutdown", {
          cause: failures[0],
        });
    },
  };
}
