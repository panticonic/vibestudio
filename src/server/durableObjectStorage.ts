/**
 * Storage operations on a userland Durable Object: backup, restore, reset,
 * retirement, and the identity of the storage a host authority was granted on.
 * docs/dolt-redesign.md §4.4, P3.
 *
 * The node does the copying (celld `docs/services/object-fork.md`): a backup is
 * a fork of the whole object, root and facets, into a hidden cell, a restore
 * replaces a quiesced object with such a copy and completes by itself if the
 * node stops in between, a reset deletes the object's cell. A fork never
 * overwrites an object, an interrupted one is taken over (`replaceUnfinished`)
 * and a finished one answers `ERR_OBJECT_EXISTS`, so repeating any step is safe.
 * Nothing here is a journal that replays a state machine across a crash: the
 * host copied files underneath a live process once, which is why it needed one.
 *
 * What the host still owes, as rows:
 * - the identity (incarnation) of each object's storage, which a host
 *   authority (a published wake source) is bound to, and which every
 *   replacement rotates, always before the replacement itself, so a crash can
 *   only leave an identity newer than the data, never an authority that
 *   outlives the data it was granted on;
 * - the registry of backups (the node has no listing), a backup being listed
 *   only once its fork finished;
 * - an outbox of retired objects whose storage is not yet deleted.
 */
import type { DatabaseSync } from "node:sqlite";
import { canonicalEntityId } from "@vibestudio/shared/runtime/entitySpec";
import { createDevLogger } from "@vibestudio/dev-log";

const log = createDevLogger("DurableObjectStorage");

/** The retention of backups per object; the oldest beyond it are deleted. */
const RETAINED_BACKUPS = 5;

export interface StorageDORef {
  source: string;
  className: string;
  objectKey: string;
}

export interface DurableObjectStorageBackup {
  operationId: string;
  target: StorageDORef;
  intent: string;
  createdAt: number;
}

export interface DurableObjectStorageIncarnation {
  incarnation: string;
  generation: number;
}

export interface ObjectOperation {
  op: "fork" | "restore";
  from: StorageDORef;
  to: StorageDORef;
  stop?: boolean;
  /** `fork`: take over a target an interrupted fork left unfinished. */
  replaceUnfinished?: boolean;
}

export interface DurableObjectStorageDeps {
  db: DatabaseSync;
  /** Fork or restore whole cells on the node; failures carry the node's error `code`. */
  objectOperation(input: ObjectOperation): Promise<void>;
  /** Delete the object's cell (root, facet index and facets). */
  destroyCell(ref: StorageDORef): Promise<void>;
  /** Retire a loaded facet so nothing writes while its storage is replaced. */
  abortFacet(ref: StorageDORef): Promise<void>;
  ensureNodeRunning(): Promise<void>;
  nodeRunning(): boolean;
  /** Re-publish an object's host authority after its storage was replaced. */
  republishOwner(ref: StorageDORef): Promise<void>;
  /** Hold host-driven calls to the object off while its storage is replaced. */
  seal(targetId: string, ownerId: string, error: MaintenanceError): Promise<void>;
  release(targetId: string, ownerId: string): void;
}

export interface MaintenanceError {
  code: "DO_MAINTENANCE_IN_PROGRESS";
  message: string;
  errorData: Record<string, unknown>;
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

export class DurableObjectStorage {
  private readonly deps: DurableObjectStorageDeps;
  private readonly db: DatabaseSync;
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(deps: DurableObjectStorageDeps) {
    this.deps = deps;
    this.db = deps.db;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS do_storage_incarnations (
        target_id TEXT PRIMARY KEY,
        incarnation TEXT NOT NULL UNIQUE,
        generation INTEGER NOT NULL CHECK(generation > 0)
      );
      -- A backup is a cell of the runtime node under a hidden name (backup_id).
      CREATE TABLE IF NOT EXISTS do_storage_backups (
        operation_id TEXT PRIMARY KEY,
        backup_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        source TEXT NOT NULL,
        class_name TEXT NOT NULL,
        object_key TEXT NOT NULL,
        intent TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      -- Retired objects whose storage the node has not yet deleted.
      CREATE TABLE IF NOT EXISTS do_storage_retired (
        target_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        class_name TEXT NOT NULL,
        object_key TEXT NOT NULL,
        retired_at INTEGER NOT NULL
      );
    `);
    // A backup is listed only when its fork finished. Rows written before the
    // column existed were recorded after their fork, so they are ready.
    const columns = this.db.prepare(`PRAGMA table_info(do_storage_backups)`).all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === "ready")) {
      this.db.exec(`ALTER TABLE do_storage_backups ADD COLUMN ready INTEGER NOT NULL DEFAULT 1`);
    }
    this.adoptRetiredJournal();
  }

  /**
   * An earlier build kept a journal of storage operations (`do_maintenance`).
   * Its only obligation that outlives a process is a retired object's storage
   * still to be deleted; that moves to the outbox. A reset or restore it had
   * open is not resumed: the node completes a restore it accepted by itself,
   * and an operation that never reached the node changed nothing.
   */
  private adoptRetiredJournal(): void {
    const legacy = this.db
      .prepare(
        `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'do_maintenance'`
      )
      .get();
    if (!legacy) return;
    this.db.exec(`
      INSERT OR IGNORE INTO do_storage_retired (target_id, source, class_name, object_key, retired_at)
        SELECT target_id, source, class_name, object_key, created_at
          FROM do_maintenance WHERE kind = 'destroy' AND status = 'open';
      DROP TABLE do_maintenance;
    `);
  }

  // -- identity ------------------------------------------------------------------

  static targetId(ref: StorageDORef): string {
    return canonicalEntityId({
      kind: "do",
      source: ref.source,
      className: ref.className,
      key: ref.objectKey,
    });
  }

  /** Host authority survives a restore only through this identity: a replacement rotates it. */
  incarnation(ref: StorageDORef): DurableObjectStorageIncarnation {
    const targetId = DurableObjectStorage.targetId(ref);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO do_storage_incarnations(target_id, incarnation, generation) VALUES (?, ?, 1)`
      )
      .run(targetId, crypto.randomUUID());
    const row = this.db
      .prepare(`SELECT incarnation, generation FROM do_storage_incarnations WHERE target_id = ?`)
      .get(targetId) as { incarnation: string; generation: number };
    return { incarnation: row.incarnation, generation: row.generation };
  }

  private rotateIncarnation(targetId: string): void {
    this.db
      .prepare(
        `INSERT INTO do_storage_incarnations(target_id, incarnation, generation) VALUES (?, ?, 1)
         ON CONFLICT(target_id) DO UPDATE SET incarnation = excluded.incarnation, generation = generation + 1`
      )
      .run(targetId, crypto.randomUUID());
  }

  // -- plumbing ------------------------------------------------------------------

  private backupRef(ref: StorageDORef, backupId: string): StorageDORef {
    return { ...ref, objectKey: `__vibestudio_backup:${backupId}` };
  }

  /** One operation at a time per object; the next starts when the last settled. */
  private serialize<T>(targetId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(targetId) ?? Promise.resolve();
    const next = previous.then(run);
    const tracked = next.then(
      () => undefined,
      () => undefined
    );
    this.chains.set(targetId, tracked);
    void tracked.then(() => {
      if (this.chains.get(targetId) === tracked) this.chains.delete(targetId);
    });
    return next;
  }

  /** Wait for every operation in flight (shutdown). */
  async settled(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }

  private async fenced<T>(
    ref: StorageDORef,
    kind: "reset" | "restore" | "destroy",
    operationId: string,
    run: () => Promise<T>
  ): Promise<T> {
    const targetId = DurableObjectStorage.targetId(ref);
    await this.deps.seal(targetId, operationId, {
      code: "DO_MAINTENANCE_IN_PROGRESS",
      message:
        `${ref.className} (${ref.source}/${ref.objectKey}) storage maintenance ` +
        `${operationId} is in progress`,
      errorData: {
        operationId,
        operation: kind,
        source: ref.source,
        className: ref.className,
        objectKey: ref.objectKey,
      },
    });
    try {
      return await run();
    } finally {
      this.deps.release(targetId, operationId);
    }
  }

  // -- backups -------------------------------------------------------------------

  /**
   * Fork the object into a backup cell named by the operation. The registry row
   * exists from the start but is listed only after the fork returned; an
   * interrupted fork is taken over, a finished one (`ERR_OBJECT_EXISTS`, a
   * retry after the node answered and the host did not hear) counts as done.
   */
  private async backUp(ref: StorageDORef, intent: string, operationId: string): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO do_storage_backups
           (operation_id, backup_id, target_id, source, class_name, object_key, intent, created_at, ready)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
      )
      .run(
        operationId,
        operationId,
        DurableObjectStorage.targetId(ref),
        ref.source,
        ref.className,
        ref.objectKey,
        intent,
        Date.now()
      );
    try {
      await this.deps.objectOperation({
        op: "fork",
        from: ref,
        to: this.backupRef(ref, operationId),
        replaceUnfinished: true,
      });
    } catch (error) {
      if (errorCode(error) !== "ERR_OBJECT_EXISTS") throw error;
    }
    this.db
      .prepare(`UPDATE do_storage_backups SET ready = 1 WHERE operation_id = ?`)
      .run(operationId);
  }

  private backupRow(operationId: string): { backup_id: string; target_id: string } | undefined {
    return this.db
      .prepare(
        `SELECT backup_id, target_id FROM do_storage_backups WHERE operation_id = ? AND ready = 1`
      )
      .get(operationId) as { backup_id: string; target_id: string } | undefined;
  }

  list(ref: StorageDORef): DurableObjectStorageBackup[] {
    return this.db
      .prepare(
        `SELECT operation_id, intent, created_at FROM do_storage_backups
          WHERE target_id = ? AND ready = 1 ORDER BY created_at DESC, rowid DESC`
      )
      .all(DurableObjectStorage.targetId(ref))
      .map((raw) => {
        const row = raw as Record<string, unknown>;
        return {
          operationId: String(row["operation_id"]),
          target: { ...ref },
          intent: String(row["intent"]),
          createdAt: Number(row["created_at"]),
        };
      });
  }

  /** Backups whose fork never finished (a crash or a refusal): their cells and rows go. */
  private async sweepUnfinished(targetId?: string): Promise<void> {
    const rows = (
      targetId === undefined
        ? this.db.prepare(`SELECT * FROM do_storage_backups WHERE ready = 0`).all()
        : this.db
            .prepare(`SELECT * FROM do_storage_backups WHERE ready = 0 AND target_id = ?`)
            .all(targetId)
    ) as Array<Record<string, unknown>>;
    for (const row of rows) {
      try {
        await this.deps.destroyCell({
          source: String(row["source"]),
          className: String(row["class_name"]),
          objectKey: `__vibestudio_backup:${String(row["backup_id"])}`,
        });
        this.db
          .prepare(`DELETE FROM do_storage_backups WHERE operation_id = ?`)
          .run(String(row["operation_id"]));
      } catch (error) {
        log.warn(`Unfinished backup ${String(row["operation_id"])} awaits the next sweep`, error);
      }
    }
  }

  private async sweepRetention(ref: StorageDORef): Promise<void> {
    for (const backup of this.list(ref).slice(RETAINED_BACKUPS)) {
      const row = this.backupRow(backup.operationId);
      if (!row) continue;
      await this.deps.destroyCell(this.backupRef(ref, row.backup_id));
      this.db
        .prepare(`DELETE FROM do_storage_backups WHERE operation_id = ?`)
        .run(backup.operationId);
    }
  }

  // -- reset, restore --------------------------------------------------------------

  /** Back up the object, then delete its cell: it starts empty at its next call. */
  async reset(ref: StorageDORef, intent: string): Promise<{ operationId: string }> {
    this.requireIntent(intent);
    await this.deps.ensureNodeRunning();
    const targetId = DurableObjectStorage.targetId(ref);
    const operationId = crypto.randomUUID();
    await this.serialize(targetId, () =>
      this.fenced(ref, "reset", operationId, async () => {
        await this.deps.abortFacet(ref);
        await this.sweepUnfinished(targetId);
        await this.backUp(ref, intent.trim(), operationId);
        this.rotateIncarnation(targetId);
        await this.deps.destroyCell(ref);
        await this.deps.republishOwner(ref);
        await this.sweepRetention(ref);
      })
    );
    return { operationId };
  }

  /**
   * Replace the object with a backup of it. What it replaces is backed up first,
   * so a restore can itself be undone. The backup must be this object's.
   */
  async restore(
    ref: StorageDORef,
    backupOperationId: string,
    intent: string
  ): Promise<{ operationId: string }> {
    this.requireIntent(intent);
    await this.deps.ensureNodeRunning();
    const targetId = DurableObjectStorage.targetId(ref);
    const operationId = crypto.randomUUID();
    await this.serialize(targetId, () =>
      this.fenced(ref, "restore", operationId, async () => {
        const chosen = this.backupRow(backupOperationId);
        if (!chosen || chosen.target_id !== targetId) {
          throw new Error(
            `Backup ${backupOperationId} does not belong to the exact requested target`
          );
        }
        await this.deps.abortFacet(ref);
        await this.sweepUnfinished(targetId);
        await this.backUp(ref, intent.trim(), operationId);
        this.rotateIncarnation(targetId);
        await this.deps.objectOperation({
          op: "restore",
          from: this.backupRef(ref, chosen.backup_id),
          to: ref,
          stop: true,
        });
        await this.deps.republishOwner(ref);
        await this.sweepRetention(ref);
      })
    );
    return { operationId };
  }

  private requireIntent(intent: string): void {
    if (!intent.trim()) throw new Error("Durable Object storage maintenance requires intent");
  }

  // -- retirement ------------------------------------------------------------------

  /**
   * A retired object's storage is deleted. The obligation is recorded first, so
   * it survives a node that is down or refuses; a failed attempt never fails the
   * caller and the next node start collects it.
   */
  async destroyRetired(ref: StorageDORef): Promise<void> {
    const targetId = DurableObjectStorage.targetId(ref);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO do_storage_retired (target_id, source, class_name, object_key, retired_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(targetId, ref.source, ref.className, ref.objectKey, Date.now());
    if (this.deps.nodeRunning()) await this.collectRetired(targetId);
  }

  private async collectRetired(only?: string): Promise<void> {
    const rows = (
      only === undefined
        ? this.db.prepare(`SELECT * FROM do_storage_retired ORDER BY retired_at`).all()
        : this.db.prepare(`SELECT * FROM do_storage_retired WHERE target_id = ?`).all(only)
    ) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const ref = {
        source: String(row["source"]),
        className: String(row["class_name"]),
        objectKey: String(row["object_key"]),
      };
      const targetId = String(row["target_id"]);
      try {
        await this.serialize(targetId, () =>
          this.fenced(ref, "destroy", crypto.randomUUID(), async () => {
            await this.deps.destroyCell(ref);
            // The identity of what is gone is retired with it: a new object under the
            // same key is a new storage.
            this.rotateIncarnation(targetId);
            this.db.prepare(`DELETE FROM do_storage_retired WHERE target_id = ?`).run(targetId);
          })
        );
      } catch (error) {
        log.warn(`Retired storage ${targetId} awaits the next collection`, error);
      }
    }
  }

  /** After a node start, when the node can finally do what is owed. */
  async recover(): Promise<void> {
    await this.collectRetired();
    await this.sweepUnfinished();
  }
}
