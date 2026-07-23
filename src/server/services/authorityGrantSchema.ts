import type { CanonicalSqliteMigrationPlan, CanonicalSqliteSchema } from "@vibestudio/sqlite";

export const AUTHORITY_GRANTS_SCHEMA_VERSION = 1;

export const AUTHORITY_GRANTS_SCHEMA: CanonicalSqliteSchema = {
  version: AUTHORITY_GRANTS_SCHEMA_VERSION,
  objects: [
    {
      type: "table",
      name: "authority_grants",
      sql: `CREATE TABLE authority_grants (
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
        consumed_at INTEGER
      )`,
    },
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
    {
      type: "table",
      name: "preauth_envelopes",
      sql: `CREATE TABLE preauth_envelopes (
        envelope_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        task_ref TEXT NOT NULL,
        mission_subject TEXT,
        state TEXT NOT NULL CHECK (state IN ('active','closed')),
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        closed_at INTEGER
      )`,
    },
    {
      type: "table",
      name: "envelope_rules",
      sql: `CREATE TABLE envelope_rules (
        envelope_id TEXT NOT NULL REFERENCES preauth_envelopes(envelope_id),
        capability TEXT NOT NULL,
        resource_key TEXT NOT NULL,
        resource_scope TEXT NOT NULL DEFAULT 'exact' CHECK (resource_scope IN ('exact','prefix','origin','domain','network')),
        worst_case_severity TEXT NOT NULL CHECK (worst_case_severity IN ('routine','sensitive')),
        PRIMARY KEY (envelope_id, capability, resource_key)
      )`,
    },
  ],
};

export const AUTHORITY_GRANTS_MIGRATION_PLAN: CanonicalSqliteMigrationPlan = {
  current: AUTHORITY_GRANTS_SCHEMA,
  migrations: [],
};
