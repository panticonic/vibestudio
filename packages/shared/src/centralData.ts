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
import { openCanonicalSqliteDatabase } from "@vibestudio/sqlite";
import { IDENTITY_DATABASE_MIGRATION_PLAN } from "@vibestudio/identity/identitySchema";

export interface CentralDataManagerOptions {
  databasePath?: string;
  now?: () => number;
}

/**
 * The fenced ownership record for the one hub allowed to mutate machine
 * control state. `ownerBootId` is a process-instance identity, not a PID: PIDs
 * are host-local and reusable, while this lease may live on shared storage.
 */
export interface HubProcessLeaseRecord {
  ownerBootId: string;
  gatewayPort: number;
  pid: number;
  acquiredAt: number;
  heartbeatAt: number;
  expiresAt: number;
}

export interface EphemeralWorkspaceRecord extends WorkspaceEntry {
  ownerBootId: string;
  diskName?: string;
}

export interface EphemeralWorkspaceCleanupRecord {
  cleanupId: string;
  diskName: string;
  sourceOwnerBootId: string;
  createdAt: number;
}

export interface EphemeralWorkspaceRemovalRecord {
  workspace: EphemeralWorkspaceRecord;
  cleanup: EphemeralWorkspaceCleanupRecord | null;
}

function mintWorkspaceId(): string {
  return `ws_${randomBytes(18).toString("base64url")}`;
}

function mintEphemeralCleanupId(): string {
  return `cleanup_${randomBytes(18).toString("base64url")}`;
}

const EPHEMERAL_WORKSPACE_KEY = "ephemeral_workspace";

function parseEphemeralWorkspaceMarker(value: SQLOutputValue): {
  workspaceId: string;
  name: string;
  ownerBootId: string;
  diskName?: string;
} {
  if (typeof value !== "string") throw new Error("Invalid ephemeral workspace marker type");
  const parsed = JSON.parse(value) as unknown;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (Object.keys(parsed).length !== 3 && Object.keys(parsed).length !== 4) ||
    typeof (parsed as { workspaceId?: unknown }).workspaceId !== "string" ||
    typeof (parsed as { name?: unknown }).name !== "string" ||
    typeof (parsed as { ownerBootId?: unknown }).ownerBootId !== "string" ||
    ((parsed as { diskName?: unknown }).diskName !== undefined &&
      (typeof (parsed as { diskName?: unknown }).diskName !== "string" ||
        !/^dev-[0-9a-f]{8}$/.test((parsed as { diskName: string }).diskName))) ||
    Object.keys(parsed).some(
      (key) => !["workspaceId", "name", "ownerBootId", "diskName"].includes(key)
    )
  ) {
    throw new Error("Invalid ephemeral workspace marker schema");
  }
  return parsed as {
    workspaceId: string;
    name: string;
    ownerBootId: string;
    diskName?: string;
  };
}

function rowToWorkspace(row: Record<string, SQLOutputValue>): WorkspaceEntry {
  return {
    workspaceId: row["workspace_id"] as string,
    name: row["name"] as string,
    lastOpened: row["last_opened"] as number,
  };
}

function rowToHubProcessLease(row: Record<string, SQLOutputValue>): HubProcessLeaseRecord {
  return {
    ownerBootId: row["owner_boot_id"] as string,
    gatewayPort: row["gateway_port"] as number,
    pid: row["pid"] as number,
    acquiredAt: row["acquired_at"] as number,
    heartbeatAt: row["heartbeat_at"] as number,
    expiresAt: row["expires_at"] as number,
  };
}

function rowToEphemeralWorkspaceCleanup(
  row: Record<string, SQLOutputValue>
): EphemeralWorkspaceCleanupRecord {
  return {
    cleanupId: row["cleanup_id"] as string,
    diskName: row["disk_name"] as string,
    sourceOwnerBootId: row["source_owner_boot_id"] as string,
    createdAt: row["created_at"] as number,
  };
}

/** Thin row-oriented wrapper around the hub control tables. */
export class CentralDataManager {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private readonly now: () => number;

  constructor(options: CentralDataManagerOptions = {}) {
    const databasePath =
      options.databasePath ?? path.join(getCentralDataPath(), "server-auth", "identity.db");
    this.now = options.now ?? Date.now;
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    try {
      openCanonicalSqliteDatabase(this.db, IDENTITY_DATABASE_MIGRATION_PLAN, {
        description: `hub-control schema in ${databasePath}`,
      });
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
  addEphemeralWorkspace(name: string, ownerBootId: string): EphemeralWorkspaceRecord {
    const normalized = name.trim();
    if (!normalized) throw new Error("Ephemeral workspace name is required");
    return this.transaction(() => {
      this.assertHubProcessLease(ownerBootId);
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
        JSON.stringify({ workspaceId, name: normalized, ownerBootId })
      );
      return { ...rowToWorkspace(row), ownerBootId };
    });
  }

  /**
   * Fence and rotate the random on-disk child name before spawn. The marker is
   * advanced atomically under the process lease and the predecessor becomes a
   * durable cleanup ticket, so no contender can mistake a live checkout for
   * its own crash residue.
   */
  rotateEphemeralWorkspaceDiskName(
    ownerBootId: string,
    workspaceId: string,
    diskName: string
  ): EphemeralWorkspaceCleanupRecord | null {
    if (!/^dev-[0-9a-f]{8}$/.test(diskName)) {
      throw new Error("Invalid ephemeral workspace disk name");
    }
    return this.transaction(() => {
      this.assertHubProcessLease(ownerBootId);
      const row = this.stmt("SELECT value FROM hub_preferences WHERE key = ?").get(
        EPHEMERAL_WORKSPACE_KEY
      );
      if (!row) throw new Error("No ephemeral workspace lifecycle is registered");
      const marker = parseEphemeralWorkspaceMarker(row["value"]!);
      if (marker.workspaceId !== workspaceId) {
        throw new Error("Ephemeral workspace marker does not match the running workspace");
      }
      if (marker.ownerBootId !== ownerBootId) {
        throw new Error("Ephemeral workspace marker is owned by another hub process lease");
      }
      this.stmt("UPDATE hub_preferences SET value = ? WHERE key = ?").run(
        JSON.stringify({ ...marker, diskName }),
        EPHEMERAL_WORKSPACE_KEY
      );
      return marker.diskName && marker.diskName !== diskName
        ? this.queueEphemeralWorkspaceCleanup(marker.diskName, marker.ownerBootId)
        : null;
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
      ownerBootId: marker.ownerBootId,
      lastOpened: workspace?.lastOpened ?? 0,
      ...(marker.diskName ? { diskName: marker.diskName } : {}),
    };
  }

  /**
   * Delete the marked ephemeral workspace and every owned row atomically.
   * Called both during graceful shutdown and at the next startup after a crash.
   */
  removeEphemeralWorkspace(
    leaseOwnerBootId: string,
    expectedWorkspaceOwnerBootId: string
  ): EphemeralWorkspaceRemovalRecord | null {
    return this.transaction(() => {
      this.assertHubProcessLease(leaseOwnerBootId);
      const markerRow = this.stmt("SELECT value FROM hub_preferences WHERE key = ?").get(
        EPHEMERAL_WORKSPACE_KEY
      );
      if (!markerRow) return null;
      const marker = parseEphemeralWorkspaceMarker(markerRow["value"]!);
      if (marker.ownerBootId !== expectedWorkspaceOwnerBootId) return null;
      const workspaceRow = this.stmt(
        "SELECT * FROM workspaces WHERE workspace_id = ? AND name = ?"
      ).get(marker.workspaceId, marker.name);
      const cleanup = marker.diskName
        ? this.queueEphemeralWorkspaceCleanup(marker.diskName, marker.ownerBootId)
        : null;
      this.stmt("DELETE FROM membership WHERE workspace_id = ?").run(marker.workspaceId);
      this.stmt("DELETE FROM user_revocation_cleanup WHERE workspace_id = ?").run(
        marker.workspaceId
      );
      this.stmt("DELETE FROM workspaces WHERE workspace_id = ?").run(marker.workspaceId);
      this.stmt("DELETE FROM hub_preferences WHERE key = ?").run(EPHEMERAL_WORKSPACE_KEY);
      return {
        workspace: {
          ...(workspaceRow
            ? rowToWorkspace(workspaceRow)
            : { workspaceId: marker.workspaceId, name: marker.name, lastOpened: 0 }),
          ownerBootId: marker.ownerBootId,
          ...(marker.diskName ? { diskName: marker.diskName } : {}),
        },
        cleanup,
      };
    });
  }

  listEphemeralWorkspaceCleanups(ownerBootId: string): EphemeralWorkspaceCleanupRecord[] {
    this.assertHubProcessLease(ownerBootId);
    return this.stmt("SELECT * FROM ephemeral_workspace_cleanup ORDER BY created_at, cleanup_id")
      .all()
      .map(rowToEphemeralWorkspaceCleanup);
  }

  assertEphemeralWorkspaceCleanup(
    ownerBootId: string,
    cleanup: EphemeralWorkspaceCleanupRecord
  ): void {
    this.assertHubProcessLease(ownerBootId);
    const row = this.stmt(
      `SELECT 1 AS one FROM ephemeral_workspace_cleanup
       WHERE cleanup_id = ? AND disk_name = ? AND source_owner_boot_id = ? AND created_at = ?`
    ).get(cleanup.cleanupId, cleanup.diskName, cleanup.sourceOwnerBootId, cleanup.createdAt);
    if (!row) throw new Error(`Unknown or stale ephemeral cleanup ticket ${cleanup.cleanupId}`);
  }

  completeEphemeralWorkspaceCleanup(
    ownerBootId: string,
    cleanup: EphemeralWorkspaceCleanupRecord
  ): boolean {
    this.assertHubProcessLease(ownerBootId);
    return (
      this.stmt(
        `DELETE FROM ephemeral_workspace_cleanup
         WHERE cleanup_id = ? AND disk_name = ? AND source_owner_boot_id = ? AND created_at = ?`
      ).run(cleanup.cleanupId, cleanup.diskName, cleanup.sourceOwnerBootId, cleanup.createdAt)
        .changes === 1
    );
  }

  /**
   * Acquire the singleton process lease, replacing it only after its durable
   * heartbeat has expired. The returned record is the fenced predecessor whose
   * subordinate ephemeral resources the new owner may recover.
   */
  claimHubProcessLease(input: {
    ownerBootId: string;
    gatewayPort: number;
    pid: number;
    ttlMs: number;
  }): HubProcessLeaseRecord | null {
    const ownerBootId = input.ownerBootId.trim();
    if (!ownerBootId) throw new Error("Hub process lease ownerBootId is required");
    if (
      !Number.isInteger(input.gatewayPort) ||
      input.gatewayPort < 1 ||
      input.gatewayPort > 65_535
    ) {
      throw new Error("Hub process lease gatewayPort is invalid");
    }
    if (!Number.isInteger(input.pid) || input.pid < 1) {
      throw new Error("Hub process lease pid is invalid");
    }
    if (!Number.isInteger(input.ttlMs) || input.ttlMs < 1) {
      throw new Error("Hub process lease ttlMs must be a positive integer");
    }
    return this.transaction(() => {
      const now = this.now();
      const row = this.stmt("SELECT * FROM hub_process_lease WHERE singleton = 1").get();
      const previous = row ? rowToHubProcessLease(row) : null;
      if (previous && previous.expiresAt > now) {
        throw new Error(
          `Hub process lease is owned by ${previous.ownerBootId} until ${previous.expiresAt}`
        );
      }
      this.stmt(
        `INSERT INTO hub_process_lease
           (singleton, owner_boot_id, gateway_port, pid, acquired_at, heartbeat_at, expires_at)
         VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           owner_boot_id = excluded.owner_boot_id,
           gateway_port = excluded.gateway_port,
           pid = excluded.pid,
           acquired_at = excluded.acquired_at,
           heartbeat_at = excluded.heartbeat_at,
           expires_at = excluded.expires_at`
      ).run(ownerBootId, input.gatewayPort, input.pid, now, now, now + input.ttlMs);
      return previous;
    });
  }

  /** Renew only the caller's still-live lease. A late or displaced owner is fenced. */
  renewHubProcessLease(ownerBootId: string, ttlMs: number): boolean {
    if (!Number.isInteger(ttlMs) || ttlMs < 1) {
      throw new Error("Hub process lease ttlMs must be a positive integer");
    }
    const now = this.now();
    const result = this.stmt(
      `UPDATE hub_process_lease
       SET heartbeat_at = ?, expires_at = ?
       WHERE singleton = 1 AND owner_boot_id = ? AND expires_at > ?`
    ).run(now, now + ttlMs, ownerBootId, now);
    return result.changes === 1;
  }

  /** Compare-and-release: a stale process can never clear its successor's lease. */
  releaseHubProcessLease(ownerBootId: string): boolean {
    return (
      this.stmt("DELETE FROM hub_process_lease WHERE singleton = 1 AND owner_boot_id = ?").run(
        ownerBootId
      ).changes === 1
    );
  }

  getHubProcessLease(): HubProcessLeaseRecord | null {
    const row = this.stmt("SELECT * FROM hub_process_lease WHERE singleton = 1").get();
    return row ? rowToHubProcessLease(row) : null;
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

  /** Fail closed unless this exact process instance owns the live control lease. */
  assertHubProcessLease(ownerBootId: string): void {
    const now = this.now();
    const row = this.stmt(
      `SELECT 1 AS one FROM hub_process_lease
       WHERE singleton = 1 AND owner_boot_id = ? AND expires_at > ?`
    ).get(ownerBootId, now);
    if (!row) {
      throw new Error(`Hub process ${ownerBootId} does not own the active machine-control lease`);
    }
  }

  private queueEphemeralWorkspaceCleanup(
    diskName: string,
    sourceOwnerBootId: string
  ): EphemeralWorkspaceCleanupRecord {
    const existing = this.stmt("SELECT * FROM ephemeral_workspace_cleanup WHERE disk_name = ?").get(
      diskName
    );
    if (existing) {
      const record = rowToEphemeralWorkspaceCleanup(existing);
      if (record.sourceOwnerBootId !== sourceOwnerBootId) {
        throw new Error(`Ephemeral cleanup disk ${diskName} has conflicting ownership`);
      }
      return record;
    }
    const record: EphemeralWorkspaceCleanupRecord = {
      cleanupId: mintEphemeralCleanupId(),
      diskName,
      sourceOwnerBootId,
      createdAt: this.now(),
    };
    this.stmt(
      `INSERT INTO ephemeral_workspace_cleanup
         (cleanup_id, disk_name, source_owner_boot_id, created_at)
       VALUES (?, ?, ?, ?)`
    ).run(record.cleanupId, record.diskName, record.sourceOwnerBootId, record.createdAt);
    return record;
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
