import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { openCanonicalSqliteDatabase, type CanonicalSqliteSchema } from "@vibestudio/sqlite";
import { verifiedInteractiveSession } from "../services/principalIdentity.js";

const schema: CanonicalSqliteSchema = {
  version: 1,
  objects: [{
    type: "table",
    name: "blob_uploads",
    sql: `CREATE TABLE blob_uploads (
      digest TEXT NOT NULL,
      principal TEXT NOT NULL,
      PRIMARY KEY (digest, principal)
    )`,
  }],
};

/** Bind uploaded bytes to the authenticated producer, including a relayed caller. */
export function blobUploadPrincipal({ caller, chainCaller }: ServiceContext): string {
  const invocation = caller.nativeInvocation;
  if (invocation) return JSON.stringify(["task", invocation.owner, invocation.task]);
  const session = verifiedInteractiveSession(caller);
  if (session) return JSON.stringify(["interactive-session", session.userId, session.contextId]);
  if (caller.taskAuthority) return JSON.stringify(["task-grant", caller.taskAuthority]);
  const relay = caller.runtime.kind === "extension" ? chainCaller : undefined;
  return JSON.stringify([
    caller.subject?.userId ?? null,
    caller.remoteDeviceKey ?? null,
    caller.runtime.kind,
    caller.runtime.id,
    caller.executionSession?.contextId ?? caller.agentBinding?.contextId ?? null,
    relay?.callerId ?? null,
  ]);
}

function databasePath(blobsDir: string): string {
  return path.join(blobsDir, "uploads.db");
}

function withStore<T>(file: string, action: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file);
  try {
    fs.chmodSync(file, 0o600);
    db.exec("PRAGMA busy_timeout = 5000");
    openCanonicalSqliteDatabase(db, schema, { description: `blob upload registry in ${file}` });
    return action(db);
  } finally {
    db.close();
  }
}

/** Call only after independently storing bytes supplied by this authenticated producer. */
export function recordBlobUpload(blobsDir: string, principal: string, digest: string): void {
  withStore(databasePath(blobsDir), (db) => {
    db.prepare("INSERT OR IGNORE INTO blob_uploads(digest, principal) VALUES (?, ?)")
      .run(digest, principal);
  });
}

/** Proof of supply is independent of CAS existence, retention, and knowledge of the digest. */
export function hasBlobUploads(
  blobsDir: string,
  principal: string,
  digests: readonly string[]
): boolean {
  if (digests.length === 0) return true;
  const file = databasePath(blobsDir);
  if (!fs.existsSync(file)) return false;
  return withStore(file, (db) => {
    const uploaded = db.prepare("SELECT 1 FROM blob_uploads WHERE digest = ? AND principal = ?");
    return digests.every((digest) => uploaded.get(digest, principal) !== undefined);
  });
}
