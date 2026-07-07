import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createDeviceCredentialStore,
  type DeviceCredentialEntry,
  type StoreCipher,
} from "./deviceCredentialStore.js";

const unavailableCipher: StoreCipher = {
  isAvailable: () => false,
  encrypt: (s) => Buffer.from(s, "utf8"),
  decrypt: (b) => b.toString("utf8"),
};

const xorCipher: StoreCipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from([...Buffer.from(s, "utf8")].map((b) => b ^ 0x5a)),
  decrypt: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString("utf8"),
};

function makeStore(cipher: StoreCipher) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-device-cred-"));
  const filePath = path.join(dir, "nested", "device-credentials.json");
  return {
    store: createDeviceCredentialStore({ filePath, cipher, fs, dirname: path.dirname }),
    filePath,
  };
}

const loopback: DeviceCredentialEntry = {
  serverId: "srv_local",
  transport: "loopback",
  workspaceId: "ws1",
  deviceId: "dev_local",
  refreshToken: "local-refresh-secret",
  pairedAt: 1234,
};

const webrtc: DeviceCredentialEntry = {
  serverId: "srv_remote",
  transport: "webrtc",
  pairing: {
    room: "room-1",
    fp: "AA".repeat(32),
    sig: "wss://sig.example/",
    ice: "all",
  },
  deviceId: "dev_remote",
  refreshToken: "remote-refresh-secret",
  pairedAt: 5678,
};

describe("deviceCredentialStore", () => {
  it("round-trips loopback and WebRTC entries keyed by server id", () => {
    const { store } = makeStore(xorCipher);
    expect(store.load()).toBeNull();
    store.save({ [loopback.serverId]: loopback, [webrtc.serverId]: webrtc });
    expect(store.load()).toEqual({ [loopback.serverId]: loopback, [webrtc.serverId]: webrtc });
  });

  it("encrypts at rest", () => {
    const { store, filePath } = makeStore(xorCipher);
    store.save({ [loopback.serverId]: loopback, [webrtc.serverId]: webrtc });
    const onDisk = fs.readFileSync(filePath, "utf8");
    expect(onDisk).not.toContain("local-refresh-secret");
    expect(onDisk).not.toContain("remote-refresh-secret");
  });

  it("fails loud rather than writing plaintext when secure storage is unavailable", () => {
    const { store, filePath } = makeStore(unavailableCipher);
    expect(() => store.save({ [webrtc.serverId]: webrtc })).toThrow(/secure storage|plaintext/i);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(store.load()).toBeNull();
  });

  it("treats corrupt or invalid records as empty", () => {
    const { store, filePath } = makeStore(xorCipher);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "not-json{{{");
    expect(store.load()).toBeNull();

    store.save({
      bad: { ...webrtc, refreshToken: "" },
    });
    expect(store.load()).toBeNull();
  });

  it("clear removes the credential file", () => {
    const { store } = makeStore(xorCipher);
    store.save({ [webrtc.serverId]: webrtc });
    store.clear();
    expect(store.load()).toBeNull();
  });
});
