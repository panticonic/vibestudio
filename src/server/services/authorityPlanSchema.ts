import type { CanonicalSqliteSchema } from "@vibestudio/sqlite";

export const AUTHORITY_PLAN_SCHEMA: CanonicalSqliteSchema = {
  version: 1,
  objects: [
    {
      type: "table",
      name: "authority_plans",
      sql: `CREATE TABLE authority_plans (
        digest TEXT PRIMARY KEY,
        artifact_json TEXT NOT NULL,
        compiler_version TEXT NOT NULL,
        catalog_digest TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    },
  ],
};
