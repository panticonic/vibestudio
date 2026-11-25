import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { serializeRpcFailure, deserializeRpcFailure } from "@vibestudio/rpc";
import { cacheOwnerIsAlive, cacheProcessIdentity } from "@vibestudio/shared/derivedCache";
import { BuildPriorityOwner, hasBuildSlotCapacity, type BuildPriority } from "./builderLifetime.js";
import { runWithOwnedCleanup, runOwnedCleanupSteps } from "../../../scripts/lib/owned-cleanup.mjs";

const rank = (priority: BuildPriority) =>
  priority === "interactive" ? 0 : priority === "background" ? 1 : 2;

interface FlightRow {
  id: string;
  owner: string;
  /** `abandoned`: the producer's own request was cancelled before it settled.
   * The key is unowned work, not a result; a remaining requester claims it. */
  state: "running" | "complete" | "failed" | "abandoned";
  failure: string | null;
}

/** One exact-key compiler owner and one admission budget for all processes
 * sharing a result cache. Waiters hold no compiler permits. Completion means
 * the canonical cache publication has settled; each consumer then hydrates its
 * own provenance. Ownership ends on settlement, cancellation, or confirmed
 * process death, never elapsed time. A cancelled producer's reason belongs to
 * its own requester: it abandons the key and another requester takes it over. */
export class SharedBuildCoordinator {
  private readonly db: DatabaseSync;
  private readonly owner = `${process.pid}:${randomUUID()}:${cacheProcessIdentity(process.pid) ?? ""}`;
  private readonly notification: string;
  private watcher: fs.FSWatcher | undefined;
  private readonly observers = new Set<() => void>();
  private readonly priorityObservers = new Set<() => void>();
  private observationTimer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private refresh: ReturnType<typeof setImmediate> | undefined;
  private observationFailure: unknown;

  constructor(
    root: string,
    private readonly capacity: number
  ) {
    const directory = path.join(root, ".storage");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.notification = path.join(directory, "build-coordinator.changed");
    fs.closeSync(fs.openSync(this.notification, "a", 0o600));
    this.db = new DatabaseSync(path.join(directory, "build-coordinator.db"));
    try {
      this.db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS flights (
          key TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, owner TEXT NOT NULL,
          state TEXT NOT NULL, failure TEXT
        ) STRICT;
        CREATE TABLE IF NOT EXISTS requests (
          id TEXT PRIMARY KEY, flight TEXT NOT NULL, owner TEXT NOT NULL, priority INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS request_flight ON requests(flight);
        CREATE TABLE IF NOT EXISTS slots (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
          owner TEXT NOT NULL, priority INTEGER NOT NULL, running INTEGER NOT NULL,
          capacity INTEGER NOT NULL
        ) STRICT;
      `);
    } catch (error) {
      const failures: unknown[] = [error];
      try {
        this.db.close();
      } catch (failure) {
        failures.push(failure);
      }
      if (failures.length > 1)
        throw new AggregateError(
          failures,
          "Shared build coordinator initialization and retirement failed"
        );
      throw error;
    }
  }

  async run<T>(
    key: string,
    priority: BuildPriorityOwner,
    signal: AbortSignal,
    produce: (priority: BuildPriorityOwner) => Promise<T>
  ): Promise<{ produced: true; value: T } | { produced: false }> {
    signal.throwIfAborted();
    const request = randomUUID();
    const elected = this.transaction(() => {
      this.reap();
      let flight = this.db.prepare("SELECT * FROM flights WHERE key = ?").get(key) as
        | unknown
        | undefined;
      if (!flight) {
        const id = randomUUID();
        this.db
          .prepare("INSERT INTO flights VALUES (?, ?, ?, 'running', NULL)")
          .run(key, id, this.owner);
        flight = { id, owner: this.owner, state: "running", failure: null };
      }
      const row = flight as FlightRow;
      this.db
        .prepare("INSERT INTO requests VALUES (?, ?, ?, ?)")
        .run(request, row.id, this.owner, rank(priority.priority));
      return {
        row,
        producer:
          this.claimAbandoned(row.id) ||
          (row.owner === this.owner && this.requestCount(row.id) === 1),
      };
    });
    const promote = (next: BuildPriority) => {
      this.db
        .prepare("UPDATE requests SET priority = MIN(priority, ?) WHERE id = ?")
        .run(rank(next), request);
      this.notify();
    };
    return runWithOwnedCleanup(
      async () => {
        this.notify();
        priority.bindQueuedPromotion(promote);
        if (!elected.producer) {
          const claimed = await this.observe(() => {
            const row = this.db
              .prepare("SELECT * FROM flights WHERE id = ?")
              .get(elected.row.id) as unknown as FlightRow | undefined;
            if (!row) throw new Error(`Shared build ${key} lost its ownership receipt`);
            if (row.state === "failed") throw deserializeRpcFailure(JSON.parse(row.failure!));
            if (row.state === "complete") return { done: true, value: false };
            if (row.state === "abandoned" && this.claimAbandoned(row.id))
              return { done: true, value: true };
            return { done: false };
          }, signal);
          if (!claimed) return { produced: false } as const;
        }
        const compilerPriority = new BuildPriorityOwner(priority.priority);
        const adoptDemand = () => {
          const demand = this.db
            .prepare("SELECT MIN(priority) AS priority FROM requests WHERE flight = ?")
            .get(elected.row.id)?.["priority"];
          compilerPriority.promote(
            demand === 0 ? "interactive" : demand === 1 ? "background" : "speculative"
          );
        };
        // Priority demand is inspected on local queue changes and while a
        // real waiter observes this coordinator. A producer doing its own work
        // needs no filesystem observer merely to remain promotable.
        this.priorityObservers.add(adoptDemand);
        try {
          adoptDemand();
          const value = await produce(compilerPriority);
          this.settle(elected.row.id, true);
          return { produced: true, value } as const;
        } catch (error) {
          return runWithOwnedCleanup(
            () => {
              throw error;
            },
            () =>
              signal.aborted
                ? this.abandon(elected.row.id)
                : this.settle(elected.row.id, false, error),
            "Shared compilation and failure settlement failed"
          );
        } finally {
          this.priorityObservers.delete(adoptDemand);
        }
      },
      () =>
        runOwnedCleanupSteps(
          [
            () => priority.clearQueuedPromotion(),
            () =>
              this.transaction(() => {
                this.db.prepare("DELETE FROM requests WHERE id = ?").run(request);
                this.retireSettled();
              }),
            () => this.notify(),
          ],
          "Shared build request retirement failed"
        ),
      "Shared build operation and retirement failed"
    );
  }

  async withSlot<T>(
    priority: BuildPriorityOwner,
    signal: AbortSignal,
    run: () => Promise<T>
  ): Promise<T> {
    signal.throwIfAborted();
    const id = randomUUID();
    for (const refreshDemand of [...this.priorityObservers]) refreshDemand();
    this.transaction(() => {
      this.reap();
      this.db
        .prepare("INSERT INTO slots(id, owner, priority, running, capacity) VALUES (?, ?, ?, 0, ?)")
        .run(id, this.owner, rank(priority.priority), this.capacity);
      // Admit against the existing shared queue atomically. A free permit is
      // an immediate native fact, not work that requires a filesystem watch.
      this.admitSlots();
    });
    return runWithOwnedCleanup(
      async () => {
        priority.bindQueuedPromotion((next) => {
          this.db
            .prepare("UPDATE slots SET priority = MIN(priority, ?) WHERE id = ? AND running = 0")
            .run(rank(next), id);
          this.notify();
        });
        this.notify();
        await this.observe(() => {
          const admitted =
            this.db.prepare("SELECT running FROM slots WHERE id = ?").get(id)?.["running"] === 1;
          return admitted ? { done: true, value: undefined } : { done: false };
        }, signal);
        priority.clearQueuedPromotion();
        this.notify();
        signal.throwIfAborted();
        return await run();
      },
      () =>
        runOwnedCleanupSteps(
          [
            () => priority.clearQueuedPromotion(),
            () => {
              this.db.prepare("DELETE FROM slots WHERE id = ?").run(id);
            },
            () => this.notify(),
          ],
          "Shared compiler permit retirement failed"
        ),
      "Shared compiler operation and retirement failed"
    );
  }

  close(): void {
    if (this.closed) return;
    if (
      this.observers.size ||
      this.priorityObservers.size ||
      this.db
        .prepare(
          "SELECT id FROM requests WHERE owner = ? UNION SELECT id FROM slots WHERE owner = ? LIMIT 1"
        )
        .get(this.owner, this.owner)
    ) {
      throw new Error("Shared build coordinator still owns admitted work");
    }
    this.closed = true;
    if (this.refresh) clearImmediate(this.refresh);
    this.retireObservation();
    this.db.close();
  }

  private subscribe(observer: () => void): () => void {
    if (!this.watcher) {
      const watcher = fs.watch(path.dirname(this.notification), (_event, filename) => {
        if (filename?.toString() === "build-coordinator.changed") this.changed();
      });
      this.watcher = watcher;
      watcher.on("error", (error) => {
        this.observationFailure = error;
        this.changed();
      });
      // Observe confirmed process death only while another owner matters.
      // Ordinary progress remains driven by native filesystem notifications.
      this.observationTimer = setInterval(() => this.changed(), 1000);
      this.observationTimer.unref();
    }
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
      if (!this.observers.size) this.retireObservation();
    };
  }

  private retireObservation(): void {
    clearInterval(this.observationTimer);
    this.observationTimer = undefined;
    this.watcher?.close();
    this.watcher = undefined;
  }

  private settle(id: string, successful: boolean, error?: unknown): void {
    this.db
      .prepare(
        "UPDATE flights SET state = ?, failure = ? WHERE id = ? AND owner = ? AND state = 'running'"
      )
      .run(
        successful ? "complete" : "failed",
        successful ? null : JSON.stringify(serializeRpcFailure(error)),
        id,
        this.owner
      );
    this.notify();
  }

  /** Release a cancelled producer's ownership without publishing its
   * cancellation as the key's outcome. */
  private abandon(id: string): void {
    this.db
      .prepare(
        "UPDATE flights SET state = 'abandoned' WHERE id = ? AND owner = ? AND state = 'running'"
      )
      .run(id, this.owner);
    this.notify();
  }

  /** Atomically take over abandoned work; exactly one requester wins. */
  private claimAbandoned(id: string): boolean {
    return (
      Number(
        this.db
          .prepare(
            "UPDATE flights SET state = 'running', owner = ? WHERE id = ? AND state = 'abandoned'"
          )
          .run(this.owner, id).changes
      ) === 1
    );
  }

  private requestCount(id: string): number {
    return Number(
      this.db.prepare("SELECT COUNT(*) AS count FROM requests WHERE flight = ?").get(id)!["count"]
    );
  }

  private reap(): void {
    const owners = this.db
      .prepare(
        "SELECT owner FROM flights WHERE state = 'running' UNION SELECT owner FROM requests UNION SELECT owner FROM slots"
      )
      .all();
    for (const { owner } of owners) {
      if (owner === this.owner || cacheOwnerIsAlive(String(owner))) continue;
      const failure = JSON.stringify(
        serializeRpcFailure(
          Object.assign(new Error("Shared build producer exited before publishing its result"), {
            code: "EBUILD_OWNER_EXIT",
          })
        )
      );
      this.db
        .prepare(
          "UPDATE flights SET state = 'failed', failure = ? WHERE owner = ? AND state = 'running'"
        )
        .run(failure, owner!);
      this.db.prepare("DELETE FROM requests WHERE owner = ?").run(owner!);
      this.db.prepare("DELETE FROM slots WHERE owner = ?").run(owner!);
    }
    this.retireSettled();
  }

  private retireSettled(): void {
    this.db.exec(
      "DELETE FROM flights WHERE state != 'running' AND NOT EXISTS (SELECT 1 FROM requests WHERE flight = flights.id)"
    );
  }

  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private notify(): void {
    fs.writeFileSync(this.notification, randomUUID());
    this.changed();
  }

  private changed(): void {
    if (this.closed || this.refresh) return;
    // Hundreds of release requests arrive together. Coalesce their events;
    // ownership and queue admission are one transaction per notification batch,
    // rather than a full queue scan for every waiting build.
    this.refresh = setImmediate(() => {
      this.refresh = undefined;
      try {
        for (const refreshDemand of [...this.priorityObservers]) refreshDemand();
        this.transaction(() => {
          this.reap();
          this.admitSlots();
        });
      } catch (error) {
        this.observationFailure = error;
      }
      for (const observer of [...this.observers]) observer();
    });
  }

  private admitSlots(): void {
    const slots = this.db
      .prepare("SELECT id, priority, running, capacity FROM slots ORDER BY priority, sequence")
      .all();
    const capacity = Math.min(...slots.map((slot) => Number(slot["capacity"])));
    let active = slots.filter((slot) => slot["running"] === 1).length;
    let nonInteractive = slots.filter(
      (slot) => slot["running"] === 1 && slot["priority"] !== 0
    ).length;
    let speculative = slots.filter(
      (slot) => slot["running"] === 1 && slot["priority"] === 2
    ).length;
    for (const slot of slots) {
      if (slot["running"] === 1) continue;
      const demand = Number(slot["priority"]);
      if (
        !hasBuildSlotCapacity(
          demand === 0 ? "interactive" : demand === 1 ? "background" : "speculative",
          active,
          nonInteractive,
          speculative,
          capacity
        )
      )
        continue;
      this.db.prepare("UPDATE slots SET running = 1 WHERE id = ?").run(slot["id"]!);
      active++;
      if (demand !== 0) nonInteractive++;
      if (demand === 2) speculative++;
    }
  }

  private observe<T>(
    inspect: () => { done: false } | { done: true; value: T },
    signal: AbortSignal
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      let finished = false;
      let stopObserving: (() => void) | undefined;
      const finish = (error: unknown, value?: T) => {
        if (finished) return;
        finished = true;
        let failure = error;
        try {
          stopObserving?.();
        } catch (retirementError) {
          failure =
            error === undefined
              ? retirementError
              : new AggregateError(
                  [error, retirementError],
                  "Shared build observation and retirement failed",
                  { cause: error }
                );
        }
        signal.removeEventListener("abort", aborted);
        if (failure !== undefined) reject(failure);
        else resolve(value!);
      };
      const check = () => {
        try {
          if (this.observationFailure) throw this.observationFailure;
          const result = inspect();
          if (result.done) finish(undefined, result.value);
        } catch (error) {
          finish(error);
        }
      };
      const aborted = () => finish(signal.reason);
      // Most cold interactive builds own their key and have a free permit.
      // Inspect first, then subscribe and inspect again to close the race.
      if (signal.aborted) {
        aborted();
        return;
      }
      check();
      if (finished) return;
      try {
        stopObserving = this.subscribe(check);
      } catch (error) {
        finish(error);
        return;
      }
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
      else check();
    });
  }
}
