/**
 * Unified desktop credential store for paired servers.
 *
 * Entries for both loopback and WebRTC transports live in one encrypted file,
 * keyed by the server identifier emitted by the current credential issuer.
 */

import { app, safeStorage } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  normalizeFingerprint,
  PAIRING_CODE_PATTERN,
  PAIRING_PROTOCOL_VERSION,
  PAIRING_ROOM_PATTERN,
  parseSignalingEndpoint,
  type ConnectPairing,
  type TurnPolicy,
} from "@vibestudio/shared/connect";
import { isDeviceId, isDeviceRefreshToken, isServerId } from "@vibestudio/shared/deviceCredentials";
import { getCentralDataPath, getWorkspacesDir } from "@vibestudio/env-paths";
import {
  createEncryptedJsonStore,
  type EncryptedJsonStore,
  type StoreCipher,
} from "./encryptedJsonStore.js";

export type { StoreCipher };

export type StoredPairing = Omit<ConnectPairing, "code" | "v" | "ice"> & {
  v: typeof PAIRING_PROTOCOL_VERSION;
  ice: TurnPolicy;
};

interface DeviceCredentialBase {
  serverId: string;
  deviceId: string;
  refreshToken: string;
  label?: string;
  pairedAt: number;
  rotatedAt?: number;
}

export type LoopbackDeviceCredential = DeviceCredentialBase & {
  transport: "loopback";
};

export type StoredRemote = DeviceCredentialBase & {
  transport: "webrtc";
  controlPairing: StoredPairing;
  workspacePairing: StoredPairing;
  workspaceName: string;
};

export type DeviceCredentialEntry = LoopbackDeviceCredential | StoredRemote;

export type PendingLoopbackPairing = {
  serverId: string;
  transport: "pending-loopback";
  deviceId: string;
  refreshToken: string;
  inviteCode: string;
  expiresAt: number;
  preparedAt: number;
  label: string;
};

export type DeviceCredentialStoreEntry = DeviceCredentialEntry | PendingLoopbackPairing;
export type DeviceCredentialEntries = Record<string, DeviceCredentialStoreEntry>;
export type DeviceCredentialStore = EncryptedJsonStore<DeviceCredentialEntries>;

function isEntry(value: unknown): value is DeviceCredentialStoreEntry {
  const v = value as DeviceCredentialStoreEntry | null | undefined;
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  if (!isServerId(v.serverId)) return false;
  if (!isDeviceId(v.deviceId)) return false;
  if (!isDeviceRefreshToken(v.refreshToken)) return false;
  if (v.transport === "pending-loopback") {
    const allowedPending = new Set([
      "serverId",
      "transport",
      "deviceId",
      "refreshToken",
      "inviteCode",
      "expiresAt",
      "preparedAt",
      "label",
    ]);
    return (
      Object.keys(v).every((key) => allowedPending.has(key)) &&
      PAIRING_CODE_PATTERN.test(v.inviteCode) &&
      Number.isSafeInteger(v.preparedAt) &&
      v.preparedAt > 0 &&
      Number.isSafeInteger(v.expiresAt) &&
      v.expiresAt > v.preparedAt &&
      typeof v.label === "string" &&
      v.label.length > 0 &&
      v.label.length <= 128 &&
      v.label.trim() === v.label
    );
  }
  if (!Number.isSafeInteger(v.pairedAt) || v.pairedAt <= 0) {
    return false;
  }
  if (
    v.rotatedAt !== undefined &&
    (!Number.isSafeInteger(v.rotatedAt) || v.rotatedAt < v.pairedAt)
  ) {
    return false;
  }
  if (
    v.label !== undefined &&
    (typeof v.label !== "string" ||
      v.label.length === 0 ||
      v.label.length > 128 ||
      v.label.trim() !== v.label)
  ) {
    return false;
  }
  if (v.transport !== "loopback" && v.transport !== "webrtc") return false;
  const allowedBase = new Set([
    "serverId",
    "deviceId",
    "refreshToken",
    "transport",
    "label",
    "pairedAt",
    "rotatedAt",
  ]);
  if (v.transport === "loopback") {
    if (Object.keys(v).some((key) => !allowedBase.has(key))) return false;
  } else {
    const allowedRemote = new Set([
      ...allowedBase,
      "controlPairing",
      "workspacePairing",
      "workspaceName",
    ]);
    if (Object.keys(v).some((key) => !allowedRemote.has(key))) return false;
    if (!isStoredPairing(v.controlPairing) || !isStoredPairing(v.workspacePairing)) return false;
    if (typeof v.workspaceName !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(v.workspaceName)) {
      return false;
    }
  }
  return true;
}

function isStoredPairing(value: unknown): value is StoredPairing {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pairing = value as Partial<StoredPairing>;
  const allowedPairing = new Set(["room", "fp", "sig", "v", "ice", "srv"]);
  if (Object.keys(value).some((key) => !allowedPairing.has(key))) return false;
  if (
    typeof pairing.room !== "string" ||
    !PAIRING_ROOM_PATTERN.test(pairing.room) ||
    typeof pairing.fp !== "string" ||
    pairing.fp !== normalizeFingerprint(pairing.fp) ||
    !/^[0-9A-F]{64}$/.test(pairing.fp) ||
    typeof pairing.sig !== "string"
  ) {
    return false;
  }
  const signaling = parseSignalingEndpoint(pairing.sig);
  return (
    signaling.kind === "ok" &&
    signaling.url === pairing.sig &&
    pairing.v === PAIRING_PROTOCOL_VERSION &&
    (pairing.ice === "all" || pairing.ice === "relay") &&
    (pairing.srv === undefined ||
      (typeof pairing.srv === "string" &&
        pairing.srv.length > 0 &&
        pairing.srv.length <= 128 &&
        pairing.srv.trim() === pairing.srv))
  );
}

function isEntries(value: unknown): value is DeviceCredentialEntries {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every(([serverId, entry]) => isEntry(entry) && entry.serverId === serverId)) {
    return false;
  }
  return (
    entries.filter(([, entry]) => (entry as DeviceCredentialEntry).transport === "webrtc").length <=
    1
  );
}

export function createDeviceCredentialStore(deps: {
  filePath: string;
  cipher: StoreCipher;
  fs: Pick<
    typeof import("node:fs"),
    | "chmodSync"
    | "closeSync"
    | "existsSync"
    | "fsyncSync"
    | "mkdirSync"
    | "openSync"
    | "readFileSync"
    | "renameSync"
    | "rmSync"
    | "writeFileSync"
  >;
}): DeviceCredentialStore {
  const encryptedStore = createEncryptedJsonStore<DeviceCredentialEntries>({
    ...deps,
    validate: isEntries,
    secretDescription: "the paired device refresh credential",
  });
  return {
    load: () => encryptedStore.load(),
    save: (entries) => {
      if (!isEntries(entries)) {
        throw new Error("Refusing to persist a non-canonical device credential record");
      }
      encryptedStore.save(entries);
    },
    clear: () => encryptedStore.clear(),
  };
}

let storeSingleton: DeviceCredentialStore | null = null;

function entryTimestamp(entry: DeviceCredentialStoreEntry): number {
  return entry.transport === "pending-loopback"
    ? entry.preparedAt
    : (entry.rotatedAt ?? entry.pairedAt);
}

/** Merge valid legacy snapshots without reviving an older credential. */
export function mergeDeviceCredentialEntries(
  snapshots: Array<DeviceCredentialEntries | null>
): DeviceCredentialEntries {
  const candidates = new Map<string, DeviceCredentialStoreEntry[]>();
  for (const snapshot of snapshots) {
    if (!snapshot) continue;
    for (const [serverId, entry] of Object.entries(snapshot)) {
      const entries = candidates.get(serverId) ?? [];
      entries.push(entry);
      candidates.set(serverId, entries);
    }
  }

  const merged: DeviceCredentialEntries = {};
  for (const [serverId, entries] of candidates) {
    merged[serverId] = entries.reduce((latest, entry) =>
      entryTimestamp(entry) >= entryTimestamp(latest) ? entry : latest
    );
  }

  const remotes = Object.entries(merged).filter(
    (entry): entry is [string, StoredRemote] => entry[1].transport === "webrtc"
  );
  if (remotes.length > 1) {
    const [keepServerId] = remotes.reduce((latest, entry) =>
      entryTimestamp(entry[1]) >= entryTimestamp(latest[1]) ? entry : latest
    );
    for (const [serverId] of remotes) {
      if (serverId === keepServerId) continue;
      const fallback = candidates
        .get(serverId)
        ?.filter((entry) => entry.transport !== "webrtc")
        .reduce<DeviceCredentialStoreEntry | null>(
          (latest, entry) =>
            latest === null || entryTimestamp(entry) >= entryTimestamp(latest) ? entry : latest,
          null
        );
      if (fallback) merged[serverId] = fallback;
      else Reflect.deleteProperty(merged, serverId);
    }
  }
  return merged;
}

function legacyCredentialPaths(centralPath: string): string[] {
  const paths = new Set<string>([
    path.join(app.getPath("userData"), "device-credentials.json"),
    path.join(centralPath, "bootstrap-state", "device-credentials.json"),
  ]);
  try {
    for (const entry of fs.readdirSync(getWorkspacesDir(), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      paths.add(path.join(getWorkspacesDir(), entry.name, "state", "device-credentials.json"));
      paths.add(
        path.join(getWorkspacesDir(), entry.name, "state-headless-host", "device-credentials.json")
      );
    }
  } catch {
    // A fresh install has no workspaces directory to migrate.
  }
  paths.delete(path.join(centralPath, "device-credentials.json"));
  return [...paths];
}

function getStore(): DeviceCredentialStore {
  if (!storeSingleton) {
    const centralPath = getCentralDataPath();
    const cipher: StoreCipher = {
      encrypt: (s) => safeStorage.encryptString(s),
      decrypt: (b) => safeStorage.decryptString(b),
      isAvailable: () => safeStorage.isEncryptionAvailable(),
    };
    storeSingleton = createDeviceCredentialStore({
      filePath: path.join(centralPath, "device-credentials.json"),
      cipher,
      fs,
    });
    if (storeSingleton.load() === null) {
      const migrated = mergeDeviceCredentialEntries(
        legacyCredentialPaths(centralPath).map((filePath) => {
          if (!fs.existsSync(filePath)) return null;
          return createDeviceCredentialStore({ filePath, cipher, fs }).load();
        })
      );
      if (Object.keys(migrated).length > 0) storeSingleton.save(migrated);
    }
  }
  return storeSingleton;
}

export function loadDeviceCredentialByServerId(serverId: string): DeviceCredentialEntry | null {
  const entry = getStore().load()?.[serverId];
  return entry && entry.transport !== "pending-loopback" ? entry : null;
}

export function loadPendingLoopbackPairing(serverId: string): PendingLoopbackPairing | null {
  const entry = getStore().load()?.[serverId];
  return entry?.transport === "pending-loopback" ? entry : null;
}

export function loadStoredRemotePairing(): StoredRemote | null {
  const entries = getStore().load();
  if (!entries) return null;
  return (
    Object.values(entries).find((entry): entry is StoredRemote => entry.transport === "webrtc") ??
    null
  );
}

export function saveDeviceCredential(entry: DeviceCredentialEntry): void {
  const entries = getStore().load() ?? {};
  if (entry.transport === "webrtc") {
    for (const [serverId, existing] of Object.entries(entries)) {
      if (existing.transport === "webrtc") Reflect.deleteProperty(entries, serverId);
    }
  }
  entries[entry.serverId] = entry;
  getStore().save(entries);
}

export function savePendingLoopbackPairing(entry: PendingLoopbackPairing): void {
  const entries = getStore().load() ?? {};
  entries[entry.serverId] = entry;
  getStore().save(entries);
}

export function clearDeviceCredentialByServerId(serverId: string): void {
  const entries = getStore().load();
  if (!entries || !(serverId in entries)) return;
  Reflect.deleteProperty(entries, serverId);
  getStore().save(entries);
}

export function clearStoredRemotePairing(): void {
  const entries = getStore().load();
  if (!entries) return;
  let changed = false;
  for (const [serverId, entry] of Object.entries(entries)) {
    if (entry.transport === "webrtc") {
      Reflect.deleteProperty(entries, serverId);
      changed = true;
    }
  }
  if (changed) getStore().save(entries);
}

export function clearAllDeviceCredentials(): void {
  getStore().clear();
}
