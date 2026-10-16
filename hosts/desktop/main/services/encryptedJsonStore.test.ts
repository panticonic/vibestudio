import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { createEncryptedJsonStore, type StoreCipher } from "./encryptedJsonStore.js";
import { createResilientStoreCipher } from "@vibestudio/credential-client/storeCipher";

const identityCipher: StoreCipher = {
  isAvailable: () => false,
  encrypt: (s) => Buffer.from(s, "utf8"),
  decrypt: (b) => b.toString("utf8"),
};

// A cipher that XORs (stands in for safeStorage: ciphertext != plaintext on disk).
const xorCipher: StoreCipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from([...Buffer.from(s, "utf8")].map((b) => b ^ 0x5a)),
  decrypt: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString("utf8"),
};

interface Sample {
  id: string;
  secret: string;
}

function parseSample(value: unknown): Sample | null {
  const v = value as Sample | null | undefined;
  return !!v && typeof v.id === "string" && typeof v.secret === "string" ? v : null;
}

function makeStore(cipher: StoreCipher) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-encjson-"));
  const filePath = path.join(dir, "nested", "store.json");
  return {
    store: createEncryptedJsonStore<Sample>({
      filePath,
      cipher,
      fs,
      dirname: path.dirname,
      parse: parseSample,
      secretDescription: "the test secret",
    }),
    filePath,
  };
}

const sample: Sample = { id: "abc", secret: "rt-secret-value" };

describe("encryptedJsonStore", () => {
  it("round-trips a value when secure storage is available", () => {
    const { store } = makeStore(xorCipher);
    expect(store.load()).toBeNull();
    store.save(sample);
    expect(store.load()).toEqual(sample);
  });

  it("encrypts at rest (no plaintext secret on disk)", () => {
    const { store, filePath } = makeStore(xorCipher);
    store.save(sample);
    const onDisk = fs.readFileSync(filePath).toString("utf8");
    expect(onDisk).not.toContain("rt-secret-value");
    expect(store.load()).toEqual(sample);
  });

  it("FAILS LOUD with secretDescription: refuses to persist when secure storage is unavailable", () => {
    const { store, filePath } = makeStore(identityCipher);
    expect(() => store.save(sample)).toThrow(/the test secret/);
    expect(() => store.save(sample)).toThrow(/secure storage|plaintext/i);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(store.load()).toBeNull();
  });

  it("clear() removes the persisted value (idempotent)", () => {
    const { store } = makeStore(xorCipher);
    store.save(sample);
    store.clear();
    expect(store.load()).toBeNull();
    store.clear();
  });

  it("treats a corrupt / undecryptable file as absent rather than throwing", () => {
    const { store, filePath } = makeStore(xorCipher);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "not-json{{{");
    expect(store.load()).toBeNull();
  });

  it("returns null when parse rejects the decoded value", () => {
    const { store } = makeStore(xorCipher);
    store.save({ id: "abc" } as unknown as Sample);
    expect(store.load()).toBeNull();
  });
});

describe("createResilientStoreCipher", () => {
  function makeCipher(
    primary?: StoreCipher,
    usePrimary?: () => boolean,
    fsOverride: Partial<typeof fs> = {}
  ) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-resilient-cipher-"));
    return {
      dir,
      keyPath: path.join(dir, "keys", "credential.key"),
      cipher: createResilientStoreCipher({
        primary,
        ...(usePrimary ? { usePrimary } : {}),
        keyPath: path.join(dir, "keys", "credential.key"),
        fs: { ...fs, ...fsOverride },
        dirname: path.dirname,
        randomBytes: crypto.randomBytes,
        createCipheriv: crypto.createCipheriv,
        createDecipheriv: crypto.createDecipheriv,
      }),
    };
  }

  it("uses the OS cipher when selected and available", () => {
    const primary: StoreCipher = {
      isAvailable: () => true,
      encrypt: (value) => Buffer.from(`os:${value}`, "utf8"),
      decrypt: (value) => value.toString("utf8").slice(3),
    };
    const { cipher, keyPath } = makeCipher(primary);
    expect(cipher.isAvailable()).toBe(true);
    const encrypted = cipher.encrypt("secret");
    expect(encrypted.toString("utf8")).toBe("os:secret");
    expect(cipher.decrypt(encrypted)).toBe("secret");
    if (process.platform !== "win32") {
      expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    }
  });

  it("falls back to profile-local AES when the OS cipher is unavailable", () => {
    const { cipher } = makeCipher(identityCipher);
    expect(cipher.isAvailable()).toBe(true);
    const encrypted = cipher.encrypt("secret");
    expect(encrypted.toString("utf8")).not.toContain("secret");
    expect(encrypted.toString("utf8")).toContain("v1-aesgcm");
    expect(cipher.decrypt(encrypted)).toBe("secret");
  });

  it("does not touch an available OS cipher when policy disables it", () => {
    const primary: StoreCipher = {
      isAvailable: vi.fn(() => true),
      encrypt: vi.fn(() => Buffer.from("unexpected")),
      decrypt: vi.fn(() => "unexpected"),
    };
    const { cipher } = makeCipher(primary, () => false);
    const encrypted = cipher.encrypt("secret");
    expect(primary.isAvailable).not.toHaveBeenCalled();
    expect(primary.encrypt).not.toHaveBeenCalled();
    expect(cipher.decrypt(encrypted)).toBe("secret");
  });

  it("falls back when an available OS cipher rejects encryption", () => {
    const primary: StoreCipher = {
      isAvailable: () => true,
      encrypt: () => {
        throw new Error("keyring locked");
      },
      decrypt: () => "unexpected",
    };
    const { cipher } = makeCipher(primary);
    const encrypted = cipher.encrypt("secret");
    expect(encrypted.toString("utf8")).toContain("v1-aesgcm");
    expect(cipher.decrypt(encrypted)).toBe("secret");
  });

  it("publishes only complete keys and preserves a concurrent process's winning key", () => {
    const winningKey = crypto.randomBytes(32);
    const { cipher, keyPath } = makeCipher(undefined, undefined, {
      linkSync: (_source, destination) => {
        fs.writeFileSync(destination, winningKey, { flag: "wx", mode: 0o600 });
        throw Object.assign(new Error("concurrent publication"), { code: "EEXIST" });
      },
    });
    const encrypted = cipher.encrypt("secret");
    expect(fs.readFileSync(keyPath)).toEqual(winningKey);
    expect(cipher.decrypt(encrypted)).toBe("secret");
    expect(fs.readdirSync(path.dirname(keyPath))).toEqual(["credential.key"]);
  });

  it("does not replace a corrupt existing key or accept tampered ciphertext", () => {
    const { cipher, keyPath } = makeCipher();
    const encrypted = JSON.parse(cipher.encrypt("secret").toString());
    const payload = Buffer.from(encrypted.ct, "base64");
    payload[28] = payload[28]! ^ 1;
    encrypted.ct = payload.toString("base64");
    expect(() => cipher.decrypt(Buffer.from(JSON.stringify(encrypted)))).toThrow();
    fs.writeFileSync(keyPath, "corrupt");
    expect(cipher.isAvailable()).toBe(false);
    expect(() => cipher.encrypt("secret")).toThrow(/32 bytes/);
    expect(fs.readFileSync(keyPath, "utf8")).toBe("corrupt");
  });
});
