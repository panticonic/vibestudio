/**
 * Machine control data stored in the hub-owned SQLite database.
 *
 * The workspace catalog, per-user resume cursor, and machine preferences live
 * beside identity in `server-auth/identity.db`. SQLite row updates replace the
 * retired machine-wide `data.json` snapshot and are safe across the desktop and
 * hub processes.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { randomBytes } from "node:crypto";
import { DatabaseSync, type SQLOutputValue, type StatementSync } from "node:sqlite";
import { getCentralDataPath } from "@vibestudio/env-paths";
import type { WorkspaceEntry } from "./types.js";
import {
  assertCanonicalSqliteSchema,
  initializeCanonicalSqliteSchema,
  isTrulyEmptySqliteDatabase,
} from "@vibestudio/sqlite";
import { IDENTITY_DATABASE_SCHEMA } from "@vibestudio/identity/identitySchema";

export interface CentralDataManagerOptions {
  databasePath?: string;
  now?: () => number;
}

export interface HubRuntimeRecord {
  gatewayPort: number;
  pid: number;
  serverId: string;
  serverBootId: string;
  startedAt: number;
  version: string;
}

export interface EphemeralWorkspaceRecord extends WorkspaceEntry {
  diskName?: string;
}

function mintWorkspaceId(): string {
  return `ws_${randomBytes(18).toString("base64url")}`;
}

const EPHEMERAL_WORKSPACE_KEY = "ephemeral_workspace";

function parseEphemeralWorkspaceMarker(value: SQLOutputValue): {
  workspaceId: string;
  name: string;
  diskName?: string;
} {
  if (typeof value !== "string") throw new Error("Invalid ephemeral workspace marker type");
  const parsed = JSON.parse(value) as unknown;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (Object.keys(parsed).length !== 2 && Object.keys(parsed).length !== 3) ||
    typeof (parsed as { workspaceId?: unknown }).workspaceId !== "string" ||
    typeof (parsed as { name?: unknown }).name !== "string" ||
    ((parsed as { diskName?: unknown }).diskName !== undefined &&
      (typeof (parsed as { diskName?: unknown }).diskName !== "string" ||
        !/^dev-[0-9a-f]{8}$/.test((parsed as { diskName: string }).diskName))) ||
    Object.keys(parsed).some((key) => !["workspaceId", "name", "diskName"].includes(key))
  ) {
    throw new Error("Invalid ephemeral workspace marker schema");
  }
  return parsed as { workspaceId: string; name: string; diskName?: string };
}

function rowToWorkspace(row: Record<string, SQLOutputValue>): WorkspaceEntry {
  return {
    workspaceId: row["workspace_id"] as string,
    name: row["name"] as string,
    lastOpened: row["last_opened"] as number,
  };
}

function rowToHubRuntime(row: Record<string, SQLOutputValue>): HubRuntimeRecord {
  return {
    gatewayPort: row["gateway_port"] as number,
    pid: row["pid"] as number,
    serverId: row["server_id"] as string,
    serverBootId: row["server_boot_id"] as string,
    startedAt: row["started_at"] as number,
    version: row["version"] as string,
  };
}

/** Thin row-oriented wrapper around the hub control tables. */
export class CentralDataManager {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private readonly now: () => number;

  constructor(options: CentralDataManagerOptions = {}) {
    const databasePath =
      options.databasePath ??
      path.join(getCentralDataPath(), "server-auth", "identity.db");
    this.now = options.now ?? Date.now;
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    try {
      if (isTrulyEmptySqliteDatabase(this.db)) {
        initializeCanonicalSqliteSchema(this.db, IDENTITY_DATABASE_SCHEMA);
      } else {
        assertCanonicalSqliteSchema(
          this.db,
          IDENTITY_DATABASE_SCHEMA,
          `hub-control schema in ${databasePath}`
        );
      }
      // WAL changes the file, so enable it only after an existing DB has passed
      // the exact read-only preflight (or after a new DB was initialized).
      this.db.exec("PRAGMA journal_mode = WAL");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  listWorkspaces(): WorkspaceEntry[] {
    return this.stmt("SELECT * FROM workspaces ORDER BY last_opened DESC, name")
      .all()
      .map(rowToWorkspace);
  }

  hasWorkspace(name: string): boolean {
    return this.stmt("SELECT 1 AS one FROM workspaces WHERE name = ?").get(name) !== undefined;
  }

  /** Reserve/register a name exactly once; re-registering preserves its opaque id. */
  addWorkspace(name: string): WorkspaceEntry {
    const normalized = name.trim();
    if (!normalized) throw new Error("Workspace name is required");
    const row = this.stmt(
      `INSERT INTO workspaces (workspace_id, name, last_opened)
       VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET last_opened = excluded.last_opened
       RETURNING *`
    ).get(mintWorkspaceId(), normalized, this.now());
    if (!row) {
      throw new Error(`Workspace registration did not return a row: ${normalized}`);
    }
    return rowToWorkspace(row);
  }

  /**
   * Atomically register the one disposable development workspace and its
   * crash-recovery marker. A persistent workspace can never be adopted or
   * overwritten as ephemeral.
   */
  addEphemeralWorkspace(name: string): EphemeralWorkspaceRecord {
    const normalized = name.trim();
    if (!normalized) throw new Error("Ephemeral workspace name is required");
    return this.transaction(() => {
      if (
        this.stmt("SELECT 1 AS one FROM hub_preferences WHERE key = ?").get(EPHEMERAL_WORKSPACE_KEY)
      ) {
        throw new Error("An ephemeral workspace lifecycle is already registered");
      }
      if (this.stmt("SELECT 1 AS one FROM workspaces WHERE name = ?").get(normalized)) {
        throw new Error(`Cannot shadow persistent workspace \"${normalized}\" with ephemeral dev`);
      }
      const workspaceId = mintWorkspaceId();
      const row = this.stmt(
        `INSERT INTO workspaces (workspace_id, name, last_opened)
         VALUES (?, ?, ?) RETURNING *`
      ).get(workspaceId, normalized, this.now());
      if (!row) throw new Error("Ephemeral workspace registration returned no row");
      this.stmt("INSERT INTO hub_preferences (key, value) VALUES (?, ?)").run(
        EPHEMERAL_WORKSPACE_KEY,
        JSON.stringify({ workspaceId, name: normalized })
      );
      return rowToWorkspace(row);
    });
  }

  /** Record the random on-disk child name before spawn for crash cleanup. */
  setEphemeralWorkspaceDiskName(workspaceId: string, diskName: string): void {
    if (!/^dev-[0-9a-f]{8}$/.test(diskName)) {
      throw new Error("Invalid ephemeral workspace disk name");
    }
    this.transaction(() => {
      const row = this.stmt("SELECT value FROM hub_preferences WHERE key = ?").get(
        EPHEMERAL_WORKSPACE_KEY
      );
      if (!row) throw new Error("No ephemeral workspace lifecycle is registered");
      const marker = parseEphemeralWorkspaceMarker(row["value"]!);
      if (marker.workspaceId !== workspaceId) {
        throw new Error("Ephemeral workspace marker does not match the running workspace");
      }
      this.stmt("UPDATE hub_preferences SET value = ? WHERE key = ?").run(
        JSON.stringify({ ...marker, diskName }),
        EPHEMERAL_WORKSPACE_KEY
      );
    });
  }

  getEphemeralWorkspace(): EphemeralWorkspaceRecord | null {
    const markerRow = this.stmt("SELECT value FROM hub_preferences WHERE key = ?").get(
      EPHEMERAL_WORKSPACE_KEY
    );
    if (!markerRow) return null;
    const marker = parseEphemeralWorkspaceMarker(markerRow["value"]!);
    const workspace = this.getWorkspaceEntry(marker.name);
    return {
      workspaceId: marker.workspaceId,
      name: marker.name,
      lastOpened: workspace?.lastOpened ?? 0,
      ...(marker.diskName ? { diskName: marker.diskName } : {}),
    };
  }

  /**
   * Delete the marked ephemeral workspace and every owned row atomically.
   * Called both during graceful shutdown and at the next startup after a crash.
   */
  removeEphemeralWorkspace(): EphemeralWorkspaceRecord | null {
    return this.transaction(() => {
      const markerRow = this.stmt("SELECT value FROM hub_preferences WHERE key = ?").get(
        EPHEMERAL_WORKSPACE_KEY
      );
      if (!markerRow) return null;
      const marker = parseEphemeralWorkspaceMarker(markerRow["value"]!);
      const workspaceRow = this.stmt(
        "SELECT * FROM workspaces WHERE workspace_id = ? AND name = ?"
      ).get(marker.workspaceId, marker.name);
      this.stmt("DELETE FROM membership WHERE workspace_id = ?").run(marker.workspaceId);
      this.stmt("DELETE FROM user_revocation_cleanup WHERE workspace_id = ?").run(
        marker.workspaceId
      );
      this.stmt("DELETE FROM workspaces WHERE workspace_id = ?").run(marker.workspaceId);
      this.stmt("DELETE FROM hub_preferences WHERE key = ?").run(EPHEMERAL_WORKSPACE_KEY);
      return workspaceRow
        ? {
            ...rowToWorkspace(workspaceRow),
            ...(marker.diskName ? { diskName: marker.diskName } : {}),
          }
        : null;
    });
  }

  /**
   * Remove every SQLite row owned by a workspace in one transaction.
   *
   * `membership` and `user_revocation_cleanup` intentionally do not carry a
   * foreign key to `workspaces`: identity rows can be read in workspace child
   * processes and revocation cleanup may outlive a running child. The hub must
   * therefore perform these cascades explicitly, in the same transaction as
   * the catalog deletion. `user_workspace_targets` is removed by its declared
   * `ON DELETE CASCADE` constraint.
   */
  removeWorkspace(name: string): string | null {
    return this.transaction(() => {
      const row = this.stmt("SELECT workspace_id FROM workspaces WHERE name = ?").get(name);
      if (!row) return null;
      const workspaceId = row["workspace_id"] as string;
      this.stmt("DELETE FROM membership WHERE workspace_id = ?").run(workspaceId);
      this.stmt("DELETE FROM user_revocation_cleanup WHERE workspace_id = ?").run(workspaceId);
      this.stmt("DELETE FROM workspaces WHERE name = ?").run(name);
      return workspaceId;
    });
  }

  getWorkspaceIdByName(name: string): string | null {
    const row = this.stmt("SELECT workspace_id FROM workspaces WHERE name = ?").get(name);
    return row ? (row["workspace_id"] as string) : null;
  }

  /** Touching is intentionally update-only: registration is always explicit. */
  touchWorkspace(name: string): void {
    this.stmt("UPDATE workspaces SET last_opened = ? WHERE name = ?").run(this.now(), name);
  }

  getWorkspaceEntry(name: string): WorkspaceEntry | null {
    const row = this.stmt("SELECT * FROM workspaces WHERE name = ?").get(name);
    return row ? rowToWorkspace(row) : null;
  }

  getLastOpenedWorkspace(): WorkspaceEntry | null {
    const row = this.stmt("SELECT * FROM workspaces ORDER BY last_opened DESC, name LIMIT 1").get();
    return row ? rowToWorkspace(row) : null;
  }

  setHubRuntime(record: HubRuntimeRecord): void {
    this.stmt(
      `INSERT INTO hub_runtime
         (singleton, gateway_port, pid, server_id, server_boot_id, started_at, version)
       VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         gateway_port = excluded.gateway_port,
         pid = excluded.pid,
         server_id = excluded.server_id,
         server_boot_id = excluded.server_boot_id,
         started_at = excluded.started_at,
         version = excluded.version`
    ).run(
      record.gatewayPort,
      record.pid,
      record.serverId,
      record.serverBootId,
      record.startedAt,
      record.version
    );
  }

  clearHubRuntime(): void {
    this.stmt("DELETE FROM hub_runtime WHERE singleton = 1").run();
  }

  getHubRuntime(): HubRuntimeRecord | null {
    const row = this.stmt("SELECT * FROM hub_runtime WHERE singleton = 1").get();
    return row ? rowToHubRuntime(row) : null;
  }

  /** Store the authenticated user's own resume target. */
  setLastWorkspaceForUser(userId: string, workspaceName: string): void {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) throw new Error("userId is required");
    const workspaceId = this.getWorkspaceIdByName(workspaceName);
    if (!workspaceId) throw new Error(`Unknown workspace: ${workspaceName}`);
    this.stmt(
      `INSERT INTO user_workspace_targets (user_id, workspace_id, last_opened)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         last_opened = excluded.last_opened`
    ).run(normalizedUserId, workspaceId, this.now());
  }

  getLastWorkspaceForUser(userId: string): WorkspaceEntry | null {
    const row = this.stmt(
      `SELECT w.* FROM user_workspace_targets t
       JOIN workspaces w ON w.workspace_id = t.workspace_id
       WHERE t.user_id = ?`
    ).get(userId);
    return row ? rowToWorkspace(row) : null;
  }

  getKeepServerOnQuit(): boolean | null {
    const row = this.stmt("SELECT value FROM hub_preferences WHERE key = ?").get(
      "keep_server_on_quit"
    );
    if (!row) return null;
    const value = row["value"];
    if (value !== "true" && value !== "false") {
      throw new Error(`Invalid keep_server_on_quit preference: ${String(value)}`);
    }
    return value === "true";
  }

  setKeepServerOnQuit(keep: boolean): void {
    this.stmt(
      `INSERT INTO hub_preferences (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run("keep_server_on_quit", keep ? "true" : "false");
  }

  private stmt(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
