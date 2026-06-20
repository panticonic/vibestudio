import type { ScopeEntry, ScopeListEntry, ScopePersistence } from "./scopePersistence.js";

/**
 * Minimal synchronous SQL handle — matches a Durable Object's `ctx.storage.sql`
 * (`exec(query, ...bindings)` returning a cursor with `toArray()`). Declared locally
 * so `@workspace/eval` keeps no dependency on `@natstack/durable`/`@workspace/runtime`.
 */
export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] };
}

interface ScopeRow {
  id: string;
  channel_id: string;
  panel_id: string;
  data: string;
  serialized_keys: string;
  dropped_paths: string;
  partial_keys: string;
  blob_refs: string;
  created_at: number;
}

/** The scope table name — reserved; the EvalDO `db` binding must refuse DDL/DML on it. */
export const SCOPE_TABLE = "repl_scopes";

/** Content-addressed, chunked blob store for spilled scope values — also reserved. */
export const SCOPE_BLOB_TABLE = "scope_blobs";

/** Per-chunk character budget. Mostly-ASCII JSON ⇒ ~this many bytes; ≤4× for heavy multibyte, still
 *  comfortably under the DO-SQLite per-value limit. */
const BLOB_CHUNK_CHARS = 128 * 1024;

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * `ScopePersistence` backed directly by a synchronous in-DO SQLite handle. Used by the
 * EvalDO kernel (`this.sql`) in place of the deleted server `scope` service. Mirrors the
 * schema/queries of the former `ScopeStoreDO`. The async signatures satisfy the
 * `ScopePersistence` interface; the underlying SQL is synchronous.
 */
export class SqlScopePersistence implements ScopePersistence {
  constructor(private readonly sql: SqlLike) {
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS ${SCOPE_TABLE} (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        panel_id TEXT NOT NULL,
        data TEXT NOT NULL,
        serialized_keys TEXT NOT NULL,
        dropped_paths TEXT NOT NULL,
        partial_keys TEXT NOT NULL,
        blob_refs TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      )
    `);
    // Migrate pre-existing tables that predate the `blob_refs` column. SQLite has no
    // `ADD COLUMN IF NOT EXISTS`, so check the schema and add it only when actually absent — that
    // way a genuine ALTER failure (locked table, etc.) surfaces instead of being masked.
    const columns = this.sql
      .exec(`PRAGMA table_info(${SCOPE_TABLE})`)
      .toArray() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "blob_refs")) {
      this.sql.exec(`ALTER TABLE ${SCOPE_TABLE} ADD COLUMN blob_refs TEXT NOT NULL DEFAULT '[]'`);
    }
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS ${SCOPE_BLOB_TABLE} (
        digest TEXT NOT NULL,
        seq INTEGER NOT NULL,
        chunk TEXT NOT NULL,
        PRIMARY KEY (digest, seq)
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_scopes_current ON ${SCOPE_TABLE}(channel_id, panel_id, created_at DESC)`
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_scopes_channel ON ${SCOPE_TABLE}(channel_id, created_at)`
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async upsert(entry: ScopeEntry): Promise<void> {
    this.sql.exec(
      `INSERT OR REPLACE INTO ${SCOPE_TABLE}
        (id, channel_id, panel_id, data, serialized_keys, dropped_paths, partial_keys, blob_refs, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.id,
      entry.channelId,
      entry.panelId,
      entry.data,
      JSON.stringify(entry.serializedKeys),
      JSON.stringify(entry.droppedPaths),
      JSON.stringify(entry.partialKeys),
      JSON.stringify(entry.blobRefs ?? []),
      entry.createdAt
    );
  }

  /** Store a spilled value's JSON content-addressed + chunked; returns its digest (idempotent). */
  async putBlob(valueJson: string): Promise<string> {
    const digest = await sha256Hex(valueJson);
    const already = this.sql
      .exec(`SELECT 1 FROM ${SCOPE_BLOB_TABLE} WHERE digest = ? LIMIT 1`, digest)
      .toArray()[0];
    if (!already) {
      for (let seq = 0, i = 0; i < valueJson.length; i += BLOB_CHUNK_CHARS, seq += 1) {
        this.sql.exec(
          `INSERT OR IGNORE INTO ${SCOPE_BLOB_TABLE} (digest, seq, chunk) VALUES (?, ?, ?)`,
          digest,
          seq,
          valueJson.slice(i, i + BLOB_CHUNK_CHARS)
        );
      }
    }
    return digest;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getBlob(digest: string): Promise<string | null> {
    const rows = this.sql
      .exec(`SELECT chunk FROM ${SCOPE_BLOB_TABLE} WHERE digest = ? ORDER BY seq ASC`, digest)
      .toArray() as Array<{ chunk: string }>;
    return rows.length ? rows.map((r) => r.chunk).join("") : null;
  }

  /** GC: delete blobs no longer referenced by any live scope row (content-addressed ⇒ a digest is
   *  garbage iff no row's `blob_refs` lists it). */
  // eslint-disable-next-line @typescript-eslint/require-await
  async sweepBlobs(): Promise<void> {
    const refRows = this.sql
      .exec(`SELECT blob_refs FROM ${SCOPE_TABLE}`)
      .toArray() as Array<{ blob_refs: string }>;
    const live = new Set<string>();
    for (const row of refRows) {
      for (const digest of JSON.parse(row.blob_refs || "[]") as string[]) live.add(digest);
    }
    const digests = this.sql
      .exec(`SELECT DISTINCT digest FROM ${SCOPE_BLOB_TABLE}`)
      .toArray() as Array<{ digest: string }>;
    for (const { digest } of digests) {
      if (!live.has(digest)) {
        this.sql.exec(`DELETE FROM ${SCOPE_BLOB_TABLE} WHERE digest = ?`, digest);
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async loadCurrent(channelId: string, panelId: string): Promise<ScopeEntry | null> {
    const row = this.sql
      .exec(
        `SELECT * FROM ${SCOPE_TABLE} WHERE channel_id = ? AND panel_id = ? ORDER BY created_at DESC LIMIT 1`,
        channelId,
        panelId
      )
      .toArray()[0] as ScopeRow | undefined;
    return row ? fromRow(row) : null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async get(id: string): Promise<ScopeEntry | null> {
    const row = this.sql.exec(`SELECT * FROM ${SCOPE_TABLE} WHERE id = ?`, id).toArray()[0] as
      | ScopeRow
      | undefined;
    return row ? fromRow(row) : null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async list(channelId: string): Promise<ScopeListEntry[]> {
    const rows = this.sql
      .exec(
        `SELECT id, serialized_keys, partial_keys, created_at FROM ${SCOPE_TABLE} WHERE channel_id = ? ORDER BY created_at ASC`,
        channelId
      )
      .toArray() as Array<{
      id: string;
      serialized_keys: string;
      partial_keys: string;
      created_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      keys: JSON.parse(row.serialized_keys) as string[],
      partial: JSON.parse(row.partial_keys) as string[],
    }));
  }
}

function fromRow(row: ScopeRow): ScopeEntry {
  return {
    id: row.id,
    channelId: row.channel_id,
    panelId: row.panel_id,
    data: row.data,
    serializedKeys: JSON.parse(row.serialized_keys) as string[],
    droppedPaths: JSON.parse(row.dropped_paths) as Array<{ path: string; reason: string }>,
    partialKeys: JSON.parse(row.partial_keys) as string[],
    blobRefs: JSON.parse(row.blob_refs || "[]") as string[],
    createdAt: row.created_at,
  };
}
