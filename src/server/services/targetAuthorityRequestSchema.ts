import type { CanonicalSqliteSchema } from "@vibestudio/sqlite";

export const TARGET_AUTHORITY_REQUEST_SCHEMA: CanonicalSqliteSchema = {
  version: 4,
  objects: [
    {
      type: "table",
      name: "authority_subjects",
      sql: `CREATE TABLE authority_subjects (
        target_subject TEXT PRIMARY KEY,
        authority_plan_digest TEXT NOT NULL,
        owner_user TEXT NOT NULL,
        controller_runtime_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active','retired')),
        created_at INTEGER NOT NULL,
        retired_at INTEGER
      )`,
    },
    {
      type: "table",
      name: "target_authority_requests",
      sql: `CREATE TABLE target_authority_requests (
        request_id TEXT PRIMARY KEY,
        target_subject TEXT NOT NULL,
        authority_plan_digest TEXT NOT NULL,
        operation_key TEXT NOT NULL,
        capability TEXT NOT NULL,
        resource_json TEXT NOT NULL,
        tier TEXT NOT NULL CHECK (tier IN ('gated','critical')),
        state TEXT NOT NULL CHECK (state IN ('pending','granted','denied','cancelled')),
        source_user TEXT NOT NULL,
        capability_definition_digest TEXT NOT NULL,
        review_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        settled_at INTEGER,
        grant_id TEXT,
        UNIQUE(target_subject, authority_plan_digest, operation_key)
      )`,
    },
    {
      type: "index",
      name: "target_authority_requests_state",
      sql: "CREATE INDEX target_authority_requests_state ON target_authority_requests(state, created_at)",
    },
  ],
};
