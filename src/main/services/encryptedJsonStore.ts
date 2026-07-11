/**
 * encryptedJsonStore — a generic, single-file encrypted-at-rest JSON store.
 *
 * The durable-secret persistence primitive shared by the client-side credential
 * stores (currently the unified device credential store). The store logic is pure (path,
 * cipher, fs, dirname, and a validator injected) so it is unit-testable without
 * Electron; a service layer binds `app.getPath('userData')` + `safeStorage`.
 *
 * Reads tolerate a missing / cipher-unavailable / corrupt / invalid file (return
 * null — the caller re-establishes) but writes NEVER silently swallow a failure
 * and NEVER write plaintext: `save` throws loudly when the cipher is unavailable,
 * so a durable secret is never leaked to disk in the clear.
 */

/** Cipher seam — Electron `safeStorage` in production, identity in tests. */
import { writeFileAtomicSync, type AtomicWriteFs } from "../../atomicFile.js";

export interface StoreCipher {
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Buffer): string;
  isAvailable(): boolean;
}

export interface EncryptedJsonStore<T> {
  load(): T | null;
  save(value: T): void;
  clear(): void;
}

/**
 * Create a store backed by a single encrypted file. Reads tolerate a missing or
 * corrupt file (returns null) but never silently swallow a write failure (the
 * caller must know the secret did not persist).
 */
export function createEncryptedJsonStore<T>(deps: {
  filePath: string;
  cipher: StoreCipher;
  fs: Pick<typeof import("node:fs"), "readFileSync" | "rmSync" | "existsSync"> & AtomicWriteFs;
  validate: (value: unknown) => value is T;
  secretDescription: string;
}): EncryptedJsonStore<T> {
  const { filePath, cipher, fs, validate, secretDescription } = deps;
  return {
    load(): T | null {
      if (!fs.existsSync(filePath)) return null;
      // We never write plaintext (see save), so without the cipher we cannot read a
      // legitimately-stored secret — treat it as absent. Plaintext is not a
      // supported storage format.
      if (!cipher.isAvailable()) return null;
      try {
        const raw = fs.readFileSync(filePath);
        const json = cipher.decrypt(raw);
        const value = JSON.parse(json) as unknown;
        if (!validate(value)) return null;
        return value;
      } catch {
        // Corrupt / undecryptable (e.g. OS keychain reset) ⇒ treat as absent.
        return null;
      }
    },
    save(value: T): void {
      // Fail loud: the persisted value is a durable secret and MUST NOT be written
      // in plaintext. If OS secure storage (safeStorage) is unavailable (a Linux
      // box with no keyring, or headless), refuse to persist rather than silently
      // writing the secret in the clear. The caller surfaces this instead of
      // leaking the secret.
      if (!cipher.isAvailable()) {
        throw new Error(
          `Refusing to persist ${secretDescription}: OS secure storage (safeStorage) ` +
            "is unavailable, and the secret must never be stored in plaintext."
        );
      }
      const json = JSON.stringify(value);
      const bytes = cipher.encrypt(json);
      writeFileAtomicSync(filePath, bytes, { mode: 0o600, fs });
    },
    clear(): void {
      if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
    },
  };
}
