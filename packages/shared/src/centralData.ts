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
import { randomBytes, createHash } from "node:crypto";
import { canonicalJson } from "./canonicalJson.js";
import type { MembershipGovernanceRecord } from "./governance/types.js";
import { DatabaseSync, type SQLOutputValue, type StatementSync } from "node:sqlite";
import { getCentralDataPath } from "@vibestudio/env-paths";
import type { WorkspaceEntry } from "./types.js";
import type {
  WorkspaceCreationDescriptor,
  WorkspaceTemplatePin,
  WorkspaceCreationOwner,
  WorkspaceCreationReceipt,
} from "@vibestudio/workspace-contracts/types";
import { WorkspaceCreationDescriptorSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import { openCanonicalSqliteDatabase } from "@vibestudio/sqlite";
import {
  IDENTITY_DATABASE_MIGRATIONS,
  IDENTITY_DATABASE_SCHEMA,
} from "@vibestudio/identity/identitySchema";

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

export function createWorkspaceId(): string {
  return `ws_${randomBytes(18).toString("base64url")}`;
}

function rowToWorkspace(row: Record<string, SQLOutputValue>): WorkspaceEntry {
  return {
    workspaceId: row["workspace_id"] as string,
    name: row["name"] as string,
    ...(row["display_name"] ? { displayName: row["display_name"] as string } : {}),
    lastOpened: row["last_opened"] as number,
    ...(row["private_role"] ? { privateRole: row["private_role"] as "personal" | "system" } : {}),
  };
}

const WORKSPACE_ENTRY_SELECT = `SELECT w.*, p.role AS private_role
  FROM workspaces w
  LEFT JOIN user_workspaces p ON p.workspace_id = w.workspace_id`;

function parseWorkspaceCreationIntent(value: SQLOutputValue): WorkspaceCreationDescriptor | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("Invalid workspace creation intent type");
  return WorkspaceCreationDescriptorSchema.parse(JSON.parse(value));
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
      openCanonicalSqliteDatabase(this.db, IDENTITY_DATABASE_SCHEMA, {
        description: `hub-control schema in ${databasePath}`,
        migrations: IDENTITY_DATABASE_MIGRATIONS,
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
    return this.stmt(
      `${WORKSPACE_ENTRY_SELECT}
      ORDER BY w.last_opened DESC, w.name`
    )
      .all()
      .map(rowToWorkspace);
  }

  setWorkspaceDisplayName(workspaceId: string, displayName: string | null): WorkspaceEntry {
    const row = this.stmt(
      `UPDATE workspaces SET display_name = ? WHERE workspace_id = ? RETURNING *`
    ).get(displayName, workspaceId);
    if (!row) throw new Error(`Unknown workspace id "${workspaceId}"`);
    return rowToWorkspace(row);
  }

  /**
   * Reserve both private workspaces atomically. Existing designations win even
   * when their child is stopped or creation is incomplete; never replace state
   * in response to a startup failure. SQLite serializes competing clients.
   */
  ensurePrivateWorkspaces(
    userId: string,
    templates: Record<"personal" | "system", WorkspaceTemplatePin>
  ): Record<"personal" | "system", WorkspaceEntry> {
    return this.transaction(() => {
      const user = this.stmt("SELECT revoked_at FROM users WHERE id = ?").get(userId);
      if (!user || user["revoked_at"] !== null)
        throw new Error("Private workspace owner is not a live user");
      const ensure = (role: "personal" | "system"): WorkspaceEntry => {
        const existing = this.stmt(
          `SELECT w.*, p.role AS private_role FROM user_workspaces p
          JOIN workspaces w ON w.workspace_id = p.workspace_id
          WHERE p.user_id = ? AND p.role = ?`
        ).get(userId, role);
        if (existing) return rowToWorkspace(existing);
        const workspaceId = createWorkspaceId();
        const entry = this.addWorkspaceCreation(
          `${role}-${workspaceId}`,
          templates[role],
          workspaceId
        );
        this.stmt("INSERT INTO user_workspaces (user_id, role, workspace_id) VALUES (?, ?, ?)").run(
          userId,
          role,
          workspaceId
        );
        this.stmt(
          "INSERT INTO membership (user_id, workspace_id, added_by, added_at, role) VALUES (?, ?, ?, ?, 'admin')"
        ).run(userId, workspaceId, userId, this.now());
        return { ...entry, privateRole: role };
      };
      return { personal: ensure("personal"), system: ensure("system") };
    });
  }

  hasWorkspace(name: string): boolean {
    return this.stmt("SELECT 1 AS one FROM workspaces WHERE name = ?").get(name) !== undefined;
  }

  /** Reserve/register a name exactly once; re-registering preserves its opaque id. */
  addWorkspace(name: string, workspaceId = createWorkspaceId()): WorkspaceEntry {
    const normalized = name.trim();
    if (!normalized) throw new Error("Workspace name is required");
    const row = this.stmt(
      `INSERT INTO workspaces (workspace_id, name, last_opened)
       VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET last_opened = excluded.last_opened
       RETURNING *`
    ).get(workspaceId, normalized, this.now());
    if (!row) {
      throw new Error(`Workspace registration did not return a row: ${normalized}`);
    }
    return rowToWorkspace(row);
  }

  /** Register one not-yet-initialized workspace without creating its directory. */
  addWorkspaceCreation(
    name: string,
    rootTemplate: WorkspaceTemplatePin,
    workspaceId = createWorkspaceId(),
    purpose: "use" | "author" = "use"
  ): WorkspaceEntry {
    const normalized = name.trim();
    if (!normalized) throw new Error("Workspace name is required");
    const intent = WorkspaceCreationDescriptorSchema.parse({
      version: 1,
      workspaceId,
      rootTemplate,
      purpose,
    });
    const row = this.stmt(
      `INSERT INTO workspaces (workspace_id, name, last_opened, creation_intent_json)
       VALUES (?, ?, ?, ?) RETURNING *`
    ).get(workspaceId, normalized, this.now(), JSON.stringify(intent));
    if (!row) throw new Error(`Workspace creation registration returned no row: ${normalized}`);
    return rowToWorkspace(row);
  }

  /**
   * The hub's atomic creation boundary: registry, initial membership, durable
   * receipt, and its audit outbox commit together. No document/session is a
   * durable key, and no await can separate liveness validation from effects.
   */
  createWorkspaceOperation(
    owner: WorkspaceCreationOwner,
    input: {
      operationId: string;
      workspace: string;
      rootTemplate?: WorkspaceTemplatePin;
      purpose?: "use" | "author";
    },
    selectRoot: () => WorkspaceTemplatePin,
    assertLive: () => void
  ): WorkspaceCreationReceipt {
    const ownerKey = this.creationOwnerKey(owner);
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(input.operationId))
      throw new Error("Invalid workspace creation operation ID");
    const name = input.workspace.trim();
    if (!name) throw new Error("Workspace name is required");
    const request = canonicalJson({
      workspace: name,
      rootTemplate: input.rootTemplate ?? null,
      purpose: input.purpose ?? "use",
    });
    return this.transaction(() => {
      assertLive();
      const user = this.assertCreationOwnerActive(owner);
      const existing = this.stmt(
        "SELECT * FROM workspace_creation_operations WHERE owner_key = ? AND operation_id = ?"
      ).get(ownerKey, input.operationId);
      if (existing) {
        if (existing["request_json"] !== request)
          throw new Error("Workspace creation operation ID was already used with different inputs");
        return this.creationReceipt(existing);
      }
      const entry = this.addWorkspaceCreation(
        name,
        selectRoot(),
        createWorkspaceId(),
        input.purpose
      );
      const at = this.now();
      const operationId =
        "workspace-creation:" +
        createHash("sha256")
          .update(canonicalJson([ownerKey, input.operationId]))
          .digest("hex");
      const audit: MembershipGovernanceRecord = {
        kind: "membership",
        operationId,
        op: "add-member",
        actor: { userId: owner.userId, handle: user.handle },
        target: { userId: owner.userId, handle: user.handle },
        workspaceId: entry.workspaceId,
        at,
      };
      this.stmt(
        "INSERT INTO membership (user_id, workspace_id, added_by, added_at, role) VALUES (?, ?, ?, ?, 'admin')"
      ).run(owner.userId, entry.workspaceId, owner.userId, at);
      const row = this.stmt(
        `INSERT INTO workspace_creation_operations
        (owner_key, operation_id, request_json, workspace_id, workspace_name, state, audit_json, created_at)
        VALUES (?, ?, ?, ?, ?, 'registered', ?, ?) RETURNING *`
      ).get(
        ownerKey,
        input.operationId,
        request,
        entry.workspaceId,
        name,
        JSON.stringify(audit),
        at
      );
      if (!row) throw new Error("Workspace creation did not return its durable receipt");
      assertLive();
      return this.creationReceipt(row);
    });
  }

  /** Read-only reconciliation never reserves, initializes, or recreates a workspace. */
  workspaceCreationReceipt(
    owner: WorkspaceCreationOwner,
    operationId: string
  ): WorkspaceCreationReceipt | null {
    this.assertCreationOwnerActive(owner);
    const row = this.stmt(
      "SELECT * FROM workspace_creation_operations WHERE owner_key = ? AND operation_id = ?"
    ).get(this.creationOwnerKey(owner), operationId);
    return row ? this.creationReceipt(row) : null;
  }

  pendingWorkspaceCreationAudits(): MembershipGovernanceRecord[] {
    return this.stmt(
      "SELECT audit_json FROM workspace_creation_operations WHERE audit_delivered = 0 ORDER BY created_at"
    )
      .all()
      .map((row) => JSON.parse(String(row["audit_json"])) as MembershipGovernanceRecord);
  }

  acknowledgeWorkspaceCreationAudit(operationId: string): void {
    this.stmt(
      "UPDATE workspace_creation_operations SET audit_delivered = 1 WHERE json_extract(audit_json, '$.operationId') = ?"
    ).run(operationId);
  }

  private creationOwnerKey(owner: WorkspaceCreationOwner): string {
    if (!owner.userId || (owner.source && (!owner.source.workspaceId || !owner.source.subject)))
      throw new Error("Workspace creation requires an authenticated durable owner");
    return canonicalJson({ userId: owner.userId, source: owner.source ?? null });
  }

  private assertCreationOwnerActive(owner: WorkspaceCreationOwner): { handle: string } {
    const user = this.stmt("SELECT handle FROM users WHERE id = ? AND revoked_at IS NULL").get(
      owner.userId
    );
    if (!user) throw new Error("Workspace creation owner is unavailable");
    if (owner.source) {
      const membership = this.stmt(
        `SELECT 1 FROM workspaces w JOIN membership m ON m.workspace_id = w.workspace_id
        LEFT JOIN user_workspaces p ON p.workspace_id = w.workspace_id
        WHERE w.workspace_id = ? AND m.user_id = ? AND (p.user_id IS NULL OR p.user_id = ?)`
      ).get(owner.source.workspaceId, owner.userId, owner.userId);
      if (!membership) throw new Error("Workspace creation source membership is unavailable");
    }
    return { handle: String(user["handle"]) };
  }

  private creationReceipt(row: Record<string, SQLOutputValue>): WorkspaceCreationReceipt {
    return {
      operationId: String(row["operation_id"]),
      state: row["state"] as WorkspaceCreationReceipt["state"],
      workspaceId: String(row["workspace_id"]),
      name: String(row["workspace_name"]),
    };
  }

  getWorkspaceCreationIntent(name: string): WorkspaceCreationDescriptor | null {
    const row = this.stmt("SELECT creation_intent_json FROM workspaces WHERE name = ?").get(name);
    if (!row) throw new Error(`Unknown workspace \"${name}\"`);
    return parseWorkspaceCreationIntent(row["creation_intent_json"]!);
  }

  completeWorkspaceCreation(workspaceId: string): boolean {
    return this.transaction(() => {
      const completed =
        this.stmt(
          `UPDATE workspaces SET creation_intent_json = NULL
         WHERE workspace_id = ? AND creation_intent_json IS NOT NULL`
        ).run(workspaceId).changes === 1;
      if (completed)
        this.stmt(
          "UPDATE workspace_creation_operations SET state = 'ready' WHERE workspace_id = ? AND state = 'registered'"
        ).run(workspaceId);
      return completed;
    });
  }

  /**
   * Acquire the singleton process lease, replacing it only after its durable
   * heartbeat has expired. The returned record is the fenced predecessor.
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
      this.stmt(
        "UPDATE workspace_creation_operations SET state = 'deleted' WHERE workspace_id = ?"
      ).run(workspaceId);
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
    const row = this.stmt(`${WORKSPACE_ENTRY_SELECT} WHERE w.name = ?`).get(name);
    return row ? rowToWorkspace(row) : null;
  }

  getLastOpenedWorkspace(): WorkspaceEntry | null {
    const row = this.stmt(
      `${WORKSPACE_ENTRY_SELECT} ORDER BY w.last_opened DESC, w.name LIMIT 1`
    ).get();
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
      `SELECT w.*, p.role AS private_role FROM user_workspace_targets t
       JOIN workspaces w ON w.workspace_id = t.workspace_id
       LEFT JOIN user_workspaces p ON p.workspace_id = w.workspace_id
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
