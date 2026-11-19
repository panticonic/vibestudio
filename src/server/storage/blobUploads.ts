import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { openCanonicalSqliteDatabase, type CanonicalSqliteSchema } from "@vibestudio/sqlite";
import { verifiedInteractiveSession } from "../services/principalIdentity.js";

export type WorkspaceBlobScope = "content" | "manifest" | "state";

const privateWorkspaceBlobsTable = `CREATE TABLE private_workspace_blobs (
  digest TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('content', 'manifest', 'state'))
) STRICT`;

const workspaceBlobReplayTable = "CREATE TABLE workspace_blob_replays (plan_digest TEXT PRIMARY KEY) STRICT";

const schema: CanonicalSqliteSchema = {
  version: 3,
  objects: [{
    type: "table",
    name: "blob_uploads",
    sql: `CREATE TABLE blob_uploads (
      digest TEXT NOT NULL,
      principal TEXT NOT NULL,
      PRIMARY KEY (digest, principal)
    )`,
  }, {
    type: "table",
    name: "private_workspace_blobs",
    sql: privateWorkspaceBlobsTable,
  }, {
    type: "table",
    name: "workspace_blob_replays",
    sql: workspaceBlobReplayTable,
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
    openCanonicalSqliteDatabase(db, schema, {
      description: `blob upload registry in ${file}`,
      migrations: [
        { fromVersion: 1, toVersion: 2, migrate: (db) => db.exec(privateWorkspaceBlobsTable) },
        { fromVersion: 2, toVersion: 3, migrate: (db) => db.exec(workspaceBlobReplayTable) },
      ],
    });
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

/** Record the scope before creating the first workspace link to authored bytes. */
export function markPrivateWorkspaceBlobs(
  blobsDir: string,
  digests: readonly string[],
  scope: WorkspaceBlobScope = "content"
): void {
  if (digests.length === 0) return;
  fs.mkdirSync(blobsDir, { recursive: true });
  withStore(databasePath(blobsDir), (db) => {
    db.prepare(
      "INSERT OR IGNORE INTO private_workspace_blobs(digest, scope) SELECT value, ? FROM json_each(?)"
    ).run(scope, JSON.stringify(digests));
  });
}

export function privateWorkspaceBlobScopes(
  blobsDir: string,
  digests: readonly string[]
): Map<string, WorkspaceBlobScope> {
  const file = databasePath(blobsDir);
  if (digests.length === 0 || !fs.existsSync(file)) return new Map();
  return withStore(file, (db) => new Map(
    db.prepare(
      `SELECT digest, scope FROM json_each(?)
        JOIN private_workspace_blobs ON digest = value`
    ).all(JSON.stringify(digests)).map((row) => [
      String(row["digest"]), row["scope"] as WorkspaceBlobScope,
    ])
  ));
}

export function hasPrivateWorkspaceBlobs(blobsDir: string): boolean {
  const file = databasePath(blobsDir);
  return fs.existsSync(file) && withStore(file, (db) =>
    db.prepare("SELECT 1 FROM private_workspace_blobs LIMIT 1").get() !== undefined
  );
}


export function workspaceReplayBlobScopesReady(blobsDir: string, planDigest: string): boolean {
  const file = databasePath(blobsDir);
  return fs.existsSync(file) && withStore(file, (db) =>
    db.prepare("SELECT 1 FROM workspace_blob_replays WHERE plan_digest = ?").get(planDigest) !== undefined
  );
}

export function finishWorkspaceReplayBlobScopes(blobsDir: string, planDigest: string): void {
  fs.mkdirSync(blobsDir, { recursive: true });
  withStore(databasePath(blobsDir), (db) => {
    db.prepare("INSERT OR IGNORE INTO workspace_blob_replays(plan_digest) VALUES (?)").run(planDigest);
  });
}
