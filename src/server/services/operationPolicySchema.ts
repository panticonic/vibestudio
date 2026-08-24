import type { CanonicalSqliteSchema } from "@vibestudio/sqlite";

export const OPERATION_POLICY_SCHEMA: CanonicalSqliteSchema = {
  version: 1,
  objects: [
    {
      type: "table",
      name: "operation_policies",
      sql: `CREATE TABLE operation_policies (
        digest TEXT PRIMARY KEY,
        artifact_json TEXT NOT NULL,
        compiler_version TEXT NOT NULL,
        catalog_digest TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    },
  ],
};
