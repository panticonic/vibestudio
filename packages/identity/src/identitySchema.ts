import type { CanonicalSqliteMigration, CanonicalSqliteSchema } from "@vibestudio/sqlite";

/**
 * Identity and machine-control share one file and therefore one atomic schema.
 * Version 15 is the current schema. The explicitly enumerated final
 * pre-cutover schema below migrates transactionally; every other shape is rejected.
 */
export const IDENTITY_DATABASE_SCHEMA_VERSION = 15;

const USER_WORKSPACES_SQL = `CREATE TABLE user_workspaces (
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('personal', 'system')),
  workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role)
)`;

const WORKSPACE_RPC_POLICY_SQL = `CREATE TABLE workspace_rpc_policy (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  policy_json TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`;

export const IDENTITY_DATABASE_SCHEMA: CanonicalSqliteSchema = {
  version: IDENTITY_DATABASE_SCHEMA_VERSION,
  objects: [
    {
      type: "table",
      name: "users",
      sql: `CREATE TABLE users (
        id TEXT PRIMARY KEY,
        handle TEXT NOT NULL COLLATE NOCASE UNIQUE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL,
        avatar_blob TEXT,
        color TEXT,
        created_at INTEGER NOT NULL,
        created_by TEXT,
        revoked_at INTEGER
      )`,
    },
    {
      type: "table",
      name: "devices",
      sql: `CREATE TABLE devices (
        device_id TEXT PRIMARY KEY,
        refresh_token_hash TEXT NOT NULL,
        transport_kind TEXT NOT NULL,
        endpoint_id TEXT,
        user_id TEXT NOT NULL REFERENCES users(id),
        label TEXT NOT NULL,
        platform TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER,
        CHECK (
          (transport_kind = 'local' AND endpoint_id IS NULL)
          OR
          (transport_kind = 'iroh' AND endpoint_id IS NOT NULL AND length(endpoint_id) = 64 AND endpoint_id = lower(endpoint_id))
        )
      )`,
    },
    {
      type: "index",
      name: "devices_by_user",
      sql: "CREATE INDEX devices_by_user ON devices(user_id)",
    },
    {
      type: "index",
      name: "devices_by_endpoint",
      sql: "CREATE UNIQUE INDEX devices_by_endpoint ON devices(endpoint_id) WHERE endpoint_id IS NOT NULL",
    },
    {
      type: "table",
      name: "agent_credentials",
      sql: `CREATE TABLE agent_credentials (
        agent_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        entity_id TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        revoked_at INTEGER
      )`,
    },
    {
      type: "table",
      name: "pairing_codes",
      sql: `CREATE TABLE pairing_codes (
        code TEXT PRIMARY KEY,
        user_id TEXT,
        workspace_id TEXT REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
        intent TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )`,
    },
    {
      type: "table",
      name: "membership",
      sql: `CREATE TABLE membership (
        user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        added_by TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin', 'member')),
        PRIMARY KEY (user_id, workspace_id)
      )`,
    },
    {
      type: "table",
      name: "user_revocation_cleanup",
      sql: `CREATE TABLE user_revocation_cleanup (
        user_id TEXT NOT NULL REFERENCES users(id),
        workspace_id TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        PRIMARY KEY (user_id, workspace_id)
      )`,
    },
    {
      type: "index",
      name: "membership_by_workspace",
      sql: "CREATE INDEX membership_by_workspace ON membership(workspace_id)",
    },
    {
      type: "table",
      name: "workspaces",
      sql: `CREATE TABLE workspaces (
        workspace_id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        last_opened INTEGER NOT NULL,
        creation_intent_json TEXT
      )`,
    },
    {
      type: "index",
      name: "workspaces_by_last_opened",
      sql: "CREATE INDEX workspaces_by_last_opened ON workspaces(last_opened DESC, name)",
    },
    {
      type: "table",
      name: "user_workspaces",
      sql: USER_WORKSPACES_SQL,
    },
    {
      type: "table",
      name: "workspace_rpc_policy",
      sql: WORKSPACE_RPC_POLICY_SQL,
    },
    {
      type: "table",
      name: "user_workspace_targets",
      sql: `CREATE TABLE user_workspace_targets (
        user_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
        last_opened INTEGER NOT NULL
      )`,
    },
    {
      type: "table",
      name: "hub_preferences",
      sql: `CREATE TABLE hub_preferences (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
    },
    {
      type: "table",
      name: "hub_process_lease",
      sql: `CREATE TABLE hub_process_lease (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        owner_boot_id TEXT NOT NULL,
        gateway_port INTEGER NOT NULL,
        pid INTEGER NOT NULL,
        acquired_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL CHECK(expires_at > heartbeat_at)
      )`,
    },
    {
      type: "table",
      name: "ephemeral_workspace_cleanup",
      sql: `CREATE TABLE ephemeral_workspace_cleanup (
        cleanup_id TEXT PRIMARY KEY,
        disk_name TEXT NOT NULL UNIQUE,
        source_owner_boot_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    },
  ],
};

/**
 * Version 14 already exists in installed developer profiles; its account-only
 * pairing migration preserves those profiles. The earlier v13 workspace cutover adds
 * private designations and hard RPC policies, records legacy root access as
 * explicit membership, and seeds workspace roles from existing account roles.
 * Later account-role changes do not confer workspace membership or administration.
 * The existing shipped v11 -> v13 migration still retires obsolete signaling
 * rooms and makes unbound devices local-only before this cutover runs.
 */
export const IDENTITY_DATABASE_MIGRATIONS: readonly CanonicalSqliteMigration[] = [
  {
    fromVersion: 14,
    toVersion: 15,
    migrate(db) {
      // Account bootstrap has no workspace until the authenticated owner
      // creates their private pair. Preserve all existing invitation rows.
      db.exec(`ALTER TABLE pairing_codes RENAME TO pairing_codes_v14;
        CREATE TABLE pairing_codes (
          code TEXT PRIMARY KEY,
          user_id TEXT,
          workspace_id TEXT REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
          intent TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        INSERT INTO pairing_codes SELECT * FROM pairing_codes_v14;
        DROP TABLE pairing_codes_v14`);
    },
  },
  {
    fromVersion: 13,
    toVersion: 14,
    migrate(db) {
      db.exec(`${USER_WORKSPACES_SQL}; ${WORKSPACE_RPC_POLICY_SQL};
        ALTER TABLE membership RENAME TO membership_v13;
        CREATE TABLE membership (
          user_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          added_by TEXT NOT NULL,
          added_at INTEGER NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('admin', 'member')),
          PRIMARY KEY (user_id, workspace_id)
        );
        INSERT INTO membership (user_id, workspace_id, added_by, added_at, role)
          SELECT m.user_id, m.workspace_id, m.added_by, m.added_at,
            CASE WHEN u.role IN ('root', 'admin') THEN 'admin' ELSE 'member' END
          FROM membership_v13 m JOIN users u ON u.id = m.user_id;
        DROP TABLE membership_v13;
        CREATE INDEX membership_by_workspace ON membership(workspace_id);
        INSERT OR IGNORE INTO membership (user_id, workspace_id, added_by, added_at, role)
          SELECT u.id, w.workspace_id, u.id, u.created_at, 'admin'
          FROM users u CROSS JOIN workspaces w
          WHERE u.role = 'root' AND u.revoked_at IS NULL`);
    },
  },
  {
    fromVersion: 11,
    toVersion: 13,
    migrate(db) {
      db.exec(`
        DROP TABLE control_rooms;
        DELETE FROM pairing_codes;
        DROP INDEX devices_by_user;
        ALTER TABLE devices RENAME TO devices_v11;
        CREATE TABLE devices (
          device_id TEXT PRIMARY KEY,
          refresh_token_hash TEXT NOT NULL,
          transport_kind TEXT NOT NULL,
          endpoint_id TEXT,
          user_id TEXT NOT NULL REFERENCES users(id),
          label TEXT NOT NULL,
          platform TEXT,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER,
          revoked_at INTEGER,
          CHECK (
            (transport_kind = 'local' AND endpoint_id IS NULL)
            OR
            (transport_kind = 'iroh' AND endpoint_id IS NOT NULL AND length(endpoint_id) = 64 AND endpoint_id = lower(endpoint_id))
          )
        );
        INSERT INTO devices (
          device_id, refresh_token_hash, transport_kind, endpoint_id, user_id,
          label, platform, created_at, last_used_at, revoked_at
        )
        SELECT
          device_id, refresh_token_hash, 'local', NULL, user_id,
          label, platform, created_at, last_used_at, revoked_at
        FROM devices_v11;
        DROP TABLE devices_v11;
        CREATE INDEX devices_by_user ON devices(user_id);
        CREATE UNIQUE INDEX devices_by_endpoint ON devices(endpoint_id) WHERE endpoint_id IS NOT NULL;
      `);
    },
  },
];
