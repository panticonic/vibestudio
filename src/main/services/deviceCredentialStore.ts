/**
 * Unified desktop credential store for paired servers.
 *
 * One encrypted file replaces the old local-server and WebRTC-remote stores.
 * Entries are keyed by serverId for both loopback and WebRTC transports.
 */

import { app, safeStorage } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ConnectPairing } from "@vibestudio/shared/connect";
import {
  createEncryptedJsonStore,
  type EncryptedJsonStore,
  type StoreCipher,
} from "./encryptedJsonStore.js";

export type { StoreCipher };

export type StoredPairing = Omit<ConnectPairing, "code">;

export interface DeviceCredentialEntry {
  serverId: string;
  deviceId: string;
  refreshToken: string;
  transport: "loopback" | "webrtc";
  pairing?: StoredPairing;
  workspaceId?: string;
  workspaceName?: string;
  label?: string;
  pairedAt: number;
  rotatedAt?: number;
}

export type StoredRemote = DeviceCredentialEntry & {
  transport: "webrtc";
  pairing: StoredPairing;
};

export type LocalServerCredential = DeviceCredentialEntry & {
  transport: "loopback";
  workspaceId: string;
};

export type DeviceCredentialEntries = Record<string, DeviceCredentialEntry>;
export type DeviceCredentialStore = EncryptedJsonStore<DeviceCredentialEntries>;

function isEntry(value: unknown): value is DeviceCredentialEntry {
  const v = value as DeviceCredentialEntry | null | undefined;
  if (!v || typeof v !== "object") return false;
  if (typeof v.serverId !== "string" || !v.serverId) return false;
  if (typeof v.deviceId !== "string" || !v.deviceId) return false;
  if (typeof v.refreshToken !== "string" || !v.refreshToken) return false;
  if (v.transport !== "loopback" && v.transport !== "webrtc") return false;
  if (v.transport === "loopback" && (typeof v.workspaceId !== "string" || !v.workspaceId)) {
    return false;
  }
  if (v.transport === "webrtc" && (!v.pairing?.room || !v.pairing.fp || !v.pairing.sig)) {
    return false;
  }
  return true;
}

function isEntries(value: unknown): value is DeviceCredentialEntries {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(isEntry);
}

export function createDeviceCredentialStore(deps: {
  filePath: string;
  cipher: StoreCipher;
  fs: Pick<
    typeof import("node:fs"),
    "readFileSync" | "writeFileSync" | "mkdirSync" | "rmSync" | "existsSync"
  >;
  dirname: (p: string) => string;
}): DeviceCredentialStore {
  return createEncryptedJsonStore<DeviceCredentialEntries>({
    ...deps,
    validate: isEntries,
    secretDescription: "the paired device refresh credential",
  });
}

let storeSingleton: DeviceCredentialStore | null = null;
function getStore(): DeviceCredentialStore {
  if (!storeSingleton) {
    storeSingleton = createDeviceCredentialStore({
      filePath: path.join(app.getPath("userData"), "device-credentials.json"),
      cipher: {
        encrypt: (s) => safeStorage.encryptString(s),
        decrypt: (b) => safeStorage.decryptString(b),
        isAvailable: () => safeStorage.isEncryptionAvailable(),
      },
      fs,
      dirname: path.dirname,
    });
  }
  return storeSingleton;
}

function persistOrWarn(label: string, persist: () => void): void {
  try {
    persist();
  } catch (error) {
    console.error(
      `[deviceCred] ${label}: ${error instanceof Error ? error.message : String(error)} ` +
        "- the device will need to re-pair on next launch."
    );
  }
}

export function loadDeviceCredentialByServerId(serverId: string): DeviceCredentialEntry | null {
  return getStore().load()?.[serverId] ?? null;
}

export function loadDeviceCredentialByWorkspaceId(
  workspaceId: string
): LocalServerCredential | null {
  const entries = getStore().load();
  if (!entries) return null;
  return (
    (Object.values(entries).find(
      (entry): entry is LocalServerCredential =>
        entry.transport === "loopback" && entry.workspaceId === workspaceId
    ) as LocalServerCredential | undefined) ?? null
  );
}

export function loadStoredRemotePairing(): StoredRemote | null {
  const entries = getStore().load();
  if (!entries) return null;
  return (
    (Object.values(entries).find(
      (entry): entry is StoredRemote => entry.transport === "webrtc" && !!entry.pairing
    ) as StoredRemote | undefined) ?? null
  );
}

export function saveDeviceCredential(entry: DeviceCredentialEntry): void {
  persistOrWarn("could not persist device credential", () => {
    const entries = getStore().load() ?? {};
    entries[entry.serverId] = entry;
    getStore().save(entries);
  });
}

export function clearDeviceCredentialByServerId(serverId: string): void {
  const entries = getStore().load();
  if (!entries || !(serverId in entries)) return;
  delete entries[serverId];
  persistOrWarn("could not clear device credential", () => getStore().save(entries));
}

export function clearDeviceCredentialByWorkspaceId(workspaceId: string): void {
  const entries = getStore().load();
  if (!entries) return;
  let changed = false;
  for (const [serverId, entry] of Object.entries(entries)) {
    if (entry.transport === "loopback" && entry.workspaceId === workspaceId) {
      delete entries[serverId];
      changed = true;
    }
  }
  if (changed) persistOrWarn("could not clear device credential", () => getStore().save(entries));
}

export function clearStoredRemotePairing(): void {
  const entries = getStore().load();
  if (!entries) return;
  let changed = false;
  for (const [serverId, entry] of Object.entries(entries)) {
    if (entry.transport === "webrtc") {
      delete entries[serverId];
      changed = true;
    }
  }
  if (changed) persistOrWarn("could not clear remote pairing", () => getStore().save(entries));
}

export function clearAllDeviceCredentials(): void {
  getStore().clear();
}
