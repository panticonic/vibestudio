/**
 * encryptedJsonStore — a generic, single-file encrypted-at-rest JSON store.
 *
 * The durable-secret persistence primitive shared by the client-side credential
 * stores (currently the unified device credential store). The store logic is pure (path,
 * cipher, fs, dirname, and a parser injected) so it is unit-testable without
 * Electron; a service layer binds `app.getPath('userData')` + `safeStorage`.
 *
 * Reads tolerate a missing / cipher-unavailable / corrupt / invalid file (return
 * null — the caller re-establishes) but writes NEVER silently swallow a failure
 * and NEVER write plaintext: `save` throws loudly when the cipher is unavailable,
 * so a durable secret is never leaked to disk in the clear.
 *
 * Writes are ATOMIC (tmp + fsync + rename, mirroring webrtc/cert.ts): a crash
 * mid-write can never leave a half-written file that would decrypt-fail and wipe
 * every stored secret. The injected `parse` may SANITIZE — it can drop individual
 * invalid records while keeping the valid ones — so one stale-schema entry never
 * discards the whole file.
 */

/** Cipher seam — Electron `safeStorage` in production, identity in tests. */
export interface StoreCipher {
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Buffer): string;
  isAvailable(): boolean;
}

export interface EncryptedJsonStore<T> {
  load(): T | null;
  /** True iff a store file is present on disk (regardless of readability). */
  exists(): boolean;
  save(value: T): void;
  clear(): void;
}

/** The fs surface the store needs — a subset of `node:fs` (sync API only). */
export type StoreFs = Pick<
  typeof import("node:fs"),
  | "readFileSync"
  | "writeFileSync"
  | "mkdirSync"
  | "rmSync"
  | "existsSync"
  | "renameSync"
  | "openSync"
  | "fsyncSync"
  | "closeSync"
>;

/**
 * Create a store backed by a single encrypted file. Reads tolerate a missing or
 * corrupt file (returns null) but never silently swallow a write failure (the
 * caller must know the secret did not persist).
 */
export function createEncryptedJsonStore<T>(deps: {
  filePath: string;
  cipher: StoreCipher;
  fs: StoreFs;
  dirname: (p: string) => string;
  /**
   * Validate/normalize a decoded JSON value. Return the (possibly sanitized)
   * value, or null if it is not usable at all. Sanitizing (dropping invalid
   * sub-records while keeping valid ones) is preferred over rejecting wholesale,
   * so one stale entry never discards every stored secret.
   */
  parse: (value: unknown) => T | null;
  secretDescription: string;
}): EncryptedJsonStore<T> {
  const { filePath, cipher, fs, dirname, parse, secretDescription } = deps;
  return {
    load(): T | null {
      if (!fs.existsSync(filePath)) return null;
      // We never write plaintext (see save), so without the cipher we cannot read a
      // legitimately-stored secret — treat as absent rather than attempt a plaintext
      // parse (which would only succeed on an insecure legacy file).
      if (!cipher.isAvailable()) return null;
      try {
        const raw = fs.readFileSync(filePath);
        const json = cipher.decrypt(raw);
        const value = JSON.parse(json) as unknown;
        return parse(value);
      } catch {
        // Corrupt / undecryptable (e.g. OS keychain reset) ⇒ treat as absent.
        return null;
      }
    },
    exists(): boolean {
      return fs.existsSync(filePath);
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
      fs.mkdirSync(dirname(filePath), { recursive: true });
      // Atomic: write a tmp file, fsync it, then rename over the target. A crash
      // mid-write leaves the tmp behind (garbage) but never a truncated target —
      // so a half-write can't wipe every stored server's pairing.
      const tmp = `${filePath}.${process.pid}.${Date.now().toString(36)}.tmp`;
      const fd = fs.openSync(tmp, "w", 0o600);
      try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, filePath);
    },
    clear(): void {
      if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
    },
  };
}
