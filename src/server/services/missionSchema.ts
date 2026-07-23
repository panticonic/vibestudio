import type { CanonicalSqliteMigrationPlan, CanonicalSqliteSchema } from "@vibestudio/sqlite";
import {
  missionClosureDigest,
  type MissionCharter,
  type MissionStandingRestriction,
} from "@vibestudio/shared/authority/mission";

const MISSIONS_V1_SQL = `CREATE TABLE missions (
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
    )`;

// SQLite rewrites the source text in this exact form when ADD COLUMN migrates
// v1. Fresh and upgraded databases deliberately share that canonical shape.
const MISSIONS_V2_SQL = `CREATE TABLE missions (
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
      updated_at INTEGER NOT NULL,
    seed_snapshot_state TEXT)`;

const MISSIONS_V3_SQL = `CREATE TABLE missions (
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
      updated_at INTEGER NOT NULL,
    seed_snapshot_state TEXT, permissions_json TEXT NOT NULL DEFAULT '[]')`;

const MISSION_REVISIONS_V1_SQL = `CREATE TABLE mission_revisions (
      mission_id TEXT NOT NULL REFERENCES missions(mission_id),
      revision INTEGER NOT NULL,
      charter_json TEXT NOT NULL,
      closure_digest TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      PRIMARY KEY (mission_id, revision)
    )`;

const MISSION_REVISIONS_V3_SQL = `CREATE TABLE mission_revisions (
      mission_id TEXT NOT NULL REFERENCES missions(mission_id),
      revision INTEGER NOT NULL,
      charter_json TEXT NOT NULL,
      closure_digest TEXT NOT NULL,
      recorded_at INTEGER NOT NULL, permissions_json TEXT NOT NULL DEFAULT '[]', standing_restrictions_json TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (mission_id, revision)
    )`;

const MISSION_SCHEMA_V1: CanonicalSqliteSchema = {
  version: 1,
  objects: [
    {
      type: "table",
      name: "missions",
      sql: MISSIONS_V1_SQL,
    },
    {
      type: "table",
      name: "mission_revisions",
      sql: MISSION_REVISIONS_V1_SQL,
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

const MISSION_SCHEMA_V2: CanonicalSqliteSchema = {
  ...MISSION_SCHEMA_V1,
  version: 2,
  objects: MISSION_SCHEMA_V1.objects.map((object) =>
    object.type === "table" && object.name === "missions"
      ? { ...object, sql: MISSIONS_V2_SQL }
      : object
  ),
};

export const MISSION_SCHEMA: CanonicalSqliteSchema = {
  ...MISSION_SCHEMA_V2,
  version: 3,
  objects: MISSION_SCHEMA_V2.objects.map((object) => {
    if (object.type !== "table") return object;
    if (object.name === "missions") return { ...object, sql: MISSIONS_V3_SQL };
    if (object.name === "mission_revisions") {
      return { ...object, sql: MISSION_REVISIONS_V3_SQL };
    }
    return object;
  }),
};

export const MISSION_MIGRATION_PLAN: CanonicalSqliteMigrationPlan = {
  current: MISSION_SCHEMA,
  migrations: [
    {
      name: "bind-seeded-missions-to-product-snapshot",
      from: MISSION_SCHEMA_V1,
      to: MISSION_SCHEMA_V2,
      migrate(db) {
        db.exec("ALTER TABLE missions ADD COLUMN seed_snapshot_state TEXT");
      },
    },
    {
      name: "bind-mission-authority-to-closure",
      from: MISSION_SCHEMA_V2,
      to: MISSION_SCHEMA,
      migrate(db) {
        db.exec("ALTER TABLE missions ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '[]'");
        db.exec(
          "ALTER TABLE mission_revisions ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '[]'"
        );
        db.exec(
          "ALTER TABLE mission_revisions ADD COLUMN standing_restrictions_json TEXT NOT NULL DEFAULT '[]'"
        );
        const rows = db
          .prepare("SELECT mission_id,charter_json,standing_restrictions_json,state FROM missions")
          .all() as Array<{
          mission_id: string;
          charter_json: string;
          standing_restrictions_json: string;
          state: string;
        }>;
        const update = db.prepare(
          `UPDATE missions
           SET closure_digest=?,
               state=CASE WHEN state IN ('active','paused') THEN 'needs-reapproval' ELSE state END
           WHERE mission_id=?`
        );
        for (const row of rows) {
          const charter = JSON.parse(row.charter_json) as MissionCharter;
          const restrictions = JSON.parse(
            row.standing_restrictions_json
          ) as MissionStandingRestriction[];
          update.run(missionClosureDigest(charter, [], restrictions), row.mission_id);
        }
      },
    },
  ],
};
