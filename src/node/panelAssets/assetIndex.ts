import { DatabaseSync } from "node:sqlite";
import path from "node:path";

export interface AssetIndexEntry {
  digest: string;
  metadataKey: string;
}

/** Disk owns both the request index and blob accounting. Publication updates are incremental. */
export class AssetIndex {
  private readonly db: DatabaseSync;
  constructor(file: string) {
    // SQLite opens through the native OS API, rather than Node's fs layer.
    // Supply an absolute native filename, including Windows' long-path namespace.
    this.db = new DatabaseSync(path.toNamespacedPath(path.resolve(file)));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS assets (
        cache_key TEXT PRIMARY KEY, digest TEXT NOT NULL, metadata_key TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS assets_digest ON assets(digest);
      CREATE TABLE IF NOT EXISTS blobs (
        digest TEXT PRIMARY KEY, bytes INTEGER NOT NULL, last_access INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS blobs_recency ON blobs(last_access, digest);
      CREATE TABLE IF NOT EXISTS accounting (id INTEGER PRIMARY KEY CHECK(id = 1), bytes INTEGER NOT NULL) STRICT;
      INSERT OR IGNORE INTO accounting SELECT 1, COALESCE(SUM(bytes), 0) FROM blobs;
      CREATE TRIGGER IF NOT EXISTS blob_insert AFTER INSERT ON blobs BEGIN
        UPDATE accounting SET bytes = bytes + new.bytes WHERE id = 1;
      END;
      CREATE TRIGGER IF NOT EXISTS blob_update AFTER UPDATE OF bytes ON blobs BEGIN
        UPDATE accounting SET bytes = bytes + new.bytes - old.bytes WHERE id = 1;
      END;
      CREATE TRIGGER IF NOT EXISTS blob_delete AFTER DELETE ON blobs BEGIN
        UPDATE accounting SET bytes = bytes - old.bytes WHERE id = 1;
      END;
    `);
  }
  get(key: string): AssetIndexEntry | undefined {
    return this.db
      .prepare("SELECT digest, metadata_key AS metadataKey FROM assets WHERE cache_key = ?")
      .get(key) as AssetIndexEntry | undefined;
  }
  set(key: string, entry: AssetIndexEntry): void {
    this.db
      .prepare(
        `INSERT INTO assets VALUES (?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET digest = excluded.digest, metadata_key = excluded.metadata_key`
      )
      .run(key, entry.digest, entry.metadataKey);
  }
  delete(key: string): void {
    this.db.prepare("DELETE FROM assets WHERE cache_key = ?").run(key);
  }
  get size(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM assets").get() as { n: number }).n;
  }
  private nextAccess(time = Date.now()): number {
    const newest = this.db
      .prepare("SELECT last_access FROM blobs ORDER BY last_access DESC LIMIT 1")
      .get();
    return Math.max(time, Number(newest?.["last_access"] ?? 0) + 1);
  }
  recordBlob(digest: string, bytes: number, accessed = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO blobs VALUES (?, ?, ?)
      ON CONFLICT(digest) DO UPDATE SET bytes = excluded.bytes, last_access = excluded.last_access`
      )
      .run(digest, bytes, this.nextAccess(accessed));
  }
  reconcileBlob(digest: string, bytes: number, accessed: number): void {
    this.db
      .prepare(
        `INSERT INTO blobs VALUES (?, ?, ?)
      ON CONFLICT(digest) DO UPDATE SET bytes = excluded.bytes`
      )
      .run(digest, bytes, accessed);
  }
  *digests(): Iterable<string> {
    for (const row of this.db.prepare("SELECT digest FROM blobs").iterate())
      yield row["digest"] as string;
  }
  touch(digest: string): void {
    this.db
      .prepare("UPDATE blobs SET last_access = ? WHERE digest = ?")
      .run(this.nextAccess(), digest);
  }
  get bytes(): number {
    return (
      this.db.prepare("SELECT bytes AS n FROM accounting WHERE id = 1").get() as { n: number }
    ).n;
  }
  oldest(excluded: ReadonlySet<string>): { digest: string; bytes: number } | undefined {
    for (const row of this.db
      .prepare("SELECT digest, bytes FROM blobs ORDER BY last_access, digest")
      .iterate()) {
      if (!excluded.has(row["digest"] as string))
        return row as unknown as { digest: string; bytes: number };
    }
    return undefined;
  }
  forgetBlob(digest: string): string[] {
    return this.transaction(() => {
      const metadata = this.db
        .prepare("DELETE FROM assets WHERE digest = ? RETURNING metadata_key AS key")
        .all(digest) as Array<{ key: string }>;
      this.db.prepare("DELETE FROM blobs WHERE digest = ?").run(digest);
      return metadata.map((row) => row.key);
    });
  }
  transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close(): void {
    this.db.close();
  }
}
