/**
 * remoteCredentialStore — persist remote-server credentials via Electron safeStorage.
 *
 * The admin token is encrypted with the OS keychain (Keychain on macOS,
 * DPAPI on Windows, libsecret/kwallet on Linux). URL / CA path / fingerprint
 * are stored as plaintext JSON alongside the encrypted blob.
 *
 * Resolution order consumed by startupMode:
 *   1. NATSTACK_REMOTE_* env vars
 *   2. this store
 */

import { safeStorage } from "electron";
import * as fs from "fs";
import * as path from "path";
import { createDevLogger } from "@natstack/dev-log";
import { ensureCentralConfigDir } from "@natstack/shared/workspace/loader";
import { getCentralConfigDirectory } from "./paths.js";

const log = createDevLogger("RemoteCredStore");

const STORE_FILENAME = "remote-credentials.json";

interface StoredPlain {
  url: string;
  caPath?: string;
  fingerprint?: string;
  /** Base64 encoded ciphertext from safeStorage, or the raw admin token if safeStorage is unavailable. */
  token: string;
  /** Base64 encoded ciphertext from safeStorage, or the raw refresh token if safeStorage is unavailable. */
  refreshToken?: string;
  deviceId?: string;
  /** Whether secret fields are encrypted (true) or stored plaintext (fallback only). */
  encrypted: boolean;
}

export interface RemoteCredentials {
  url: string;
  token: string;
  deviceId?: string;
  refreshToken?: string;
  caPath?: string;
  fingerprint?: string;
}

function storePath(): string {
  // Live in the central config dir (same place as oauth-tokens / secrets) so
  // it is readable before Electron's userData path is finalized for the session.
  return path.join(getCentralConfigDirectory(), STORE_FILENAME);
}

export function loadRemoteCredentials(): RemoteCredentials | null {
  const p = storePath();
  if (!fs.existsSync(p)) return null;

  let stored: StoredPlain;
  try {
    stored = JSON.parse(fs.readFileSync(p, "utf-8")) as StoredPlain;
  } catch (err) {
    log.warn(`Failed to parse ${p}: ${(err as Error).message}`);
    return null;
  }

  let token = stored.token;
  let refreshToken = stored.refreshToken;
  if (stored.encrypted) {
    if (!safeStorage.isEncryptionAvailable()) {
      log.warn(`safeStorage unavailable — cannot decrypt token at ${p}`);
      return null;
    }
    try {
      token = safeStorage.decryptString(Buffer.from(stored.token, "base64"));
      refreshToken = stored.refreshToken
        ? safeStorage.decryptString(Buffer.from(stored.refreshToken, "base64"))
        : undefined;
    } catch (err) {
      log.warn(`Failed to decrypt token: ${(err as Error).message}`);
      return null;
    }
  }

  return {
    url: stored.url,
    token,
    deviceId: stored.deviceId,
    refreshToken,
    caPath: stored.caPath,
    fingerprint: stored.fingerprint,
  };
}

export function saveRemoteCredentials(creds: RemoteCredentials): void {
  const p = storePath();
  ensureCentralConfigDir();

  const encrypted = safeStorage.isEncryptionAvailable();
  const tokenField = encrypted
    ? safeStorage.encryptString(creds.token).toString("base64")
    : creds.token;
  const refreshTokenField = creds.refreshToken
    ? encrypted
      ? safeStorage.encryptString(creds.refreshToken).toString("base64")
      : creds.refreshToken
    : undefined;

  const payload: StoredPlain = {
    url: creds.url,
    token: tokenField,
    deviceId: creds.deviceId,
    refreshToken: refreshTokenField,
    encrypted,
    caPath: creds.caPath,
    fingerprint: creds.fingerprint,
  };

  fs.writeFileSync(p, JSON.stringify(payload, null, 2), { mode: 0o600 });
  if (!encrypted) {
    log.warn(`safeStorage unavailable — token written plaintext at ${p}`);
  }
}

export function clearRemoteCredentials(): void {
  const p = storePath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
