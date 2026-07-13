import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { constantTimeStringEqual } from "@vibestudio/shared/tokenManager";
import {
  DEVICE_ID_PATTERN,
  DEVICE_REFRESH_TOKEN_PATTERN,
  SERVER_ID_PATTERN,
} from "@vibestudio/shared/deviceCredentials";
import type {
  AgentCredentialRow,
  DeviceRow,
  IdentityDb,
  PairingCodeIntent,
} from "@vibestudio/identity/identityDb";
import { writeJsonFileAtomic } from "./atomicFile.js";
import { authError } from "./auth/errors.js";

/**
 * A device credential — a device belongs to a user (WP0 §3.2). Alias of the
 * identity DB's `DeviceRow` so the store and the data layer can never drift.
 */
export type DeviceRecord = DeviceRow;

/**
 * An entity-scoped agent credential plus the spawning user (WP0 §3.3).
 * Authenticates as caller kind `agent`, principal `agent:<entityId>`. Only the
 * sha256 hash of the secret is persisted (mirrors device refresh tokens); the
 * clear token exists only at mint time. Lifecycle follows the entity —
 * `retireEntity` revokes every outstanding credential for it.
 */
export type AgentCredentialRecord = AgentCredentialRow;

/** Exact agent credential grammar emitted by this pre-release server. */
export const AGENT_ID_PATTERN = /^agt_[A-Za-z0-9_-]{24}$/;
export const AGENT_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const AGENT_TOKEN_PATTERN = /^agent:agt_[A-Za-z0-9_-]{24}:[A-Za-z0-9_-]{43}$/;

/** The validated binding an agent credential authorizes (no secret material). */
export interface AgentBinding {
  agentId: string;
  entityId: string;
  contextId: string;
  channelId: string;
  scopes?: string[];
  /** The user whose lineage spawned the agent (WP0 §3.3) — subject inheritance. */
  userId: string;
}

export interface IssuedAgentCredential {
  agentId: string;
  /** Full presentable token: `agent:<agentId>:<secret>`. */
  agentToken: string;
}

export const DEFAULT_PAIRING_CODE_TTL_MS = 60 * 60 * 1000;

/**
 * Minimum advance in a device's `lastUsedAt` before validateRefresh persists it
 * again. Bounds store rewrites for a reconnecting device to ~once/minute while
 * keeping last-seen resolution useful.
 */
const LAST_USED_PERSIST_INTERVAL_MS = 60 * 1000;

export interface IssuedDeviceCredential {
  deviceId: string;
  refreshToken: string;
  /** Owning user of the issued device (WP0 §3.2). */
  userId: string;
  label: string;
  platform?: string;
}

export interface DeviceAuthStoreOptions {
  /**
   * Shared hub-owned identity DB (WP0 §2). Read-write at the hub — the sole
   * writer — and read-only (`PRAGMA query_only`) in workspace children, which
   * only validate credentials and resolve device→user.
   */
  db: IdentityDb;
  /**
   * Small JSON file persisting the stable server id (`srv_<rand>`), a sibling
   * of `identity.db`. The hub creates it on first run; a read-only (child)
   * store requires it to exist.
   */
  serverIdPath: string;
  now?: () => number;
}

export class DeviceAuthStore {
  private readonly db: IdentityDb;
  private readonly serverId: string;
  private readonly now: () => number;

  constructor(options: DeviceAuthStoreOptions) {
    this.db = options.db;
    this.now = options.now ?? (() => Date.now());
    this.serverId = this.loadServerId(options.serverIdPath);
    if (!this.db.readOnly) this.db.deleteExpiredPairingReceipts(this.now());
  }

  getServerId(): string {
    return this.serverId;
  }

  createPairingCode(
    ttlMs = DEFAULT_PAIRING_CODE_TTL_MS,
    opts: { workspaceId: string; userId?: string; intent?: PairingCodeIntent }
  ): string {
    const code = randomBase64Url(24);
    const codeHash = hashSecret(code);
    const createdAt = this.now();
    this.db.insertPairingCode({
      code: codeHash,
      workspaceId: opts.workspaceId,
      intent: opts?.intent ?? "pair-device",
      createdAt,
      expiresAt: createdAt + ttlMs,
      ...(opts?.userId ? { userId: opts.userId } : {}),
    });
    return code;
  }

  pairingCodeExpiresAt(code: string): number {
    const row = this.db.getPairingCode(hashSecret(code));
    if (!row || row.expiresAt <= this.now()) {
      throw authError("PAIRING_CODE_INVALID_OR_EXPIRED", "Pairing code is invalid or expired", 401);
    }
    return row.expiresAt;
  }

  /** Cancel a code that was never returned because reach setup failed. */
  cancelPairingCode(code: string): boolean {
    const codeHash = hashSecret(code);
    return this.db.deletePairingCode(codeHash);
  }

  completePairing(input: {
    code: string;
    /** Invoked only after a valid, unbound root-bootstrap code is consumed. */
    createRootUser?: () => string;
    label?: string;
    platform?: string;
    expectedWorkspaceId?: string;
    proposedCredential?: { deviceId: string; refreshToken: string };
  }): IssuedDeviceCredential {
    if (
      input.proposedCredential &&
      (!DEVICE_ID_PATTERN.test(input.proposedCredential.deviceId) ||
        !DEVICE_REFRESH_TOKEN_PATTERN.test(input.proposedCredential.refreshToken))
    ) {
      throw authError("PAIRING_CREDENTIAL_INVALID", "Proposed device credential is invalid", 400);
    }
    const codeHash = hashSecret(input.code);
    const deviceId = input.proposedCredential?.deviceId ?? `dev_${randomBase64Url(18)}`;
    const refreshToken = input.proposedCredential?.refreshToken ?? randomBase64Url(32);
    let completed: ReturnType<IdentityDb["completePairing"]>;
    try {
      completed = this.db.completePairing({
        code: codeHash,
        expectedWorkspaceId: input.expectedWorkspaceId,
        createRootUser: input.createRootUser,
        createDevice: (userId) => ({
          deviceId,
          refreshTokenHash: hashSecret(refreshToken),
          userId,
          label: input.label ?? "Vibestudio client",
          createdAt: this.now(),
          ...(input.platform ? { platform: input.platform } : {}),
        }),
      });
    } catch (error) {
      if (error instanceof Error && error.message === "Pairing code is not bound to a user") {
        throw authError("PAIRING_CODE_UNBOUND", error.message, 401);
      }
      throw error;
    }
    if (!completed) {
      throw authError("PAIRING_CODE_INVALID_OR_EXPIRED", "Pairing code is invalid or expired", 401);
    }
    return {
      deviceId: completed.device.deviceId,
      refreshToken,
      userId: completed.device.userId,
      label: completed.device.label,
      ...(completed.device.platform ? { platform: completed.device.platform } : {}),
    };
  }

  issueDevice(input: { userId: string; label: string; platform?: string }): IssuedDeviceCredential {
    const deviceId = `dev_${randomBase64Url(18)}`;
    const refreshToken = randomBase64Url(32);
    const record: DeviceRecord = {
      deviceId,
      refreshTokenHash: hashSecret(refreshToken),
      userId: input.userId,
      label: input.label,
      createdAt: this.now(),
      ...(input.platform ? { platform: input.platform } : {}),
    };
    this.db.upsertDevice(record);
    return {
      deviceId,
      refreshToken,
      userId: input.userId,
      label: record.label,
      platform: input.platform,
    };
  }

  validateRefresh(deviceId: string, refreshToken: string): DeviceRecord {
    const record = this.db.getDevice(deviceId);
    if (!record || record.revokedAt) {
      throw authError("DEVICE_NOT_PAIRED", "Device is not paired", 401);
    }
    const presentedHash = hashSecret(refreshToken);
    if (!constantTimeStringEqual(presentedHash, record.refreshTokenHash)) {
      throw authError("INVALID_REFRESH_CREDENTIAL", "Invalid refresh credential", 401);
    }
    // Children validate against the shared identity DB read-only (WP0 §5.1);
    // only the hub — the sole writer — stamps last-used.
    const lastUsedAt = this.now();
    if (
      !this.db.readOnly &&
      (record.lastUsedAt === undefined ||
        lastUsedAt - record.lastUsedAt >= LAST_USED_PERSIST_INTERVAL_MS)
    ) {
      this.db.touchDevice(deviceId, lastUsedAt);
    }
    return { ...record, lastUsedAt };
  }

  /** The owning userId of a live (non-revoked) device — device→user FK (WP0 §5.2). */
  userFor(deviceId: string): string | null {
    return this.db.userForDevice(deviceId);
  }

  revokeDevice(deviceId: string): boolean {
    return this.db.revokeDevice(deviceId, this.now()) !== null;
  }

  listDevices(): DeviceRecord[] {
    return this.db.listDevices();
  }

  /** Whether durable pairing state has ever been created for this workspace hub. */
  hasEverPaired(): boolean {
    return this.db.listDevices().length > 0;
  }

  // ===========================================================================
  // Agent credentials (entity-scoped; §3.2)
  // ===========================================================================

  /**
   * Mint an entity-scoped agent credential. `agentId` is `agt_<rand>`; the
   * secret is a fresh 32-byte base64url token stored only as a sha256 hash
   * (mirrors `issueDevice`). `userId` is the spawner's — resolved from the
   * caller that requested the spawn (WP0 §3.3) — so the agent inherits its
   * human's subject. Returns the full presentable token `agent:<agentId>:<secret>`.
   */
  mintAgentCredential(input: {
    entityId: string;
    contextId: string;
    channelId: string;
    userId: string;
    ttlMs?: number;
    scopes?: string[];
  }): IssuedAgentCredential {
    const agentId = `agt_${randomBase64Url(18)}`;
    const secret = randomBase64Url(32);
    const record: AgentCredentialRecord = {
      agentId,
      tokenHash: hashSecret(secret),
      entityId: input.entityId,
      contextId: input.contextId,
      channelId: input.channelId,
      userId: input.userId,
      createdAt: this.now(),
      ...(input.ttlMs ? { expiresAt: this.now() + input.ttlMs } : {}),
      ...(input.scopes ? { scopes: input.scopes } : {}),
    };
    this.db.insertAgentCredential(record);
    return { agentId, agentToken: `agent:${agentId}:${secret}` };
  }

  /**
   * Validate a presented agent secret against a stored credential. Returns the
   * authorized binding (no secret material) or null when unknown, revoked,
   * expired, or the secret mismatches (constant-time compare).
   */
  validateAgentToken(agentId: string, token: string): AgentBinding | null {
    const record = this.db.getAgentCredential(agentId);
    if (!record || record.revokedAt) return null;
    if (record.expiresAt !== undefined && record.expiresAt < this.now()) return null;
    const presentedHash = hashSecret(token);
    if (!constantTimeStringEqual(presentedHash, record.tokenHash)) return null;
    return {
      agentId: record.agentId,
      entityId: record.entityId,
      contextId: record.contextId,
      channelId: record.channelId,
      userId: record.userId,
      ...(record.scopes ? { scopes: record.scopes } : {}),
    };
  }

  /** Revoke a single agent credential by id. Returns whether it was live. */
  revokeAgentCredential(agentId: string): boolean {
    return this.db.revokeAgentCredential(agentId, this.now());
  }

  getAgentCredential(agentId: string): AgentCredentialRecord | null {
    return this.db.getAgentCredential(agentId);
  }

  /**
   * Revoke every outstanding agent credential bound to an entity. Called by
   * `retireEntity` so credentials never outlive their entity. Returns the ids
   * revoked so the caller can also drop live TokenManager tokens.
   */
  revokeAgentCredentialsForEntity(entityId: string): string[] {
    return this.db.revokeAgentCredentialsForEntity(entityId, this.now());
  }

  /**
   * Stable server identity, persisted in a small JSON file next to the
   * identity DB. The hub mints it on first run; a read-only (child) store
   * requires the hub to have written it before spawn (WP0 §2).
   */
  private loadServerId(filePath: string): string {
    if (fs.existsSync(filePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
        if (
          raw !== null &&
          typeof raw === "object" &&
          !Array.isArray(raw) &&
          Object.keys(raw).length === 1 &&
          "serverId" in raw &&
          typeof raw.serverId === "string" &&
          SERVER_ID_PATTERN.test(raw.serverId)
        ) {
          return raw.serverId;
        }
      } catch {
        // The error below intentionally rejects corrupt/pre-cutover state.
      }
      throw new Error(
        `Unsupported server id state at ${filePath}; delete it to initialize a fresh pre-release server identity`
      );
    }
    if (this.db.readOnly) {
      throw new Error(
        `Server id not found at ${filePath} — the hub creates it before spawning children (WP0 §2)`
      );
    }
    const serverId = `srv_${randomBase64Url(18)}`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    writeJsonFileAtomic(filePath, { serverId });
    return serverId;
  }
}

function randomBase64Url(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}
