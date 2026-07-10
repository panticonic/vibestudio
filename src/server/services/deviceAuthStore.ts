import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { constantTimeStringEqual } from "@vibestudio/shared/tokenManager";
import { writeJsonFileAtomic } from "./atomicFile.js";
import { authError } from "./auth/errors.js";

export interface DeviceRecord {
  deviceId: string;
  refreshTokenHash: string;
  label: string;
  platform?: string;
  createdAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
  /**
   * WebRTC signaling room (per-invite room, plan §2.1) persisted at pairing
   * redemption so the server re-arms this device's answerer room on startup.
   */
  room?: string;
}

/**
 * An entity-scoped agent credential.
 * Authenticates as caller kind `agent`, principal `agent:<entityId>`. Only the
 * sha256 hash of the secret is persisted (mirrors device refresh tokens); the
 * clear token exists only at mint time. Lifecycle follows the entity —
 * `retireEntity` revokes every outstanding credential for it.
 */
export interface AgentCredentialRecord {
  agentId: string;
  tokenHash: string;
  entityId: string;
  contextId: string;
  channelId: string;
  scopes?: string[];
  createdAt: number;
  expiresAt?: number;
  revokedAt?: number;
}

/** The validated binding an agent credential authorizes (no secret material). */
export interface AgentBinding {
  agentId: string;
  entityId: string;
  contextId: string;
  channelId: string;
  scopes?: string[];
}

export interface IssuedAgentCredential {
  agentId: string;
  /** Full presentable token: `agent:<agentId>:<secret>`. */
  agentToken: string;
}

interface StoredDeviceAuthState {
  serverId: string;
  devices: DeviceRecord[];
  agents: AgentCredentialRecord[];
}

interface PairingCodeRecord {
  codeHash: string;
  expiresAt: number;
  createdAt: number;
  /** The invite's armed signaling room (moves onto the device at redemption). */
  room?: string;
  /** Fires the room-released hook when the invite expires unredeemed. */
  expiryTimer?: ReturnType<typeof setTimeout>;
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
  label: string;
  platform?: string;
}

export class DeviceAuthStore {
  private state: StoredDeviceAuthState;
  private readonly pairingCodes = new Map<string, PairingCodeRecord>();
  private roomRedeemedHandler: ((room: string, deviceId: string) => void) | null = null;
  private roomReleasedHandler: ((room: string) => void) | null = null;

  constructor(
    private readonly filePath: string,
    private readonly now = () => Date.now()
  ) {
    this.state = this.load();
  }

  getServerId(): string {
    return this.state.serverId;
  }

  /**
   * Invite redemption moved the invite's room onto a device record — the
   * WebRTC ingress re-tags the armed room with the device id.
   */
  onPairingRoomRedeemed(handler: (room: string, deviceId: string) => void): void {
    this.roomRedeemedHandler = handler;
  }

  /**
   * A room is no longer pair-able: its invite expired unredeemed, or its
   * device was revoked — the WebRTC ingress disarms the room's pipe.
   */
  onPairingRoomReleased(handler: (room: string) => void): void {
    this.roomReleasedHandler = handler;
  }

  createPairingCode(ttlMs = DEFAULT_PAIRING_CODE_TTL_MS, opts?: { room?: string }): string {
    const code = randomBase64Url(24);
    const codeHash = hashSecret(code);
    const record: PairingCodeRecord = {
      codeHash,
      createdAt: this.now(),
      expiresAt: this.now() + ttlMs,
      room: opts?.room,
    };
    if (record.room) {
      // Proactive expiry so the ingress disarms the invite's room even if
      // nobody ever presents the code again. unref'd: never holds the loop.
      record.expiryTimer = setTimeout(() => this.expirePairingCode(codeHash), ttlMs);
      record.expiryTimer.unref?.();
    }
    this.pairingCodes.set(codeHash, record);
    return code;
  }

  hasPendingPairingCode(code: string): boolean {
    const codeHash = hashSecret(code);
    const record = this.pairingCodes.get(codeHash);
    if (!record) return false;
    if (record.expiresAt < this.now()) {
      this.expirePairingCode(codeHash);
      return false;
    }
    return true;
  }

  completePairing(input: {
    code: string;
    label?: string;
    platform?: string;
  }): IssuedDeviceCredential {
    const codeHash = hashSecret(input.code);
    const record = this.pairingCodes.get(codeHash);
    if (!record || record.expiresAt < this.now()) {
      if (record) this.expirePairingCode(codeHash);
      throw authError("PAIRING_CODE_INVALID_OR_EXPIRED", "Pairing code is invalid or expired", 401);
    }
    if (record.expiryTimer) clearTimeout(record.expiryTimer);
    this.pairingCodes.delete(codeHash);
    const credential = this.issueDevice({
      label: input.label ?? "Vibestudio client",
      platform: input.platform,
      room: record.room,
    });
    if (record.room) this.roomRedeemedHandler?.(record.room, credential.deviceId);
    return credential;
  }

  issueDevice(input: { label: string; platform?: string; room?: string }): IssuedDeviceCredential {
    const deviceId = `dev_${randomBase64Url(18)}`;
    const refreshToken = randomBase64Url(32);
    const record: DeviceRecord = {
      deviceId,
      refreshTokenHash: hashSecret(refreshToken),
      label: input.label,
      platform: input.platform,
      createdAt: this.now(),
      ...(input.room ? { room: input.room } : {}),
    };
    this.state.devices.push(record);
    this.save();
    return { deviceId, refreshToken, label: record.label, platform: record.platform };
  }

  /** Delete an expired (or expiring) invite and release its armed room. */
  private expirePairingCode(codeHash: string): void {
    const record = this.pairingCodes.get(codeHash);
    if (!record) return;
    if (record.expiryTimer) clearTimeout(record.expiryTimer);
    this.pairingCodes.delete(codeHash);
    // Release the invite's room ONLY if no live device is bound to it. A device
    // is persisted with the room its pairing code carried; if that room is still
    // (or also) referenced by a live device record, disarming it here would tear
    // down that device's answerer pipe mid-session. An unredeemed invite whose
    // room no device claims is disarmed as before (frees the armed room).
    if (record.room && !this.isRoomBoundToActiveDevice(record.room)) {
      this.roomReleasedHandler?.(record.room);
    }
  }

  /** True when a non-revoked device is currently bound to this signaling room. */
  private isRoomBoundToActiveDevice(room: string): boolean {
    return this.state.devices.some((device) => !device.revokedAt && device.room === room);
  }

  /**
   * Whether ANY device has ever paired with this server. Drives the startup
   * pairing-TTL self-shutdown: a fresh spawn that no client ever attached to
   * cleans itself up. Checked at the TTL deadline (by which the startup codes
   * have already lazily expired), so it must reflect durable pairing state — a
   * persisted device record — not the transient pending-code map.
   */
  hasEverPaired(): boolean {
    return this.state.devices.length > 0;
  }

  validateRefresh(deviceId: string, refreshToken: string): DeviceRecord {
    const record = this.state.devices.find((device) => device.deviceId === deviceId);
    if (!record || record.revokedAt) {
      throw authError("DEVICE_NOT_PAIRED", "Device is not paired", 401);
    }
    const presentedHash = hashSecret(refreshToken);
    if (!constantTimeStringEqual(presentedHash, record.refreshTokenHash)) {
      throw authError("INVALID_REFRESH_CREDENTIAL", "Invalid refresh credential", 401);
    }
    // `lastUsedAt` is advisory telemetry. A churny device that reconnects many
    // times a minute would otherwise rewrite the WHOLE store JSON on every
    // reconnect. Keep the in-memory value fresh, but only persist when it has
    // advanced past a coarse interval — bounding disk writes without losing
    // meaningful last-seen resolution.
    const now = this.now();
    const previous = record.lastUsedAt ?? 0;
    record.lastUsedAt = now;
    if (now - previous >= LAST_USED_PERSIST_INTERVAL_MS) {
      this.save();
    }
    return record;
  }

  revokeDevice(deviceId: string): boolean {
    const record = this.state.devices.find((device) => device.deviceId === deviceId);
    if (!record || record.revokedAt) return false;
    record.revokedAt = this.now();
    this.save();
    // Revocation kills remote reach too: the ingress disarms the device's room.
    if (record.room) this.roomReleasedHandler?.(record.room);
    return true;
  }

  listDevices(): DeviceRecord[] {
    return this.state.devices.map((device) => ({ ...device }));
  }

  // ===========================================================================
  // Agent credentials (entity-scoped; §3.2)
  // ===========================================================================

  /**
   * Mint an entity-scoped agent credential. `agentId` is `agt_<rand>`; the
   * secret is a fresh 32-byte base64url token stored only as a sha256 hash
   * (mirrors `issueDevice`). Returns the full presentable token
   * `agent:<agentId>:<secret>`.
   */
  mintAgentCredential(input: {
    entityId: string;
    contextId: string;
    channelId: string;
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
      createdAt: this.now(),
      ...(input.ttlMs ? { expiresAt: this.now() + input.ttlMs } : {}),
      ...(input.scopes ? { scopes: input.scopes } : {}),
    };
    this.state.agents.push(record);
    this.save();
    return { agentId, agentToken: `agent:${agentId}:${secret}` };
  }

  /**
   * Validate a presented agent secret against a stored credential. Returns the
   * authorized binding (no secret material) or null when unknown, revoked,
   * expired, or the secret mismatches (constant-time compare).
   */
  validateAgentToken(agentId: string, token: string): AgentBinding | null {
    const record = this.state.agents.find((agent) => agent.agentId === agentId);
    if (!record || record.revokedAt) return null;
    if (record.expiresAt !== undefined && record.expiresAt < this.now()) return null;
    const presentedHash = hashSecret(token);
    if (!constantTimeStringEqual(presentedHash, record.tokenHash)) return null;
    return {
      agentId: record.agentId,
      entityId: record.entityId,
      contextId: record.contextId,
      channelId: record.channelId,
      ...(record.scopes ? { scopes: record.scopes } : {}),
    };
  }

  /** Revoke a single agent credential by id. Returns whether it was live. */
  revokeAgentCredential(agentId: string): boolean {
    const record = this.state.agents.find((agent) => agent.agentId === agentId);
    if (!record || record.revokedAt) return false;
    record.revokedAt = this.now();
    this.save();
    return true;
  }

  getAgentCredential(agentId: string): AgentCredentialRecord | null {
    const record = this.state.agents.find((agent) => agent.agentId === agentId);
    return record ? { ...record, ...(record.scopes ? { scopes: [...record.scopes] } : {}) } : null;
  }

  /**
   * Revoke every outstanding agent credential bound to an entity. Called by
   * `retireEntity` so credentials never outlive their entity. Returns the ids
   * revoked so the caller can also drop live TokenManager tokens.
   */
  revokeAgentCredentialsForEntity(entityId: string): string[] {
    const revoked: string[] = [];
    for (const record of this.state.agents) {
      if (record.entityId === entityId && !record.revokedAt) {
        record.revokedAt = this.now();
        revoked.push(record.agentId);
      }
    }
    if (revoked.length > 0) this.save();
    return revoked;
  }

  listAgentCredentials(): AgentCredentialRecord[] {
    return this.state.agents.map((agent) => ({ ...agent }));
  }

  private load(): StoredDeviceAuthState {
    if (!fs.existsSync(this.filePath)) {
      return { serverId: `srv_${randomBase64Url(18)}`, devices: [], agents: [] };
    }
    let raw: Partial<StoredDeviceAuthState>;
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<StoredDeviceAuthState>;
    } catch (error) {
      // Fail loud (never silently auto-reset — that would discard every paired
      // device), but make the failure recoverable by an operator: name the file
      // and the exact repair. Moving it aside lets the server mint a fresh store
      // on next start, at the cost of re-pairing all devices.
      throw new Error(
        `Device auth store is corrupt and could not be parsed: ${this.filePath}\n` +
          `  cause: ${error instanceof Error ? error.message : String(error)}\n` +
          `  recovery: inspect the file; if unrecoverable, move it aside to reset ` +
          `(e.g. \`mv "${this.filePath}" "${this.filePath}.corrupt-$(date +%s)"\`) — ` +
          `NOTE this unpairs every device and they must re-pair.`
      );
    }
    return {
      serverId:
        typeof raw.serverId === "string" && raw.serverId
          ? raw.serverId
          : `srv_${randomBase64Url(18)}`,
      devices: Array.isArray(raw.devices) ? raw.devices.filter(isDeviceRecord) : [],
      agents: Array.isArray(raw.agents) ? raw.agents.filter(isAgentCredentialRecord) : [],
    };
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    writeJsonFileAtomic(this.filePath, this.state);
  }
}

function randomBase64Url(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function isDeviceRecord(value: unknown): value is DeviceRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<DeviceRecord>;
  return (
    typeof record.deviceId === "string" &&
    typeof record.refreshTokenHash === "string" &&
    typeof record.label === "string" &&
    typeof record.createdAt === "number" &&
    (record.room === undefined || typeof record.room === "string")
  );
}

function isAgentCredentialRecord(value: unknown): value is AgentCredentialRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<AgentCredentialRecord>;
  return (
    typeof record.agentId === "string" &&
    typeof record.tokenHash === "string" &&
    typeof record.entityId === "string" &&
    typeof record.contextId === "string" &&
    typeof record.channelId === "string" &&
    typeof record.createdAt === "number" &&
    (record.expiresAt === undefined || typeof record.expiresAt === "number") &&
    (record.revokedAt === undefined || typeof record.revokedAt === "number") &&
    (record.scopes === undefined || Array.isArray(record.scopes))
  );
}
