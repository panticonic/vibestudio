/**
 * remoteCredStore — the client-side persistence of a WebRTC remote pairing.
 *
 * Replaces the deleted cleartext `remoteCredentialStore` (URL + CA + TLS
 * fingerprint, §8c). A desktop client that has paired with a remote server over
 * WebRTC persists, encrypted at rest:
 *   - the pairing material (`room`/`fp`/`sig`/`ice`/`srv`) MINUS the one-time
 *     `code` (consumed at pairing), so it can re-dial the same answerer, and
 *   - the durable device credential (`deviceId` + `refreshToken`) the server
 *     issued, so it can re-authenticate without re-pairing (`refresh:…`).
 *
 * The store logic is pure (path + cipher injected) so it is unit-testable
 * without Electron; the service layer binds `app.getPath('userData')` +
 * `safeStorage`. The refresh secret is the only durable secret on the client,
 * so it is never written in plaintext.
 */

import type { ConnectPairing } from "@vibestudio/shared/connect";
import {
  createEncryptedJsonStore,
  type EncryptedJsonStore,
  type StoreCipher,
} from "./encryptedJsonStore.js";

export type { StoreCipher };

/** The pairing material persisted for reconnect (no one-time `code`). */
export type StoredPairing = Omit<ConnectPairing, "code">;

export interface StoredRemote {
  pairing: StoredPairing;
  deviceId: string;
  refreshToken: string;
  label?: string;
  workspaceName?: string;
  serverId?: string;
  pairedAt: number;
}

export type RemoteCredStore = EncryptedJsonStore<StoredRemote>;

function isStoredRemote(value: unknown): value is StoredRemote {
  const v = value as StoredRemote | null | undefined;
  return !!v && !!v.deviceId && !!v.refreshToken && !!v.pairing?.room && !!v.pairing?.fp;
}

/**
 * Create a store backed by a single encrypted file. Reads tolerate a missing or
 * corrupt file (returns null — pair again) but never silently swallow a write
 * failure (the caller must know the credential did not persist). The refresh
 * secret is the only durable client secret and is never written in plaintext.
 */
export function createRemoteCredStore(deps: {
  filePath: string;
  cipher: StoreCipher;
  fs: Pick<
    typeof import("node:fs"),
    "readFileSync" | "writeFileSync" | "mkdirSync" | "rmSync" | "existsSync"
  >;
  dirname: (p: string) => string;
}): RemoteCredStore {
  return createEncryptedJsonStore<StoredRemote>({
    ...deps,
    validate: isStoredRemote,
    secretDescription: "the device refresh credential",
  });
}
