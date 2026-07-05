/**
 * localServerCredStore — client-side persistence of the device credentials a
 * desktop issued itself against detached local workspace servers.
 *
 * When the desktop attaches to a detached local workspace server it pairs once
 * (over loopback) and the server issues a durable device credential
 * (`deviceId`/`refreshToken`). Persisting it, encrypted at rest under
 * `safeStorage`, lets the next attach re-authenticate (`refresh:…`) instead of
 * re-pairing. Keyed by workspace id (one credential per workspace).
 *
 * The store logic is pure (path + cipher injected) so it is unit-testable
 * without Electron; the service layer binds `app.getPath('userData')` +
 * `safeStorage`. The refresh secret is never written in plaintext.
 */

import { app, safeStorage } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createEncryptedJsonStore,
  type EncryptedJsonStore,
  type StoreCipher,
} from "./encryptedJsonStore.js";

export type { StoreCipher };

export interface LocalServerCredential {
  deviceId: string;
  refreshToken: string;
  serverId: string;
  pairedAt: number;
}

/** Map of workspaceId → the device credential issued for that workspace's server. */
export type LocalServerCredentials = Record<string, LocalServerCredential>;

export type LocalServerCredStore = EncryptedJsonStore<LocalServerCredentials>;

function isLocalServerCredentials(value: unknown): value is LocalServerCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    const cred = entry as LocalServerCredential | null | undefined;
    if (!cred || typeof cred.deviceId !== "string" || typeof cred.refreshToken !== "string") {
      return false;
    }
  }
  return true;
}

/**
 * Create a store backed by a single encrypted file (a map keyed by workspace id).
 * Reads tolerate a missing or corrupt file (returns null) but never silently
 * swallow a write failure and never write the refresh secret in plaintext.
 */
export function createLocalServerCredStore(deps: {
  filePath: string;
  cipher: StoreCipher;
  fs: Pick<
    typeof import("node:fs"),
    "readFileSync" | "writeFileSync" | "mkdirSync" | "rmSync" | "existsSync"
  >;
  dirname: (p: string) => string;
}): LocalServerCredStore {
  return createEncryptedJsonStore<LocalServerCredentials>({
    ...deps,
    validate: isLocalServerCredentials,
    secretDescription: "the local server device credential",
  });
}

/**
 * The store is created lazily (on first use) so that `app.getPath("userData")`
 * is read AFTER the startup `app.setPath("userData", …)` call has run, and so the
 * module can be imported in non-Electron unit tests without touching safeStorage.
 */
let storeSingleton: LocalServerCredStore | null = null;
function getStore(): LocalServerCredStore {
  if (!storeSingleton) {
    storeSingleton = createLocalServerCredStore({
      filePath: path.join(app.getPath("userData"), "local-server-creds.json"),
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
 * Persist via the store, surfacing (loudly) a refusal to write the refresh secret
 * in plaintext (OS secure storage unavailable) rather than crashing the caller.
 * The device simply re-pairs against the local server on the next attach.
 */
function persistOrWarn(label: string, persist: () => void): void {
  try {
    persist();
  } catch (error) {
    console.error(
      `[localServerCred] ${label}: ${error instanceof Error ? error.message : String(error)} ` +
        "— the device will need to re-pair on next attach."
    );
  }
}

/** Read the persisted device credential for a workspace's local server, if any. */
export function loadLocalServerCredential(workspaceId: string): LocalServerCredential | null {
  return getStore().load()?.[workspaceId] ?? null;
}

/** Persist the device credential a local workspace server issued for this workspace. */
export function saveLocalServerCredential(workspaceId: string, cred: LocalServerCredential): void {
  persistOrWarn("could not persist local server credential", () => {
    const all = getStore().load() ?? {};
    all[workspaceId] = cred;
    getStore().save(all);
  });
}

/**
 * Forget the persisted device credential for a workspace's local server. Tolerates
 * an unavailable cipher (nothing readable ⇒ nothing to clear) by ignoring.
 */
export function clearLocalServerCredential(workspaceId: string): void {
  const all = getStore().load();
  if (!all || !(workspaceId in all)) return;
  delete all[workspaceId];
  persistOrWarn("could not clear local server credential", () => getStore().save(all));
}
