import type { CanonicalSqliteSchema } from "@vibestudio/sqlite";

export const REVIEWED_CLOSURE_SCHEMA: CanonicalSqliteSchema = {
  version: 1,
  objects: [
    {
      type: "table",
      name: "reviewed_closures",
      sql: `CREATE TABLE reviewed_closures (
        subject TEXT PRIMARY KEY,
        closure_digest TEXT NOT NULL,
        body_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active','suspended','retired')),
        activated_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    },
    {
      type: "table",
      name: "reviewed_closure_sessions",
      sql: `CREATE TABLE reviewed_closure_sessions (
        session_id TEXT PRIMARY KEY,
        subject TEXT NOT NULL REFERENCES reviewed_closures(subject),
        closure_digest TEXT NOT NULL,
        task_ref TEXT NOT NULL,
        binder_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER
      )`,
    },
  ],
};
