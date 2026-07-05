import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createLocalServerCredStore,
  type LocalServerCredential,
  type StoreCipher,
} from "./localServerCredStore.js";

// A cipher that XORs (stands in for safeStorage: ciphertext != plaintext on disk).
const xorCipher: StoreCipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from([...Buffer.from(s, "utf8")].map((b) => b ^ 0x5a)),
  decrypt: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString("utf8"),
};

const unavailableCipher: StoreCipher = {
  isAvailable: () => false,
  encrypt: (s) => Buffer.from(s, "utf8"),
  decrypt: (b) => b.toString("utf8"),
};

function makeStore(cipher: StoreCipher) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-localsrv-cred-"));
  const filePath = path.join(dir, "nested", "local-server-creds.json");
  return {
    store: createLocalServerCredStore({ filePath, cipher, fs, dirname: path.dirname }),
    filePath,
  };
}

const cred: LocalServerCredential = {
  deviceId: "dev_abc",
  refreshToken: "rt-secret-value",
  serverId: "srv-1",
  pairedAt: 1234,
};

describe("localServerCredStore", () => {
  it("round-trips a map of workspace credentials", () => {
    const { store } = makeStore(xorCipher);
    expect(store.load()).toBeNull();
    store.save({ ws1: cred });
    expect(store.load()).toEqual({ ws1: cred });
  });

  it("encrypts at rest (no plaintext refresh token on disk)", () => {
    const { store, filePath } = makeStore(xorCipher);
    store.save({ ws1: cred });
    const onDisk = fs.readFileSync(filePath).toString("utf8");
    expect(onDisk).not.toContain("rt-secret-value");
  });

  it("FAILS LOUD: refuses to persist when secure storage is unavailable", () => {
    const { store, filePath } = makeStore(unavailableCipher);
    expect(() => store.save({ ws1: cred })).toThrow(/local server device credential/);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(store.load()).toBeNull();
  });

  it("rejects entries missing string deviceId/refreshToken", () => {
    const { store } = makeStore(xorCipher);
    store.save({ ws1: { serverId: "x", pairedAt: 1 } as unknown as LocalServerCredential });
    expect(store.load()).toBeNull();
  });

  it("clear() removes the persisted map", () => {
    const { store } = makeStore(xorCipher);
    store.save({ ws1: cred });
    store.clear();
    expect(store.load()).toBeNull();
  });
});
