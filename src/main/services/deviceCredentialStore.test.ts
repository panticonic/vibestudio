import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createDeviceCredentialStore,
  parseDeviceCredentialDocument,
  selectCurrentRemote,
  type DeviceCredentialDocument,
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
    dir,
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

const webrtc2: DeviceCredentialEntry = {
  serverId: "srv_remote_2",
  transport: "webrtc",
  pairing: {
    room: "room-2",
    fp: "BB".repeat(32),
    sig: "wss://sig.example/",
    ice: "all",
  },
  deviceId: "dev_remote_2",
  refreshToken: "remote-refresh-secret-2",
  pairedAt: 9999,
};

function doc(
  entries: DeviceCredentialEntry[],
  currentRemoteServerId?: string
): DeviceCredentialDocument {
  return {
    ...(currentRemoteServerId ? { currentRemoteServerId } : {}),
    entries: Object.fromEntries(entries.map((e) => [e.serverId, e])),
  };
}

describe("deviceCredentialStore", () => {
  it("round-trips loopback and WebRTC entries keyed by server id", () => {
    const { store } = makeStore(xorCipher);
    expect(store.load()).toBeNull();
    const document = doc([loopback, webrtc], webrtc.serverId);
    store.save(document);
    expect(store.load()).toEqual(document);
  });

  it("encrypts at rest", () => {
    const { store, filePath } = makeStore(xorCipher);
    store.save(doc([loopback, webrtc]));
    const onDisk = fs.readFileSync(filePath, "utf8");
    expect(onDisk).not.toContain("local-refresh-secret");
    expect(onDisk).not.toContain("remote-refresh-secret");
  });

  it("writes atomically (no leftover tmp file, target present)", () => {
    const { store, filePath, dir } = makeStore(xorCipher);
    store.save(doc([webrtc]));
    expect(fs.existsSync(filePath)).toBe(true);
    const leftovers = fs
      .readdirSync(path.dirname(filePath))
      .filter((name) => name.includes(".tmp"));
    expect(leftovers).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fails loud rather than writing plaintext when secure storage is unavailable", () => {
    const { store, filePath } = makeStore(unavailableCipher);
    expect(() => store.save(doc([webrtc]))).toThrow(/secure storage|plaintext/i);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(store.load()).toBeNull();
  });

  it("treats a corrupt (undecryptable) file as absent", () => {
    const { store, filePath } = makeStore(xorCipher);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "not-json{{{");
    expect(store.load()).toBeNull();
    // …but the file IS present — a mutator must NOT reseed from empty over it.
    expect(store.exists()).toBe(true);
  });

  it("drops one invalid entry but KEEPS the valid ones (no whole-file wipe)", () => {
    const { store } = makeStore(xorCipher);
    store.save({
      entries: {
        [webrtc.serverId]: webrtc,
        bad: { ...webrtc, serverId: "bad", refreshToken: "" },
      },
    });
    const loaded = store.load();
    expect(loaded?.entries[webrtc.serverId]).toEqual(webrtc);
    expect(loaded?.entries["bad"]).toBeUndefined();
  });

  it("clear removes the credential file", () => {
    const { store } = makeStore(xorCipher);
    store.save(doc([webrtc]));
    store.clear();
    expect(store.load()).toBeNull();
    expect(store.exists()).toBe(false);
  });
});

describe("selectCurrentRemote", () => {
  it("returns null with no remotes", () => {
    expect(selectCurrentRemote(null)).toBeNull();
    expect(selectCurrentRemote(doc([loopback]))).toBeNull();
  });

  it("returns the pinned current remote (not the oldest) with two paired servers", () => {
    const document = doc([webrtc, webrtc2], webrtc2.serverId);
    expect(selectCurrentRemote(document)?.serverId).toBe(webrtc2.serverId);
  });

  it("falls back to the most recently paired remote when no current is pinned", () => {
    // webrtc2 pairedAt (9999) > webrtc pairedAt (5678).
    expect(selectCurrentRemote(doc([webrtc, webrtc2]))?.serverId).toBe(webrtc2.serverId);
  });

  it("falls back off a stale current pointer to a valid remote", () => {
    const document = doc([webrtc], "srv_does_not_exist");
    expect(selectCurrentRemote(document)?.serverId).toBe(webrtc.serverId);
  });
});

describe("parseDeviceCredentialDocument", () => {
  it("rejects non-document values", () => {
    expect(parseDeviceCredentialDocument(null)).toBeNull();
    expect(parseDeviceCredentialDocument([webrtc])).toBeNull();
    expect(parseDeviceCredentialDocument({ notEntries: {} })).toBeNull();
  });

  it("drops a current pointer that no longer resolves to a valid remote", () => {
    const parsed = parseDeviceCredentialDocument({
      currentRemoteServerId: "gone",
      entries: { [webrtc.serverId]: webrtc },
    });
    expect(parsed?.currentRemoteServerId).toBeUndefined();
    expect(parsed?.entries[webrtc.serverId]).toEqual(webrtc);
  });
});
