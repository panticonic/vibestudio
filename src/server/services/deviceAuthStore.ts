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

interface StoredDeviceAuthState {
  serverId: string;
  devices: DeviceRecord[];
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
    if (record.room) this.roomReleasedHandler?.(record.room);
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
    record.lastUsedAt = this.now();
    this.save();
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

  private load(): StoredDeviceAuthState {
    if (!fs.existsSync(this.filePath)) {
      return { serverId: `srv_${randomBase64Url(18)}`, devices: [] };
    }
    const raw = JSON.parse(
      fs.readFileSync(this.filePath, "utf8")
    ) as Partial<StoredDeviceAuthState>;
    return {
      serverId:
        typeof raw.serverId === "string" && raw.serverId
          ? raw.serverId
          : `srv_${randomBase64Url(18)}`,
      devices: Array.isArray(raw.devices) ? raw.devices.filter(isDeviceRecord) : [],
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
