import type { CanonicalSqliteMigrationPlan, CanonicalSqliteSchema } from "@vibestudio/sqlite";

const CONTEXT_INTEGRITY_SCHEMA_V1: CanonicalSqliteSchema = {
  version: 1,
  objects: [
    {
      type: "table",
      name: "session_latches",
      sql: `CREATE TABLE session_latches (
      session_id TEXT PRIMARY KEY,
      class TEXT NOT NULL CHECK (class IN ('internal','external')),
      latch_epoch INTEGER NOT NULL CHECK (latch_epoch >= 0),
      updated_at INTEGER NOT NULL
    )`,
    },
    {
      type: "table",
      name: "session_lineage",
      sql: `CREATE TABLE session_lineage (
      session_id TEXT NOT NULL REFERENCES session_latches(session_id) ON DELETE CASCADE,
      lineage_key TEXT NOT NULL,
      class TEXT NOT NULL CHECK (class IN ('internal','external')),
      first_seen TEXT NOT NULL,
      via TEXT NOT NULL,
      count INTEGER NOT NULL CHECK (count > 0),
      ordinal INTEGER NOT NULL,
      PRIMARY KEY (session_id, lineage_key)
    )`,
    },
    {
      type: "index",
      name: "session_lineage_order",
      sql: "CREATE INDEX session_lineage_order ON session_lineage(session_id, ordinal)",
    },
    {
      type: "table",
      name: "vouches",
      sql: `CREATE TABLE vouches (
      id TEXT PRIMARY KEY,
      subject_kind TEXT NOT NULL CHECK (subject_kind IN ('repo','pkg','blob','file','cutover')),
      subject_key TEXT NOT NULL,
      decided_by TEXT NOT NULL,
      decided_at TEXT NOT NULL,
      via_prompt TEXT,
      revoked_at TEXT,
      UNIQUE (subject_kind, subject_key)
    )`,
    },
    {
      type: "table",
      name: "trust_policies",
      sql: `CREATE TABLE trust_policies (
      id TEXT PRIMARY KEY,
      pattern_kind TEXT NOT NULL CHECK (pattern_kind IN ('pkg-name','repo-remote')),
      pattern_key TEXT NOT NULL,
      decided_by TEXT NOT NULL,
      decided_at TEXT NOT NULL,
      ceremony TEXT NOT NULL,
      revoked_at TEXT,
      UNIQUE (pattern_kind, pattern_key)
    )`,
    },
  ],
};

const CONTENT_TRUST_META_SQL = `CREATE TABLE content_trust_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
)`;

const CONTEXT_INTEGRITY_SCHEMA_V2: CanonicalSqliteSchema = {
  version: 2,
  objects: [
    ...CONTEXT_INTEGRITY_SCHEMA_V1.objects,
    { type: "table", name: "content_trust_meta", sql: CONTENT_TRUST_META_SQL },
  ],
};

export const CONTEXT_INTEGRITY_SCHEMA: CanonicalSqliteSchema = {
  ...CONTEXT_INTEGRITY_SCHEMA_V2,
  version: 3,
};

export const CONTEXT_INTEGRITY_MIGRATION_PLAN: CanonicalSqliteMigrationPlan = {
  current: CONTEXT_INTEGRITY_SCHEMA,
  migrations: [
    {
      name: "record-context-integrity-cutover",
      from: CONTEXT_INTEGRITY_SCHEMA_V1,
      to: CONTEXT_INTEGRITY_SCHEMA_V2,
      migrate(db) {
        db.exec(CONTENT_TRUST_META_SQL);
      },
    },
    {
      name: "canonicalize-cutover-state-coordinate",
      from: CONTEXT_INTEGRITY_SCHEMA_V2,
      to: CONTEXT_INTEGRITY_SCHEMA,
      migrate(db) {
        // The pre-release v2 bootstrap wrote the workspace id here. It never
        // represented a content snapshot and therefore granted no trust; drop
        // that invalid marker so the activation transaction can record the
        // exact semantic state. Canonical state markers are retained.
        db.prepare(
          "DELETE FROM content_trust_meta WHERE key='grandfather-root' AND value NOT GLOB 'state:[0-9a-f]*'"
        ).run();
      },
    },
  ],
};
