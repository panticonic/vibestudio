/**
 * Hub-owned SQLite identity database (WP0 §2, §3.7).
 *
 * One `identity.db` file at the hub state dir (`<server-auth>/identity.db`)
 * holds users, devices, agent credentials, pairing codes, and workspace
 * membership. The HUB opens it read-write and is the SOLE writer; each
 * workspace CHILD opens the SAME file with `readOnly: true`, which is enforced
 * logically via `PRAGMA query_only = ON` — a flags-level read-only open would
 * break WAL shared-memory coordination across processes, whereas a normally
 * opened connection with `query_only` participates in WAL/shm like any reader
 * while rejecting every write statement. Same machine, same trusted OS user,
 * host↔host (plan §0.0): no RPC channel, no cache replication.
 *
 * This class is a THIN TYPED DATA LAYER. Business rules (handle validation,
 * root bootstrap, implicit-root membership, role gates) live in `UserStore` /
 * `MembershipStore` and the hub service layer.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync, type SQLOutputValue, type StatementSync } from "node:sqlite";
import type { User, UserRole } from "./types.js";
import {
  assertCanonicalSqliteSchema,
  initializeCanonicalSqliteSchema,
  isTrulyEmptySqliteDatabase,
} from "../sqliteSchema.js";
import { IDENTITY_DATABASE_SCHEMA } from "./identitySchema.js";

/** A device credential row. Mirrors `DeviceRecord` plus the owning `userId`. */
export interface DeviceRow {
  deviceId: string;
  refreshTokenHash: string;
  /** Owning user (FK to `users`). Required going forward (WP0 §3.2). */
  userId: string;
  label: string;
  platform?: string;
  createdAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
}

/** An entity-scoped agent credential row plus the spawning user (WP0 §3.3). */
export interface AgentCredentialRow {
  agentId: string;
  tokenHash: string;
  entityId: string;
  contextId: string;
  channelId: string;
  scopes?: string[];
  /** The user whose lineage spawned the agent; inherited into the subject. */
  userId: string;
  createdAt: number;
  expiresAt?: number;
  revokedAt?: number;
}

/** The two invite intents (WP0 §4) plus first-run root bootstrap. */
export type PairingCodeIntent = "root-bootstrap" | "invite-user" | "pair-device";

/**
 * A pending pairing code. `code` is whatever key the auth layer stores —
 * by convention the sha256 hash of the presentable code, mirroring
 * `DeviceAuthStore`; this layer does not hash.
 */
export interface PairingCodeRow {
  code: string;
  /** Bound user the redeemed device will belong to; absent for root bootstrap. */
  userId?: string;
  /** Workspace child that owns the invite's durable signaling route. */
  workspaceId: string;
  intent: PairingCodeIntent;
  createdAt: number;
  expiresAt: number;
}

/** A workspace membership row (WP0 §3.5). `workspaceId` is the opaque stable id. */
export interface WorkspaceMembership {
  userId: string;
  workspaceId: string;
  addedBy: string;
  addedAt: number;
}

export interface UserRevocationCleanupTask {
  userId: string;
  workspaceId: string;
  attempts: number;
  lastError?: string;
}

/**
 * The live account fields a child resolves for rendering (WP0 §3.7) —
 * presence, provenance, tree owners, rosters. Revoked users still resolve
 * (with `revokedAt` set) so historical attribution keeps rendering.
 */
export interface ResolvedUser {
  handle: string;
  displayName: string;
  color?: string;
  avatarBlob?: string;
  role: UserRole;
  revokedAt?: number;
}

export interface IdentityDbOptions {
  /** Path to `identity.db` (or `:memory:` in tests). */
  path: string;
  /** `false` = hub (sole writer, initializes the schema); `true` = workspace child. */
  readOnly: boolean;
  now?: () => number;
}

/** SQLite's default variable limit is 999; stay comfortably under it. */
const IN_CLAUSE_CHUNK = 400;

export class IdentityDb {
  readonly readOnly: boolean;
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private readonly now: () => number;

  constructor(options: IdentityDbOptions) {
    this.readOnly = options.readOnly;
    this.now = options.now ?? (() => Date.now());
    const inMemory = options.path === ":memory:";
    if (options.readOnly && !inMemory && !fs.existsSync(options.path)) {
      throw new Error(
        `Identity DB not found at ${options.path} — the hub creates it before spawning children (WP0 §2)`
      );
    }
    if (!options.readOnly && !inMemory) {
      fs.mkdirSync(path.dirname(options.path), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(options.path);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    try {
      if (options.readOnly) {
        // Logical read-only: the connection is opened normally (so it can join
        // the cross-process WAL shared-memory index) but every write statement
        // is rejected by SQLite itself. The child never issues writes.
        this.db.exec("PRAGMA query_only = ON");
      }
      if (isTrulyEmptySqliteDatabase(this.db)) {
        if (options.readOnly) {
          throw new Error(`Identity DB at ${options.path} is empty and cannot be initialized here`);
        }
        initializeCanonicalSqliteSchema(this.db, IDENTITY_DATABASE_SCHEMA);
      } else {
        assertCanonicalSqliteSchema(
          this.db,
          IDENTITY_DATABASE_SCHEMA,
          `identity schema in ${options.path}`
        );
      }
      if (!options.readOnly) {
        // WAL mutates the file header and is intentionally after validation.
        this.db.exec("PRAGMA journal_mode = WAL");
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  // ===========================================================================
  // Reads (hub AND children)
  // ===========================================================================

  hasUsers(): boolean {
    return this.stmt("SELECT 1 AS one FROM users LIMIT 1").get() !== undefined;
  }

  getUserRow(userId: string): User | null {
    const row = this.stmt("SELECT * FROM users WHERE id = ?").get(userId);
    return row ? rowToUser(row) : null;
  }

  getUserByHandle(handle: string): User | null {
    const row = this.stmt("SELECT * FROM users WHERE handle = ?").get(handle);
    return row ? rowToUser(row) : null;
  }

  listUsers(): User[] {
    return this.stmt("SELECT * FROM users ORDER BY created_at, id").all().map(rowToUser);
  }

  /**
   * Resolve arbitrary userIds to live account fields (WP0 §3.7). Unknown ids
   * are simply absent from the result; revoked users resolve with `revokedAt`.
   */
  resolveUsers(userIds: readonly string[]): Map<string, ResolvedUser> {
    const resolved = new Map<string, ResolvedUser>();
    for (const chunk of chunks([...new Set(userIds)], IN_CLAUSE_CHUNK)) {
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.db
        .prepare(`SELECT * FROM users WHERE id IN (${placeholders})`)
        .all(...chunk);
      for (const row of rows) {
        const user = rowToUser(row);
        resolved.set(user.id, {
          handle: user.handle,
          displayName: user.displayName,
          role: user.role,
          ...(user.color !== undefined ? { color: user.color } : {}),
          ...(user.avatarBlob !== undefined ? { avatarBlob: user.avatarBlob } : {}),
          ...(user.revokedAt !== undefined ? { revokedAt: user.revokedAt } : {}),
        });
      }
    }
    return resolved;
  }

  /** Resolve device ids to their human labels (provenance render, WP5 §5). */
  deviceLabels(deviceIds: readonly string[]): Map<string, string> {
    const labels = new Map<string, string>();
    for (const chunk of chunks([...new Set(deviceIds)], IN_CLAUSE_CHUNK)) {
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.db
        .prepare(`SELECT device_id, label FROM devices WHERE device_id IN (${placeholders})`)
        .all(...chunk);
      for (const row of rows) {
        labels.set(row["device_id"] as string, row["label"] as string);
      }
    }
    return labels;
  }

  getDevice(deviceId: string): DeviceRow | null {
    const row = this.stmt("SELECT * FROM devices WHERE device_id = ?").get(deviceId);
    return row ? rowToDevice(row) : null;
  }

  listDevices(): DeviceRow[] {
    return this.stmt("SELECT * FROM devices ORDER BY created_at, device_id").all().map(rowToDevice);
  }

  listDevicesForUser(userId: string): DeviceRow[] {
    return this.stmt("SELECT * FROM devices WHERE user_id = ? ORDER BY created_at, device_id")
      .all(userId)
      .map(rowToDevice);
  }

  /** The owning userId of a live (non-revoked) device, or null. */
  userForDevice(deviceId: string): string | null {
    const row = this.stmt(
      "SELECT user_id FROM devices WHERE device_id = ? AND revoked_at IS NULL"
    ).get(deviceId);
    return row ? (row["user_id"] as string) : null;
  }

  getAgentCredential(agentId: string): AgentCredentialRow | null {
    const row = this.stmt("SELECT * FROM agent_credentials WHERE agent_id = ?").get(agentId);
    return row ? rowToAgentCredential(row) : null;
  }

  getPairingCode(code: string): PairingCodeRow | null {
    const row = this.stmt("SELECT * FROM pairing_codes WHERE code = ?").get(code);
    return row ? rowToPairingCode(row) : null;
  }

  listPairingCodes(): PairingCodeRow[] {
    return this.stmt("SELECT * FROM pairing_codes ORDER BY created_at, code")
      .all()
      .map(rowToPairingCode);
  }

  listMembers(workspaceId: string): WorkspaceMembership[] {
    return this.stmt("SELECT * FROM membership WHERE workspace_id = ? ORDER BY added_at, user_id")
      .all(workspaceId)
      .map(rowToMembership);
  }

  /** Stored membership rows only — root's implicit membership is a store rule. */
  listWorkspacesForUser(userId: string): string[] {
    return this.stmt("SELECT workspace_id FROM membership WHERE user_id = ? ORDER BY added_at")
      .all(userId)
      .map((row) => row["workspace_id"] as string);
  }

  /** Row-existence only; the implicit-root rule lives in `MembershipStore.has`. */
  isMember(userId: string, workspaceId: string): boolean {
    return (
      this.stmt("SELECT 1 AS one FROM membership WHERE user_id = ? AND workspace_id = ?").get(
        userId,
        workspaceId
      ) !== undefined
    );
  }

  // ===========================================================================
  // Writes (hub only — the sole writer; throw on a read-only handle)
  // ===========================================================================

  insertUser(user: User): void {
    this.assertWritable();
    this.stmt(
      `INSERT INTO users (id, handle, display_name, role, avatar_blob, color, created_at, created_by, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      user.id,
      user.handle,
      user.displayName,
      user.role,
      user.avatarBlob ?? null,
      user.color ?? null,
      user.createdAt,
      user.createdBy ?? null,
      user.revokedAt ?? null
    );
  }

  /**
   * Patch mutable personalization fields. A key that is PRESENT with value
   * `undefined` clears the column; an absent key leaves it untouched.
   * Returns whether the user row existed.
   */
  updateUserProfile(
    userId: string,
    patch: Partial<Pick<User, "handle" | "displayName" | "avatarBlob" | "color">>
  ): boolean {
    this.assertWritable();
    const sets: string[] = [];
    const params: (string | null)[] = [];
    if ("handle" in patch && patch.handle !== undefined) {
      sets.push("handle = ?");
      params.push(patch.handle);
    }
    if ("displayName" in patch && patch.displayName !== undefined) {
      sets.push("display_name = ?");
      params.push(patch.displayName);
    }
    if ("avatarBlob" in patch) {
      sets.push("avatar_blob = ?");
      params.push(patch.avatarBlob ?? null);
    }
    if ("color" in patch) {
      sets.push("color = ?");
      params.push(patch.color ?? null);
    }
    if (sets.length === 0) return this.getUserRow(userId) !== null;
    const result = this.db
      .prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params, userId);
    return result.changes > 0;
  }

  setUserRole(userId: string, role: UserRole): boolean {
    this.assertWritable();
    return this.stmt("UPDATE users SET role = ? WHERE id = ?").run(role, userId).changes > 0;
  }

  /**
   * Revoke a user and cascade in one transaction: revoke their devices and
   * agent credentials, delete their membership rows and pending pairing codes
   * (WP0 §3.1). Returns false when the user is unknown or already revoked.
   */
  revokeUser(
    userId: string,
    revokedAt = this.now(),
    workspaceIds: readonly string[] = []
  ): boolean {
    this.assertWritable();
    return this.transaction(() => {
      const changed = this.stmt(
        "UPDATE users SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL"
      ).run(revokedAt, userId).changes;
      if (changed === 0) return false;
      this.stmt("UPDATE devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(
        revokedAt,
        userId
      );
      this.stmt(
        "DELETE FROM pairing_receipts WHERE device_id IN (SELECT device_id FROM devices WHERE user_id = ?)"
      ).run(userId);
      this.stmt(
        "UPDATE agent_credentials SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL"
      ).run(revokedAt, userId);
      this.stmt("DELETE FROM membership WHERE user_id = ?").run(userId);
      this.stmt("DELETE FROM pairing_codes WHERE user_id = ?").run(userId);
      for (const workspaceId of new Set(workspaceIds)) {
        this.stmt(
          `INSERT INTO user_revocation_cleanup (user_id, workspace_id)
           VALUES (?, ?)
           ON CONFLICT(user_id, workspace_id) DO NOTHING`
        ).run(userId, workspaceId);
      }
      return true;
    });
  }

  listUserRevocationCleanup(userId?: string): UserRevocationCleanupTask[] {
    const rows = userId
      ? this.stmt(
          `SELECT user_id, workspace_id, attempts, last_error
           FROM user_revocation_cleanup WHERE user_id = ? ORDER BY workspace_id`
        ).all(userId)
      : this.stmt(
          `SELECT user_id, workspace_id, attempts, last_error
           FROM user_revocation_cleanup ORDER BY user_id, workspace_id`
        ).all();
    return rows.map((row) => ({
      userId: row["user_id"] as string,
      workspaceId: row["workspace_id"] as string,
      attempts: row["attempts"] as number,
      ...(typeof row["last_error"] === "string" ? { lastError: row["last_error"] } : {}),
    }));
  }

  failUserRevocationCleanup(userId: string, workspaceId: string, error: string): void {
    this.assertWritable();
    this.stmt(
      `UPDATE user_revocation_cleanup
       SET attempts = attempts + 1, last_error = ?
       WHERE user_id = ? AND workspace_id = ?`
    ).run(error, userId, workspaceId);
  }

  completeUserRevocationCleanup(userId: string, workspaceId: string): boolean {
    this.assertWritable();
    return (
      this.stmt("DELETE FROM user_revocation_cleanup WHERE user_id = ? AND workspace_id = ?").run(
        userId,
        workspaceId
      ).changes > 0
    );
  }

  /**
   * Roll back an invite that was never exposed to a caller. This is deliberately
   * narrower than user deletion: root, activated users, and agent-owning users
   * are rejected. It exists only to make invite + ephemeral-route creation
   * atomic at the hub boundary.
   */
  deleteUnactivatedInvite(userId: string): boolean {
    this.assertWritable();
    return this.transaction(() => {
      const user = this.stmt("SELECT role, created_by FROM users WHERE id = ?").get(userId);
      if (!user) return false;
      if (user["role"] === "root" || user["created_by"] == null) {
        throw new Error("Only an invited, unactivated user may be rolled back");
      }
      const hasCredentials =
        this.stmt("SELECT 1 AS one FROM devices WHERE user_id = ? LIMIT 1").get(userId) !==
          undefined ||
        this.stmt("SELECT 1 AS one FROM agent_credentials WHERE user_id = ? LIMIT 1").get(
          userId
        ) !== undefined;
      if (hasCredentials) {
        throw new Error("An activated user cannot be rolled back");
      }
      this.stmt("DELETE FROM pairing_codes WHERE user_id = ?").run(userId);
      this.stmt("DELETE FROM membership WHERE user_id = ?").run(userId);
      return this.stmt("DELETE FROM users WHERE id = ?").run(userId).changes > 0;
    });
  }

  /** Insert or replace a device credential (`created_at` is kept on conflict). */
  upsertDevice(device: DeviceRow): void {
    this.assertWritable();
    this.stmt(
      `INSERT INTO devices (device_id, refresh_token_hash, user_id, label, platform, created_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET
         refresh_token_hash = excluded.refresh_token_hash,
         user_id = excluded.user_id,
         label = excluded.label,
         platform = excluded.platform,
         last_used_at = excluded.last_used_at,
         revoked_at = excluded.revoked_at`
    ).run(
      device.deviceId,
      device.refreshTokenHash,
      device.userId,
      device.label,
      device.platform ?? null,
      device.createdAt,
      device.lastUsedAt ?? null,
      device.revokedAt ?? null
    );
  }

  /** Stamp `last_used_at` on a live device (refresh validation path). */
  touchDevice(deviceId: string, lastUsedAt = this.now()): boolean {
    this.assertWritable();
    return (
      this.stmt(
        "UPDATE devices SET last_used_at = ? WHERE device_id = ? AND revoked_at IS NULL"
      ).run(lastUsedAt, deviceId).changes > 0
    );
  }

  /** Revoke a device, returning the revoked row or null when already inactive. */
  revokeDevice(deviceId: string, revokedAt = this.now()): DeviceRow | null {
    this.assertWritable();
    const changed = this.stmt(
      "UPDATE devices SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL"
    ).run(revokedAt, deviceId).changes;
    if (changed > 0) {
      this.stmt("DELETE FROM pairing_receipts WHERE device_id = ?").run(deviceId);
    }
    return changed > 0 ? this.getDevice(deviceId) : null;
  }

  /** Revoke every live device of a user; returns the revoked rows. */
  revokeDevicesForUser(userId: string, revokedAt = this.now()): DeviceRow[] {
    this.assertWritable();
    return this.transaction(() => {
      const live = this.stmt(
        "SELECT device_id FROM devices WHERE user_id = ? AND revoked_at IS NULL"
      )
        .all(userId)
        .map((row) => row["device_id"] as string);
      this.stmt("UPDATE devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(
        revokedAt,
        userId
      );
      this.stmt(
        "DELETE FROM pairing_receipts WHERE device_id IN (SELECT device_id FROM devices WHERE user_id = ?)"
      ).run(userId);
      return live
        .map((deviceId) => this.getDevice(deviceId))
        .filter((device): device is DeviceRow => device !== null);
    });
  }

  insertAgentCredential(credential: AgentCredentialRow): void {
    this.assertWritable();
    this.stmt(
      `INSERT INTO agent_credentials (agent_id, token_hash, entity_id, context_id, channel_id, scopes, user_id, created_at, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      credential.agentId,
      credential.tokenHash,
      credential.entityId,
      credential.contextId,
      credential.channelId,
      credential.scopes ? JSON.stringify(credential.scopes) : null,
      credential.userId,
      credential.createdAt,
      credential.expiresAt ?? null,
      credential.revokedAt ?? null
    );
  }

  revokeAgentCredential(agentId: string, revokedAt = this.now()): boolean {
    this.assertWritable();
    return (
      this.stmt(
        "UPDATE agent_credentials SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL"
      ).run(revokedAt, agentId).changes > 0
    );
  }

  /** Revoke every live credential of an entity; returns the revoked agent ids. */
  revokeAgentCredentialsForEntity(entityId: string, revokedAt = this.now()): string[] {
    this.assertWritable();
    return this.transaction(() => {
      const live = this.stmt(
        "SELECT agent_id FROM agent_credentials WHERE entity_id = ? AND revoked_at IS NULL"
      )
        .all(entityId)
        .map((row) => row["agent_id"] as string);
      this.stmt(
        "UPDATE agent_credentials SET revoked_at = ? WHERE entity_id = ? AND revoked_at IS NULL"
      ).run(revokedAt, entityId);
      return live;
    });
  }

  insertPairingCode(code: PairingCodeRow): void {
    this.assertWritable();
    this.stmt(
      `INSERT INTO pairing_codes (code, user_id, workspace_id, intent, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      code.code,
      code.userId ?? null,
      code.workspaceId,
      code.intent,
      code.createdAt,
      code.expiresAt
    );
  }

  /**
   * Consume a live pairing code and issue its device in one SQLite transaction.
   * Root bootstrap creation runs inside that same transaction, so a failed
   * user/device insert leaves the code available and no orphan account behind.
   */
  completePairing(input: {
    code: string;
    expectedWorkspaceId?: string;
    createRootUser?: () => string;
    createDevice: (userId: string) => DeviceRow;
  }): { device: DeviceRow; expiresAt: number; replayed: boolean } | null {
    this.assertWritable();
    return this.transaction(() => {
      const row = this.stmt("SELECT * FROM pairing_codes WHERE code = ?").get(input.code);
      if (!row) {
        const receipt = this.stmt(
          "SELECT device_id, workspace_id, expires_at FROM pairing_receipts WHERE code = ?"
        ).get(input.code);
        if (!receipt) return null;
        const expiresAt = receipt["expires_at"] as number;
        if (expiresAt <= this.now()) {
          this.stmt("DELETE FROM pairing_receipts WHERE code = ?").run(input.code);
          return null;
        }
        const workspaceId = receipt["workspace_id"] as string;
        if (input.expectedWorkspaceId && input.expectedWorkspaceId !== workspaceId) return null;
        const existing = this.getDevice(receipt["device_id"] as string);
        if (!existing || existing.revokedAt !== undefined) return null;
        const proposed = input.createDevice(existing.userId);
        if (
          proposed.deviceId !== existing.deviceId ||
          proposed.refreshTokenHash !== existing.refreshTokenHash
        ) {
          return null;
        }
        return { device: existing, expiresAt, replayed: true };
      }
      const record = rowToPairingCode(row);
      if (record.expiresAt <= this.now()) {
        this.stmt("DELETE FROM pairing_codes WHERE code = ?").run(input.code);
        return null;
      }
      if (input.expectedWorkspaceId && input.expectedWorkspaceId !== record.workspaceId) {
        return null;
      }
      let userId = record.userId;
      if (!userId && record.intent === "root-bootstrap") {
        userId = input.createRootUser?.();
      }
      if (!userId) {
        throw new Error("Pairing code is not bound to a user");
      }
      const device = input.createDevice(userId);
      this.upsertDevice(device);
      this.stmt(
        `INSERT INTO pairing_receipts (code, device_id, workspace_id, expires_at)
         VALUES (?, ?, ?, ?)`
      ).run(input.code, device.deviceId, record.workspaceId, record.expiresAt);
      this.stmt("DELETE FROM pairing_codes WHERE code = ?").run(input.code);
      return { device, expiresAt: record.expiresAt, replayed: false };
    });
  }

  deleteExpiredPairingReceipts(now = this.now()): number {
    this.assertWritable();
    return Number(this.stmt("DELETE FROM pairing_receipts WHERE expires_at <= ?").run(now).changes);
  }

  /** Delete an unredeemed code (proactive expiry timers). */
  deletePairingCode(code: string): boolean {
    this.assertWritable();
    return this.stmt("DELETE FROM pairing_codes WHERE code = ?").run(code).changes > 0;
  }

  /** Idempotent upsert on `(user_id, workspace_id)`; refreshes addedBy/addedAt. */
  addMembership(membership: WorkspaceMembership): void {
    this.assertWritable();
    this.stmt(
      `INSERT INTO membership (user_id, workspace_id, added_by, added_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, workspace_id) DO UPDATE SET
         added_by = excluded.added_by,
         added_at = excluded.added_at`
    ).run(membership.userId, membership.workspaceId, membership.addedBy, membership.addedAt);
  }

  removeMembership(userId: string, workspaceId: string): boolean {
    this.assertWritable();
    return (
      this.stmt("DELETE FROM membership WHERE user_id = ? AND workspace_id = ?").run(
        userId,
        workspaceId
      ).changes > 0
    );
  }

  removeMembershipsForWorkspace(workspaceId: string): number {
    this.assertWritable();
    return Number(
      this.stmt("DELETE FROM membership WHERE workspace_id = ?").run(workspaceId).changes
    );
  }

  removeMembershipsForUser(userId: string): number {
    this.assertWritable();
    return Number(this.stmt("DELETE FROM membership WHERE user_id = ?").run(userId).changes);
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  private assertWritable(): void {
    if (this.readOnly) {
      throw new Error(
        "IdentityDb is read-only in this process — the hub is the sole identity writer (WP0 §2)"
      );
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

  private stmt(sql: string): StatementSync {
    let prepared = this.statements.get(sql);
    if (!prepared) {
      prepared = this.db.prepare(sql);
      this.statements.set(sql, prepared);
    }
    return prepared;
  }
}

type Row = Record<string, SQLOutputValue>;

function rowToUser(row: Row): User {
  return {
    id: row["id"] as string,
    handle: row["handle"] as string,
    displayName: row["display_name"] as string,
    role: row["role"] as UserRole,
    createdAt: row["created_at"] as number,
    ...(row["avatar_blob"] != null ? { avatarBlob: row["avatar_blob"] as string } : {}),
    ...(row["color"] != null ? { color: row["color"] as string } : {}),
    ...(row["created_by"] != null ? { createdBy: row["created_by"] as string } : {}),
    ...(row["revoked_at"] != null ? { revokedAt: row["revoked_at"] as number } : {}),
  };
}

function rowToDevice(row: Row): DeviceRow {
  return {
    deviceId: row["device_id"] as string,
    refreshTokenHash: row["refresh_token_hash"] as string,
    userId: row["user_id"] as string,
    label: row["label"] as string,
    createdAt: row["created_at"] as number,
    ...(row["platform"] != null ? { platform: row["platform"] as string } : {}),
    ...(row["last_used_at"] != null ? { lastUsedAt: row["last_used_at"] as number } : {}),
    ...(row["revoked_at"] != null ? { revokedAt: row["revoked_at"] as number } : {}),
  };
}

function rowToAgentCredential(row: Row): AgentCredentialRow {
  return {
    agentId: row["agent_id"] as string,
    tokenHash: row["token_hash"] as string,
    entityId: row["entity_id"] as string,
    contextId: row["context_id"] as string,
    channelId: row["channel_id"] as string,
    userId: row["user_id"] as string,
    createdAt: row["created_at"] as number,
    ...(row["scopes"] != null ? { scopes: JSON.parse(row["scopes"] as string) as string[] } : {}),
    ...(row["expires_at"] != null ? { expiresAt: row["expires_at"] as number } : {}),
    ...(row["revoked_at"] != null ? { revokedAt: row["revoked_at"] as number } : {}),
  };
}

function rowToPairingCode(row: Row): PairingCodeRow {
  return {
    code: row["code"] as string,
    workspaceId: row["workspace_id"] as string,
    intent: row["intent"] as PairingCodeIntent,
    createdAt: row["created_at"] as number,
    expiresAt: row["expires_at"] as number,
    ...(row["user_id"] != null ? { userId: row["user_id"] as string } : {}),
  };
}

function rowToMembership(row: Row): WorkspaceMembership {
  return {
    userId: row["user_id"] as string,
    workspaceId: row["workspace_id"] as string,
    addedBy: row["added_by"] as string,
    addedAt: row["added_at"] as number,
  };
}

function* chunks<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let index = 0; index < items.length; index += size) {
    yield items.slice(index, index + size);
  }
}
