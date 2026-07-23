import type { CanonicalSqliteMigrationPlan, CanonicalSqliteSchema } from "@vibestudio/sqlite";

export const MISSION_SCHEMA: CanonicalSqliteSchema = {
  version: 1,
  objects: [
    {
      type: "table",
      name: "missions",
      sql: `CREATE TABLE missions (
      mission_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      charter_json TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      owner_device_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('draft','active','needs-reapproval','paused','retired')),
      closure_digest TEXT NOT NULL,
      standing_restrictions_json TEXT NOT NULL DEFAULT '[]',
      seeded INTEGER NOT NULL DEFAULT 0 CHECK (seeded IN (0,1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    },
    {
      type: "table",
      name: "mission_revisions",
      sql: `CREATE TABLE mission_revisions (
      mission_id TEXT NOT NULL REFERENCES missions(mission_id),
      revision INTEGER NOT NULL,
      charter_json TEXT NOT NULL,
      closure_digest TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      PRIMARY KEY (mission_id, revision)
    )`,
    },
    {
      type: "table",
      name: "mission_sessions",
      sql: `CREATE TABLE mission_sessions (
      session_id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES missions(mission_id),
      closure_digest TEXT NOT NULL,
      task_ref TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    )`,
    },
    {
      type: "table",
      name: "mission_runs",
      sql: `CREATE TABLE mission_runs (
      run_id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES missions(mission_id),
      closure_digest TEXT NOT NULL,
      session_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      outcome TEXT
    )`,
    },
    {
      type: "index",
      name: "mission_runs_by_mission",
      sql: "CREATE INDEX mission_runs_by_mission ON mission_runs(mission_id, started_at)",
    },
  ],
};

export const MISSION_MIGRATION_PLAN: CanonicalSqliteMigrationPlan = {
  current: MISSION_SCHEMA,
  migrations: [],
};
