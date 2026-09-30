/** Cipher seam — Electron `safeStorage` in production, identity in tests. */
export interface StoreCipher {
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Buffer): string;
  isAvailable(): boolean;
}

interface CipherEnvelope {
  v: "v1-aesgcm";
  ct: string;
}

function isCipherEnvelope(value: unknown): value is CipherEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record["v"] === "v1-aesgcm" &&
    typeof record["ct"] === "string" &&
    Object.keys(record).every((key) => key === "v" || key === "ct")
  );
}

/**
 * Prefer an OS cipher when it is appropriate for this process, with a
 * non-interactive profile-local AES fallback. The fallback protects against
 * casual disclosure of ciphertext, not an attacker who can read the whole
 * profile (the key and ciphertext deliberately share that trust boundary).
 */
export function createResilientStoreCipher(deps: {
  primary?: StoreCipher;
  usePrimary?: () => boolean;
  keyPath: string;
  fs: Pick<
    typeof import("node:fs"),
    | "chmodSync"
    | "closeSync"
    | "existsSync"
    | "fsyncSync"
    | "mkdirSync"
    | "linkSync"
    | "openSync"
    | "readFileSync"
    | "writeFileSync"
    | "unlinkSync"
  >;
  dirname: (path: string) => string;
  randomBytes: (size: number) => Buffer;
  createCipheriv: typeof import("node:crypto").createCipheriv;
  createDecipheriv: typeof import("node:crypto").createDecipheriv;
}): StoreCipher {
  const primaryAvailable = (): boolean => {
    if (!deps.primary || deps.usePrimary?.() === false) return false;
    try {
      return deps.primary.isAvailable();
    } catch {
      return false;
    }
  };

  const loadOrCreateLocalKey = (): Buffer => {
    const read = (): Buffer | null => {
      if (!deps.fs.existsSync(deps.keyPath)) return null;
      const key = deps.fs.readFileSync(deps.keyPath);
      if (key.length !== 32) throw new Error("Profile credential key must contain 32 bytes");
      return key;
    };
    const existing = read();
    if (existing) return existing;

    const directory = deps.dirname(deps.keyPath);
    deps.fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") deps.fs.chmodSync(directory, 0o700);
    const key = deps.randomBytes(32);
    const temporaryPath = `${deps.keyPath}.${process.pid}.${deps.randomBytes(8).toString("hex")}.tmp`;
    const fd = deps.fs.openSync(temporaryPath, "wx", 0o600);
    try {
      deps.fs.writeFileSync(fd, key);
      deps.fs.fsyncSync(fd);
      // Publish a complete key atomically without replacing another process's
      // key. A racing reader must never observe a partially written key.
      deps.fs.linkSync(temporaryPath, deps.keyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const concurrentlyCreated = read();
        if (concurrentlyCreated) return concurrentlyCreated;
      }
      throw error;
    } finally {
      deps.fs.closeSync(fd);
      deps.fs.unlinkSync(temporaryPath);
    }
    if (process.platform !== "win32") deps.fs.chmodSync(deps.keyPath, 0o600);
    return key;
  };

  const encryptLocally = (plaintext: string): Buffer => {
    const iv = deps.randomBytes(12);
    const cipher = deps.createCipheriv("aes-256-gcm", loadOrCreateLocalKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const envelope: CipherEnvelope = {
      v: "v1-aesgcm",
      ct: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64"),
    };
    return Buffer.from(JSON.stringify(envelope), "utf8");
  };

  return {
    isAvailable: () => {
      try {
        // Pairing preflight must prove the non-interactive fallback itself is
        // writable. Merely observing an OS backend does not prove that a later
        // encrypt call will not be denied, locked, or temporarily unavailable.
        loadOrCreateLocalKey();
        return true;
      } catch {
        return false;
      }
    },
    encrypt: (plaintext) => {
      if (primaryAvailable()) {
        try {
          // Keep the OS backend's native format, including existing pairings.
          return deps.primary!.encrypt(plaintext);
        } catch {
          // A locked or temporarily unavailable OS store must not make pairing
          // unusable. The tagged local envelope remains independently readable.
        }
      }
      return encryptLocally(plaintext);
    },
    decrypt: (ciphertext) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(ciphertext.toString("utf8"));
      } catch {
        parsed = null;
      }
      if (!isCipherEnvelope(parsed)) {
        if (!primaryAvailable()) throw new Error("OS credential cipher is unavailable");
        return deps.primary!.decrypt(ciphertext);
      }
      const encoded = Buffer.from(parsed.ct, "base64");
      if (encoded.length < 28) throw new Error("Corrupt local credential cipher envelope");
      const decipher = deps.createDecipheriv(
        "aes-256-gcm",
        loadOrCreateLocalKey(),
        encoded.subarray(0, 12)
      );
      decipher.setAuthTag(encoded.subarray(12, 28));
      return Buffer.concat([decipher.update(encoded.subarray(28)), decipher.final()]).toString(
        "utf8"
      );
    },
  };
}
