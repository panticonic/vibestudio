/**
 * Unified desktop credential store for paired servers.
 *
 * Entries for both loopback and WebRTC transports live in one encrypted file,
 * keyed by the server identifier emitted by the current credential issuer.
 */

import { safeStorage } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  normalizeFingerprint,
  PAIRING_PROTOCOL_VERSION,
  PAIRING_ROOM_PATTERN,
  parseSignalingEndpoint,
  type ConnectPairing,
  type TurnPolicy,
} from "@vibestudio/shared/connect";
import { isDeviceId, isDeviceRefreshToken, isServerId } from "@vibestudio/shared/deviceCredentials";
import { getCentralDataPath } from "@vibestudio/env-paths";
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

export type DeviceCredentialEntries = Record<string, DeviceCredentialEntry>;
export interface DeviceCredentialDocument {
  currentRemoteServerId?: string;
  entries: DeviceCredentialEntries;
}
export type DeviceCredentialStore = EncryptedJsonStore<DeviceCredentialDocument>;

function isEntry(value: unknown): value is DeviceCredentialEntry {
  const v = value as DeviceCredentialEntry | null | undefined;
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  if (!isServerId(v.serverId)) return false;
  if (!isDeviceId(v.deviceId)) return false;
  if (!isDeviceRefreshToken(v.refreshToken)) return false;
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
  const allowedPairing = new Set(["room", "fp", "sig", "v", "ice"]);
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
    (pairing.ice === "all" || pairing.ice === "relay")
  );
}

function isEntries(value: unknown): value is DeviceCredentialEntries {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every(([serverId, entry]) => isEntry(entry) && entry.serverId === serverId)) {
    return false;
  }
  return true;
}

export function parseDeviceCredentialDocument(value: unknown): DeviceCredentialDocument | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "entries" && key !== "currentRemoteServerId")) {
    return null;
  }
  if (!isEntries(record["entries"])) return null;
  const current = record["currentRemoteServerId"];
  if (
    current !== undefined &&
    (typeof current !== "string" || record["entries"][current]?.transport !== "webrtc")
  ) {
    return null;
  }
  return {
    ...(typeof current === "string" ? { currentRemoteServerId: current } : {}),
    entries: record["entries"],
  };
}

function isDocument(value: unknown): value is DeviceCredentialDocument {
  return parseDeviceCredentialDocument(value) !== null;
}

export function selectCurrentRemote(
  document: DeviceCredentialDocument | null
): StoredRemote | null {
  if (!document) return null;
  const pinned = document.currentRemoteServerId
    ? document.entries[document.currentRemoteServerId]
    : undefined;
  if (pinned?.transport === "webrtc") return pinned;
  return (
    Object.values(document.entries)
      .filter((entry): entry is StoredRemote => entry.transport === "webrtc")
      .sort((a, b) => entryTimestamp(b) - entryTimestamp(a))[0] ?? null
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
  const encryptedStore = createEncryptedJsonStore<DeviceCredentialDocument>({
    ...deps,
    dirname: path.dirname,
    parse: parseDeviceCredentialDocument,
    secretDescription: "the paired device refresh credential",
  });
  return {
    load: () => {
      const document = encryptedStore.load();
      if (document === null && encryptedStore.exists()) {
        throw new Error(
          "Stored device credentials are unreadable or do not match the current canonical schema"
        );
      }
      return document;
    },
    exists: () => encryptedStore.exists(),
    save: (document) => {
      if (!isDocument(document)) {
        throw new Error("Refusing to persist a non-canonical device credential record");
      }
      encryptedStore.save(document);
    },
    clear: () => encryptedStore.clear(),
  };
}

let storeSingleton: DeviceCredentialStore | null = null;

function entryTimestamp(entry: DeviceCredentialEntry): number {
  return entry.rotatedAt ?? entry.pairedAt;
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
  }
  return storeSingleton;
}

export function loadDeviceCredentialByServerId(serverId: string): DeviceCredentialEntry | null {
  return getStore().load()?.entries[serverId] ?? null;
}

/** The CURRENT remote pairing (the active WebRTC server), if any. */
export function loadStoredRemotePairing(): StoredRemote | null {
  return selectCurrentRemote(getStore().load());
}

export function saveDeviceCredential(entry: DeviceCredentialEntry): void {
  const document = getStore().load() ?? { entries: {} };
  document.entries[entry.serverId] = entry;
  if (entry.transport === "webrtc") document.currentRemoteServerId = entry.serverId;
  getStore().save(document);
}

export function clearDeviceCredentialByServerId(serverId: string): void {
  const document = getStore().load();
  if (!document || !(serverId in document.entries)) return;
  Reflect.deleteProperty(document.entries, serverId);
  if (document.currentRemoteServerId === serverId) {
    const replacement = selectCurrentRemote({ entries: document.entries });
    if (replacement) document.currentRemoteServerId = replacement.serverId;
    else Reflect.deleteProperty(document, "currentRemoteServerId");
  }
  getStore().save(document);
}

/**
 * Disconnect: forget ONLY the current remote pairing (not every paired server).
 * A second paired remote, if any, is promoted to current so the next launch
 * reconnects to it rather than dropping to the chooser.
 */
export function clearStoredRemotePairing(): void {
  const document = getStore().load();
  const current = selectCurrentRemote(document);
  if (!document || !current) return;
  Reflect.deleteProperty(document.entries, current.serverId);
  const replacement = selectCurrentRemote({ entries: document.entries });
  if (replacement) document.currentRemoteServerId = replacement.serverId;
  else Reflect.deleteProperty(document, "currentRemoteServerId");
  getStore().save(document);
}

export function clearAllDeviceCredentials(): void {
  getStore().clear();
}
