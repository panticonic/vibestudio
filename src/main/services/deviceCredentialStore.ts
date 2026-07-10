/**
 * Unified desktop credential store for paired servers.
 *
 * One encrypted file replaces the old local-server and WebRTC-remote stores.
 * Entries are keyed by serverId for both loopback and WebRTC transports.
 *
 * The document additionally tracks the CURRENT remote server — the WebRTC server
 * this desktop is actively bound to. With more than one paired remote, "which one
 * do we reconnect to / does Disconnect target" would otherwise be ambiguous
 * (previously: silently the oldest, and Disconnect wiped ALL of them). The
 * current pointer resolves both: `loadStoredRemotePairing` returns the current
 * remote and `clearStoredRemotePairing` clears only it.
 */

import { app, safeStorage } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ConnectPairing } from "@vibestudio/shared/connect";
import {
  createEncryptedJsonStore,
  type EncryptedJsonStore,
  type StoreCipher,
  type StoreFs,
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

/**
 * On-disk document: the entries keyed by serverId, plus a pointer to the CURRENT
 * remote server (the WebRTC server the desktop actively reconnects to / that
 * Disconnect targets).
 */
export interface DeviceCredentialDocument {
  currentRemoteServerId?: string;
  entries: DeviceCredentialEntries;
}

export type DeviceCredentialStore = EncryptedJsonStore<DeviceCredentialDocument>;

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

function isStoredRemote(entry: DeviceCredentialEntry | undefined): entry is StoredRemote {
  return !!entry && entry.transport === "webrtc" && !!entry.pairing;
}

/**
 * Normalize a decoded document, DROPPING individual invalid entries while keeping
 * the valid ones. One stale-schema entry must never discard every stored server's
 * pairing (returning null here would make the store treat the whole file as
 * absent → the next save reseeds from empty → permanent wipe). Returns null only
 * when the value is not a usable document object at all.
 */
export function parseDeviceCredentialDocument(value: unknown): DeviceCredentialDocument | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const rawEntries = record["entries"];
  if (!rawEntries || typeof rawEntries !== "object" || Array.isArray(rawEntries)) return null;

  const entries: DeviceCredentialEntries = {};
  for (const [serverId, entry] of Object.entries(rawEntries as Record<string, unknown>)) {
    // Keep only well-formed entries whose key matches the record's serverId.
    if (isEntry(entry) && entry.serverId === serverId) entries[serverId] = entry;
  }

  // Keep the current pointer only if it still resolves to a valid webrtc entry.
  const rawCurrent = record["currentRemoteServerId"];
  const currentRemoteServerId =
    typeof rawCurrent === "string" && isStoredRemote(entries[rawCurrent]) ? rawCurrent : undefined;

  return currentRemoteServerId ? { currentRemoteServerId, entries } : { entries };
}

/**
 * Resolve the current remote from a document: the pinned current server if it is
 * a valid webrtc entry, else the most recently paired/rotated webrtc entry (a
 * sensible default when no explicit current is set — e.g. a single paired remote,
 * or a document written before the pointer existed).
 */
export function selectCurrentRemote(doc: DeviceCredentialDocument | null): StoredRemote | null {
  if (!doc) return null;
  const pinned = doc.currentRemoteServerId ? doc.entries[doc.currentRemoteServerId] : undefined;
  if (isStoredRemote(pinned)) return pinned;
  const remotes = Object.values(doc.entries).filter(isStoredRemote);
  if (remotes.length === 0) return null;
  return remotes.reduce((newest, entry) =>
    (entry.rotatedAt ?? entry.pairedAt) > (newest.rotatedAt ?? newest.pairedAt) ? entry : newest
  );
}

export function createDeviceCredentialStore(deps: {
  filePath: string;
  cipher: StoreCipher;
  fs: StoreFs;
  dirname: (p: string) => string;
}): DeviceCredentialStore {
  return createEncryptedJsonStore<DeviceCredentialDocument>({
    ...deps,
    parse: parseDeviceCredentialDocument,
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

/**
 * Load the document for a MUTATION. If the file is present but unreadable
 * (corrupt / secure storage unavailable) we refuse to reseed from empty — that
 * would truncate every stored server's pairing. Fail loud instead; the caller's
 * `persistOrWarn` surfaces it and the device re-pairs next launch rather than
 * silently losing every credential.
 */
function loadDocumentForWrite(): DeviceCredentialDocument {
  const store = getStore();
  const doc = store.load();
  if (doc) return doc;
  if (store.exists()) {
    throw new Error(
      "device-credentials.json is present but could not be read (corrupt, or secure storage " +
        "unavailable); refusing to overwrite it and lose every paired server."
    );
  }
  return { entries: {} };
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
  return getStore().load()?.entries[serverId] ?? null;
}

export function loadDeviceCredentialByWorkspaceId(
  workspaceId: string
): LocalServerCredential | null {
  const doc = getStore().load();
  if (!doc) return null;
  return (
    (Object.values(doc.entries).find(
      (entry): entry is LocalServerCredential =>
        entry.transport === "loopback" && entry.workspaceId === workspaceId
    ) as LocalServerCredential | undefined) ?? null
  );
}

/** The CURRENT remote pairing (the active WebRTC server), if any. */
export function loadStoredRemotePairing(): StoredRemote | null {
  return selectCurrentRemote(getStore().load());
}

export function saveDeviceCredential(entry: DeviceCredentialEntry): void {
  persistOrWarn("could not persist device credential", () => {
    const doc = loadDocumentForWrite();
    doc.entries[entry.serverId] = entry;
    // A freshly paired / rotated remote becomes the current one we reconnect to.
    if (entry.transport === "webrtc") doc.currentRemoteServerId = entry.serverId;
    getStore().save(doc);
  });
}

export function clearDeviceCredentialByServerId(serverId: string): void {
  const doc = getStore().load();
  if (!doc || !(serverId in doc.entries)) return;
  delete doc.entries[serverId];
  if (doc.currentRemoteServerId === serverId) delete doc.currentRemoteServerId;
  persistOrWarn("could not clear device credential", () => getStore().save(doc));
}

export function clearDeviceCredentialByWorkspaceId(workspaceId: string): void {
  const doc = getStore().load();
  if (!doc) return;
  let changed = false;
  for (const [serverId, entry] of Object.entries(doc.entries)) {
    if (entry.transport === "loopback" && entry.workspaceId === workspaceId) {
      delete doc.entries[serverId];
      changed = true;
    }
  }
  if (changed) persistOrWarn("could not clear device credential", () => getStore().save(doc));
}

/**
 * Disconnect: forget ONLY the current remote pairing (not every paired server).
 * A second paired remote, if any, is promoted to current so the next launch
 * reconnects to it rather than dropping to the chooser.
 */
export function clearStoredRemotePairing(): void {
  const doc = getStore().load();
  if (!doc) return;
  const current = selectCurrentRemote(doc);
  if (!current) return;
  delete doc.entries[current.serverId];
  delete doc.currentRemoteServerId;
  const next = selectCurrentRemote(doc);
  if (next) doc.currentRemoteServerId = next.serverId;
  persistOrWarn("could not clear remote pairing", () => getStore().save(doc));
}

export function clearAllDeviceCredentials(): void {
  getStore().clear();
}
