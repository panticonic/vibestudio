import type { CanonicalSqliteSchema } from "@vibestudio/sqlite";

/** Identity and machine-control share one file and therefore one atomic schema. */
export const IDENTITY_DATABASE_SCHEMA_VERSION = 5;

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
        user_id TEXT NOT NULL REFERENCES users(id),
        label TEXT NOT NULL,
        platform TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      )`,
    },
    {
      type: "index",
      name: "devices_by_user",
      sql: "CREATE INDEX devices_by_user ON devices(user_id)",
    },
    {
      type: "table",
      name: "agent_credentials",
      sql: `CREATE TABLE agent_credentials (
        agent_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        scopes TEXT,
        user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        revoked_at INTEGER
      )`,
    },
    {
      type: "index",
      name: "agent_credentials_by_entity",
      sql: "CREATE INDEX agent_credentials_by_entity ON agent_credentials(entity_id)",
    },
    {
      type: "table",
      name: "pairing_codes",
      sql: `CREATE TABLE pairing_codes (
        code TEXT PRIMARY KEY,
        user_id TEXT,
        workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
        intent TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )`,
    },
    {
      type: "table",
      name: "pairing_receipts",
      sql: `CREATE TABLE pairing_receipts (
        code TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
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
        last_opened INTEGER NOT NULL
      )`,
    },
    {
      type: "index",
      name: "workspaces_by_last_opened",
      sql: "CREATE INDEX workspaces_by_last_opened ON workspaces(last_opened DESC, name)",
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
      name: "hub_runtime",
      sql: `CREATE TABLE hub_runtime (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        gateway_port INTEGER NOT NULL,
        pid INTEGER NOT NULL,
        server_id TEXT NOT NULL,
        server_boot_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        version TEXT NOT NULL
      )`,
    },
  ],
};
