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
    store: createDeviceCredentialStore({ filePath, cipher, fs }),
    filePath,
    dir,
  };
}

const LOCAL_SERVER_ID = `srv_${"L".repeat(24)}`;
const REMOTE_SERVER_ID = `srv_${"R".repeat(24)}`;
const OTHER_SERVER_ID = `srv_${"O".repeat(24)}`;
const LOCAL_DEVICE_ID = `dev_${"l".repeat(24)}`;
const REMOTE_DEVICE_ID = `dev_${"r".repeat(24)}`;
const LOCAL_REFRESH_TOKEN = "a".repeat(43);
const REMOTE_REFRESH_TOKEN = "b".repeat(43);
const loopback: DeviceCredentialEntry = {
  serverId: LOCAL_SERVER_ID,
  transport: "loopback",
  deviceId: LOCAL_DEVICE_ID,
  refreshToken: LOCAL_REFRESH_TOKEN,
  pairedAt: 1234,
};

const webrtc: DeviceCredentialEntry = {
  serverId: REMOTE_SERVER_ID,
  transport: "webrtc",
  controlPairing: {
    room: "room-control",
    fp: "AA".repeat(32),
    sig: "wss://sig.example/",
    v: 2,
    ice: "all",
  },
  workspacePairing: {
    room: "room-1111",
    fp: "AA".repeat(32),
    sig: "wss://sig.example/",
    v: 2,
    ice: "all",
  },
  workspaceName: "dev",
  deviceId: REMOTE_DEVICE_ID,
  refreshToken: REMOTE_REFRESH_TOKEN,
  pairedAt: 5678,
};

const webrtc2: DeviceCredentialEntry = {
  serverId: OTHER_SERVER_ID,
  transport: "webrtc",
  controlPairing: {
    room: "room-control-2",
    fp: "BB".repeat(32),
    sig: "wss://sig.example/",
    v: 2,
    ice: "all",
  },
  workspacePairing: {
    room: "room-workspace-2",
    fp: "BB".repeat(32),
    sig: "wss://sig.example/",
    v: 2,
    ice: "all",
  },
  workspaceName: "second",
  deviceId: `dev_${"q".repeat(24)}`,
  refreshToken: "c".repeat(43),
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
    expect(onDisk).not.toContain(LOCAL_REFRESH_TOKEN);
    expect(onDisk).not.toContain(REMOTE_REFRESH_TOKEN);
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

  it("fails loud when the credential file is corrupt or undecryptable", () => {
    const { store, filePath } = makeStore(xorCipher);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "not-json{{{");
    expect(() => store.load()).toThrow(/unreadable|canonical schema/u);
    expect(store.exists()).toBe(true);
  });

  it("fails loud for stale document shapes and structurally invalid records", () => {
    const { store, filePath } = makeStore(xorCipher);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      xorCipher.encrypt(JSON.stringify({ [webrtc.serverId]: { ...webrtc, pairedAt: 1.5 } }))
    );
    expect(() => store.load()).toThrow(/unreadable|canonical schema/u);

    expect(() =>
      store.save({
        entries: { [webrtc.serverId]: { ...webrtc, refreshToken: "" } },
      })
    ).toThrow(/non-canonical device credential/u);
    expect(() => store.load()).toThrow(/unreadable|canonical schema/u);
  });

  it("rejects non-issuer credentials, missing pairing fields, and retired fields", () => {
    const { store } = makeStore(xorCipher);
    const colonFingerprint = Array.from({ length: 32 }, () => "AA").join(":");
    const invalidEntries = [
      { [loopback.serverId]: { ...loopback, serverId: "srv_local" } },
      { [loopback.serverId]: { ...loopback, deviceId: "dev_local" } },
      { [loopback.serverId]: { ...loopback, refreshToken: "local-refresh-secret" } },
      {
        [loopback.serverId]: { ...loopback, workspaceId: "retired-workspace-binding" },
      },
      {
        [webrtc.serverId]: {
          ...webrtc,
          workspacePairing: { ...webrtc.workspacePairing, code: "must-not-persist" },
        },
      },
      {
        [webrtc.serverId]: {
          ...webrtc,
          workspacePairing: { ...webrtc.workspacePairing, v: undefined },
        },
      },
      {
        [webrtc.serverId]: {
          ...webrtc,
          workspacePairing: { ...webrtc.workspacePairing, ice: undefined },
        },
      },
      {
        [webrtc.serverId]: {
          ...webrtc,
          workspacePairing: { ...webrtc.workspacePairing, v: 1 },
        },
      },
      {
        [webrtc.serverId]: {
          ...webrtc,
          workspacePairing: { ...webrtc.workspacePairing, fp: colonFingerprint },
        },
      },
      {
        [webrtc.serverId]: {
          ...webrtc,
          workspacePairing: { ...webrtc.workspacePairing, fp: "aa".repeat(32) },
        },
      },
      {
        [webrtc.serverId]: {
          ...webrtc,
          workspacePairing: { ...webrtc.workspacePairing, sig: "wss://sig.example" },
        },
      },
      {
        [webrtc.serverId]: {
          ...webrtc,
          workspacePairing: { ...webrtc.workspacePairing, srv: "remote" },
        },
      },
    ];
    for (const entries of invalidEntries) {
      expect(() => store.save({ entries } as never)).toThrow(/non-canonical device credential/u);
    }
    expect(store.load()).toBeNull();
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
});

describe("parseDeviceCredentialDocument", () => {
  it("rejects non-document values", () => {
    expect(parseDeviceCredentialDocument(null)).toBeNull();
    expect(parseDeviceCredentialDocument([webrtc])).toBeNull();
    expect(parseDeviceCredentialDocument({ notEntries: {} })).toBeNull();
    expect(parseDeviceCredentialDocument({ [webrtc.serverId]: webrtc })).toBeNull();
  });

  it("rejects stale pointers and the entire document when any entry is invalid", () => {
    expect(
      parseDeviceCredentialDocument({
        currentRemoteServerId: "gone",
        entries: { [webrtc.serverId]: webrtc },
      })
    ).toBeNull();
    expect(
      parseDeviceCredentialDocument({
        entries: {
          [webrtc.serverId]: webrtc,
          [LOCAL_SERVER_ID]: { ...loopback, refreshToken: "retired-secret-shape" },
        },
      })
    ).toBeNull();
  });

  it("accepts only the current canonical document", () => {
    const canonical = {
      currentRemoteServerId: "gone",
      entries: { [webrtc.serverId]: webrtc },
    };
    canonical.currentRemoteServerId = webrtc.serverId;
    expect(parseDeviceCredentialDocument(canonical)).toEqual(canonical);
  });
});
