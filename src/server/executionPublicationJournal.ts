import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import {
  openCanonicalSqliteDatabase,
  type CanonicalSqliteMigrationPlan,
  type CanonicalSqliteSchema,
} from "@vibestudio/sqlite";
import {
  verifyExecutionArtifactRef,
  type ExecutionArtifactRefV1,
  type ExecutionPublication,
  type ExecutionPublicationPort,
  type ExecutionPublicationReservation,
} from "@vibestudio/shared/execution/retention";
import { stateLayout } from "./stateLayout.js";

const PUBLICATION_SCHEMA: CanonicalSqliteSchema = {
  version: 1,
  objects: [
    {
      type: "table",
      name: "gc_epoch",
      sql: `CREATE TABLE gc_epoch (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        current_epoch INTEGER NOT NULL CHECK(current_epoch >= 0)
      )`,
    },
    {
      type: "table",
      name: "execution_publications",
      sql: `CREATE TABLE execution_publications (
        reservation_id TEXT PRIMARY KEY,
        epoch INTEGER NOT NULL CHECK(epoch >= 0),
        owner TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('reserved','finalized')),
        created_at INTEGER NOT NULL,
        finalized_at INTEGER
      )`,
    },
    {
      type: "table",
      name: "execution_publication_artifacts",
      sql: `CREATE TABLE execution_publication_artifacts (
        reservation_id TEXT NOT NULL REFERENCES execution_publications(reservation_id) ON DELETE CASCADE,
        build_key TEXT NOT NULL,
        execution_digest TEXT NOT NULL,
        PRIMARY KEY (reservation_id, build_key)
      )`,
    },
    {
      type: "index",
      name: "execution_publications_by_epoch_status",
      sql: "CREATE INDEX execution_publications_by_epoch_status ON execution_publications(epoch, status)",
    },
    {
      type: "index",
      name: "execution_publication_artifacts_by_build",
      sql: "CREATE INDEX execution_publication_artifacts_by_build ON execution_publication_artifacts(build_key, reservation_id)",
    },
  ],
};

const PUBLICATION_MIGRATIONS: CanonicalSqliteMigrationPlan = {
  current: PUBLICATION_SCHEMA,
  migrations: [],
};

function asNumber(value: SQLOutputValue | undefined): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`Invalid execution publication epoch ${String(value)}`);
  }
  return result;
}

/**
 * Durable publication/collection serialization point for one workspace.
 *
 * SQLite WAL keeps reserve/finalize O(artifacts), with no history rewrite on
 * hot runtime paths. Each reservation verifies the exact stored execution
 * identity before an authoritative owner can reference it.
 */
export class ExecutionPublicationJournal implements ExecutionPublicationPort {
  private readonly db: DatabaseSync;

  constructor(
    statePath: string,
    private readonly resolveArtifact: (
      buildKey: string,
      executionDigest: string
    ) => ExecutionArtifactRefV1 | null,
    options: { busyTimeoutMs?: number } = {}
  ) {
    const databasePath = stateLayout(statePath).executionRetention.publicationsDb;
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5_000}`);
    this.db.exec("PRAGMA foreign_keys = ON");
    try {
      openCanonicalSqliteDatabase(this.db, PUBLICATION_MIGRATIONS, {
        description: `execution publication journal in ${databasePath}`,
      });
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db
        .prepare("INSERT OR IGNORE INTO gc_epoch(singleton, current_epoch) VALUES (1, 0)")
        .run();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  currentEpoch(): number {
    const row = this.db.prepare("SELECT current_epoch FROM gc_epoch WHERE singleton = 1").get() as
      | Record<string, SQLOutputValue>
      | undefined;
    return asNumber(row?.["current_epoch"]);
  }

  beginEpoch(): number {
    return this.transaction(() => {
      this.db
        .prepare("UPDATE gc_epoch SET current_epoch = current_epoch + 1 WHERE singleton = 1")
        .run();
      return this.currentEpoch();
    });
  }

  reserve(publication: ExecutionPublication): ExecutionPublicationReservation {
    if (!publication.ownerId) throw new Error("Execution publication ownerId is required");
    return this.transaction(() => {
      const reservation: ExecutionPublicationReservation = {
        reservationId: crypto.randomUUID(),
        // Read after BEGIN IMMEDIATE: epoch allocation and artifact deletion
        // use this same lock, so a stamp cannot be inserted into an epoch whose
        // root snapshot has already started.
        epoch: this.currentEpoch(),
      };
      // Resolve under the same IMMEDIATE transaction that inserts the stamp.
      // A sweep cannot delete after verification and before reservation.
      const artifacts = publication.artifacts.map((artifact) => {
        const resolved = this.resolveArtifact(artifact.buildKey, artifact.executionDigest);
        if (!resolved) {
          throw new Error(`Cannot publish missing execution artifact ${artifact.buildKey}`);
        }
        const verified = verifyExecutionArtifactRef(resolved);
        if (
          verified.buildKey !== artifact.buildKey ||
          verified.executionDigest !== artifact.executionDigest
        ) {
          throw new Error(
            `Execution publication identity does not match stored build ${artifact.buildKey}`
          );
        }
        return artifact;
      });
      this.db
        .prepare(
          `INSERT INTO execution_publications (
            reservation_id, epoch, owner, owner_id, status, created_at
          ) VALUES (?, ?, ?, ?, 'reserved', ?)`
        )
        .run(
          reservation.reservationId,
          reservation.epoch,
          publication.owner,
          publication.ownerId,
          Date.now()
        );
      const insertArtifact = this.db.prepare(
        `INSERT INTO execution_publication_artifacts (
          reservation_id, build_key, execution_digest
        ) VALUES (?, ?, ?)`
      );
      for (const artifact of artifacts) {
        insertArtifact.run(reservation.reservationId, artifact.buildKey, artifact.executionDigest);
      }
      return reservation;
    });
  }

  finalize(reservation: ExecutionPublicationReservation): void {
    const result = this.db
      .prepare(
        `UPDATE execution_publications
            SET status = 'finalized', finalized_at = COALESCE(finalized_at, ?)
          WHERE reservation_id = ? AND epoch = ?`
      )
      .run(Date.now(), reservation.reservationId, reservation.epoch);
    if (result.changes !== 1) {
      throw new Error(`Unknown execution publication reservation ${reservation.reservationId}`);
    }
  }

  protectedBuildKeys(epoch: number): ReadonlySet<string> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT a.build_key
           FROM execution_publication_artifacts a
           JOIN execution_publications p USING (reservation_id)
          WHERE p.status = 'reserved' OR p.epoch >= ?
          ORDER BY a.build_key`
      )
      .all(epoch) as Array<Record<string, SQLOutputValue>>;
    return new Set(rows.map((row) => String(row["build_key"])));
  }

  /**
   * Serialize the final protection check and atomic artifact rename with every
   * reserve() transaction, including reservations from another host process.
   */
  commitArtifactDeletion(epoch: number, buildKey: string, commit: () => void): boolean {
    return this.transaction(() => {
      const protectedRow = this.db
        .prepare(
          `SELECT 1
             FROM execution_publication_artifacts a
             JOIN execution_publications p USING (reservation_id)
            WHERE a.build_key = ?
              AND (p.status = 'reserved' OR p.epoch >= ?)
            LIMIT 1`
        )
        .get(buildKey, epoch);
      if (protectedRow) return false;
      commit();
      return true;
    });
  }

  completeEpoch(epoch: number, rootedBuildKeys: ReadonlySet<string>): void {
    this.transaction(() => {
      const deleteReservation = this.db.prepare(
        "DELETE FROM execution_publications WHERE reservation_id = ?"
      );
      const rows = this.db
        .prepare(
          `SELECT p.reservation_id, p.epoch, p.status, a.build_key
             FROM execution_publications p
             LEFT JOIN execution_publication_artifacts a USING (reservation_id)
            WHERE p.epoch < ?
            ORDER BY p.reservation_id`
        )
        .all(epoch) as Array<Record<string, SQLOutputValue>>;
      const decisions = new Map<
        string,
        { publicationEpoch: number; status: string; rooted: boolean }
      >();
      for (const row of rows) {
        const id = String(row["reservation_id"]);
        const decision = decisions.get(id) ?? {
          publicationEpoch: asNumber(row["epoch"]),
          status: String(row["status"]),
          rooted: false,
        };
        if (row["build_key"] !== null && rootedBuildKeys.has(String(row["build_key"]))) {
          decision.rooted = true;
        }
        decisions.set(id, decision);
      }
      for (const [id, decision] of decisions) {
        if (decision.status === "finalized" || decision.rooted) {
          deleteReservation.run(id);
        }
      }
    });
  }

  /** Bounded state metric used by diagnostics and the hot-path scale test. */
  pendingPublicationCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM execution_publications")
      .get() as Record<string, SQLOutputValue>;
    return Number(row["count"]);
  }

  ambiguousPublications(): Array<{
    reservationId: string;
    owner: string;
    ownerId: string;
    epoch: number;
  }> {
    return this.db
      .prepare(
        `SELECT reservation_id, owner, owner_id, epoch
           FROM execution_publications
          WHERE status = 'reserved'
          ORDER BY epoch, reservation_id`
      )
      .all()
      .map((row) => ({
        reservationId: String(row["reservation_id"]),
        owner: String(row["owner"]),
        ownerId: String(row["owner_id"]),
        epoch: Number(row["epoch"]),
      }));
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
