import type { CanonicalSqliteSchema } from "@vibestudio/sqlite";

const HANDLE_TABLE_SQL = `CREATE TABLE userland_resource_handles (
  handle TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  capability_definition_digest TEXT NOT NULL,
  provider TEXT NOT NULL,
  receiver_source TEXT NOT NULL,
  receiver_class TEXT NOT NULL,
  receiver_object_key TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  selector TEXT NOT NULL,
  presentation_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revocation_reason TEXT
)`;

export const USERLAND_RESOURCE_HANDLE_SCHEMA: CanonicalSqliteSchema = {
  version: 1,
  objects: [
    { type: "table", name: "userland_resource_handles", sql: HANDLE_TABLE_SQL },
    {
      type: "index",
      name: "urh_provider",
      sql: "CREATE INDEX urh_provider ON userland_resource_handles(workspace_id, provider, revoked_at)",
    },
    {
      type: "index",
      name: "urh_receiver",
      sql: "CREATE INDEX urh_receiver ON userland_resource_handles(workspace_id, receiver_source, receiver_class, receiver_object_key, revoked_at)",
    },
  ],
};
