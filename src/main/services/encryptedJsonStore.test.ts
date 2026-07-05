import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createEncryptedJsonStore, type StoreCipher } from "./encryptedJsonStore.js";

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

function isSample(value: unknown): value is Sample {
  const v = value as Sample | null | undefined;
  return !!v && typeof v.id === "string" && typeof v.secret === "string";
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
      validate: isSample,
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

  it("returns null when validate rejects the decoded value", () => {
    const { store } = makeStore(xorCipher);
    store.save({ id: "abc" } as unknown as Sample);
    expect(store.load()).toBeNull();
  });
});
