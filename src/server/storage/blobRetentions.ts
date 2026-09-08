import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openCanonicalSqliteDatabase, type CanonicalSqliteSchema } from "@vibestudio/sqlite";

const schema: CanonicalSqliteSchema = {
  version: 1,
  objects: [
    {
      type: "table",
      name: "blob_retentions",
      sql: `CREATE TABLE blob_retentions (
      namespace TEXT NOT NULL,
      owner TEXT NOT NULL,
      digest TEXT NOT NULL,
      PRIMARY KEY (namespace, owner)
    )`,
    },
  ],
};

const locks = new Map<string, Promise<void>>();

/** One workspace's write-to-root interval and destructive GC share this lock. */
export async function withBlobContentLock<T>(
  blobsDir: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = path.resolve(blobsDir);
  const previous = locks.get(key) ?? Promise.resolve();
  let unlock!: () => void;
  const tail = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  locks.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    unlock();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

function databasePath(blobsDir: string) {
  return path.join(blobsDir, "retentions.db");
}

function withStore<T>(blobsDir: string, action: (db: DatabaseSync) => T): T {
  fs.mkdirSync(blobsDir, { recursive: true, mode: 0o700 });
  const file = databasePath(blobsDir);
  const db = new DatabaseSync(file);
  try {
    fs.chmodSync(file, 0o600);
    db.exec("PRAGMA busy_timeout = 5000");
    openCanonicalSqliteDatabase(db, schema, { description: `blob retention registry in ${file}` });
    return action(db);
  } finally {
    db.close();
  }
}

/** Call while holding withBlobContentLock, after verifying the local CAS bytes exist. */
export function retainBlob(
  blobsDir: string,
  namespace: string,
  owner: string,
  digest: string
): void {
  withStore(blobsDir, (db) => {
    const prior = db
      .prepare("SELECT digest FROM blob_retentions WHERE namespace = ? AND owner = ?")
      .get(namespace, owner);
    if (prior && prior["digest"] !== digest)
      throw new Error(
        "Blob retention owner already names different content; release it explicitly first"
      );
    db.prepare(
      "INSERT OR IGNORE INTO blob_retentions(namespace, owner, digest) VALUES (?, ?, ?)"
    ).run(namespace, owner, digest);
  });
}

/** Releasing ownership permits future GC; it never removes somebody else's bytes. */
export function releaseBlobRetention(blobsDir: string, namespace: string, owner: string): void {
  if (!fs.existsSync(databasePath(blobsDir))) return;
  withStore(blobsDir, (db) => {
    db.prepare("DELETE FROM blob_retentions WHERE namespace = ? AND owner = ?").run(
      namespace,
      owner
    );
  });
}

export function retainedBlobDigests(blobsDir: string): string[] {
  if (!fs.existsSync(databasePath(blobsDir))) return [];
  return withStore(blobsDir, (db) =>
    db
      .prepare("SELECT DISTINCT digest FROM blob_retentions ORDER BY digest")
      .all()
      .map((row) => String(row["digest"]))
  );
}
