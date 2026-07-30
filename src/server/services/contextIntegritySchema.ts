import type { CanonicalSqliteSchema } from "@vibestudio/sqlite";

const SESSION_LATCHES_SQL = `CREATE TABLE session_latches (
  session_id TEXT PRIMARY KEY,
  class TEXT NOT NULL CHECK (class IN ('internal','external')),
  latch_epoch INTEGER NOT NULL CHECK (latch_epoch >= 0),
  updated_at INTEGER NOT NULL
)`;

const SESSION_LINEAGE_SQL = `CREATE TABLE session_lineage (
  session_id TEXT NOT NULL REFERENCES session_latches(session_id) ON DELETE CASCADE,
  lineage_key TEXT NOT NULL,
  class TEXT NOT NULL CHECK (class IN ('internal','external')),
  first_seen TEXT NOT NULL,
  via TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count > 0),
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, lineage_key)
)`;

const SESSION_LINEAGE_ORDER_SQL =
  "CREATE INDEX session_lineage_order ON session_lineage(session_id, ordinal)";

const VOUCHES_V4_SQL = `CREATE TABLE vouches (
  id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('repo','pkg','blob','file','lineage-set','cutover')),
  subject_key TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  via_prompt TEXT,
  revoked_at TEXT,
  UNIQUE (subject_kind, subject_key)
)`;

const TRUST_POLICIES_SQL = `CREATE TABLE trust_policies (
  id TEXT PRIMARY KEY,
  pattern_kind TEXT NOT NULL CHECK (pattern_kind IN ('pkg-name','repo-remote')),
  pattern_key TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  ceremony TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (pattern_kind, pattern_key)
)`;

const CONTENT_TRUST_META_SQL = `CREATE TABLE content_trust_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
)`;

const LINEAGE_SETS_SQL = `CREATE TABLE lineage_sets (
  set_key TEXT PRIMARY KEY,
  members_json TEXT NOT NULL,
  member_count INTEGER NOT NULL CHECK (member_count >= 2),
  created_at INTEGER NOT NULL
)`;

export const CONTEXT_INTEGRITY_SCHEMA: CanonicalSqliteSchema = {
  version: 4,
  objects: [
    { type: "table", name: "session_latches", sql: SESSION_LATCHES_SQL },
    { type: "table", name: "session_lineage", sql: SESSION_LINEAGE_SQL },
    { type: "index", name: "session_lineage_order", sql: SESSION_LINEAGE_ORDER_SQL },
    { type: "table", name: "vouches", sql: VOUCHES_V4_SQL },
    { type: "table", name: "trust_policies", sql: TRUST_POLICIES_SQL },
    { type: "table", name: "content_trust_meta", sql: CONTENT_TRUST_META_SQL },
    { type: "table", name: "lineage_sets", sql: LINEAGE_SETS_SQL },
  ],
};
