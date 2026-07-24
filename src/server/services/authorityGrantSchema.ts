import type { CanonicalSqliteMigrationPlan, CanonicalSqliteSchema } from "@vibestudio/sqlite";

const AUTHORITY_GRANTS_TABLE_SQL = `CREATE TABLE authority_grants (
  id TEXT PRIMARY KEY,
  effect TEXT NOT NULL CHECK (effect IN ('allow','deny')),
  capability TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  resource_scope TEXT NOT NULL DEFAULT 'exact' CHECK (resource_scope IN ('exact','prefix','origin','domain','network')),
  subject TEXT NOT NULL,
  session_id TEXT,
  invocation_digest TEXT,
  mission_subject TEXT,
  envelope_id TEXT,
  lineage_at_consent TEXT NOT NULL DEFAULT '[]',
  issued_by TEXT NOT NULL,
  provenance TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  consumed_at INTEGER,
  agent_binding_id TEXT,
  scope TEXT NOT NULL DEFAULT 'system' CHECK (scope IN ('once','task','agent','mission','version','session','system')),
  suspended_at INTEGER,
  last_used_at INTEGER,
  decided_by TEXT,
  decision_surface TEXT,
  task_ref TEXT
)`;

const PREAUTH_ENVELOPES_SQL = `CREATE TABLE preauth_envelopes (
  envelope_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  task_ref TEXT NOT NULL,
  mission_subject TEXT,
  state TEXT NOT NULL CHECK (state IN ('active','closed')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  closed_at INTEGER
)`;

const ENVELOPE_RULES_SQL = `CREATE TABLE envelope_rules (
  envelope_id TEXT NOT NULL REFERENCES preauth_envelopes(envelope_id),
  capability TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  resource_scope TEXT NOT NULL DEFAULT 'exact' CHECK (resource_scope IN ('exact','prefix','origin','domain','network')),
  worst_case_severity TEXT NOT NULL CHECK (worst_case_severity IN ('routine','sensitive')),
  PRIMARY KEY (envelope_id, capability, resource_key)
)`;

const AUTHORITY_LOCKS_SQL = `CREATE TABLE authority_locks (
  id TEXT PRIMARY KEY,
  agent_binding_id TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('resource','capability','cell')),
  capability TEXT,
  resource_key TEXT,
  resource_scope TEXT CHECK (resource_scope IS NULL OR resource_scope IN ('exact','prefix','origin','domain','network')),
  domain TEXT,
  verb TEXT,
  decided_by TEXT NOT NULL,
  decision_surface TEXT NOT NULL CHECK (decision_surface IN ('card','profile')),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  CHECK (
    (level = 'resource' AND capability IS NOT NULL AND resource_key IS NOT NULL AND domain IS NULL AND verb IS NULL) OR
    (level = 'capability' AND capability IS NOT NULL AND resource_key IS NULL AND domain IS NULL AND verb IS NULL) OR
    (level = 'cell' AND capability IS NULL AND resource_key IS NULL AND domain IS NOT NULL AND verb IS NOT NULL)
  )
)`;

export const AUTHORITY_GRANTS_SCHEMA_VERSION = 4;

export const AUTHORITY_GRANTS_SCHEMA: CanonicalSqliteSchema = {
  version: AUTHORITY_GRANTS_SCHEMA_VERSION,
  objects: [
    { type: "table", name: "authority_grants", sql: AUTHORITY_GRANTS_TABLE_SQL },
    {
      type: "index",
      name: "ag_subject",
      sql: "CREATE INDEX ag_subject ON authority_grants(subject, capability)",
    },
    {
      type: "index",
      name: "ag_session",
      sql: "CREATE INDEX ag_session ON authority_grants(session_id) WHERE session_id IS NOT NULL",
    },
    { type: "table", name: "preauth_envelopes", sql: PREAUTH_ENVELOPES_SQL },
    { type: "table", name: "authority_locks", sql: AUTHORITY_LOCKS_SQL },
    {
      type: "index",
      name: "al_binding",
      sql: "CREATE INDEX al_binding ON authority_locks(agent_binding_id, revoked_at)",
    },
    { type: "table", name: "envelope_rules", sql: ENVELOPE_RULES_SQL },
  ],
};

export const AUTHORITY_GRANTS_MIGRATION_PLAN: CanonicalSqliteMigrationPlan = {
  current: AUTHORITY_GRANTS_SCHEMA,
  migrations: [],
};
