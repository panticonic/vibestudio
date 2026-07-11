import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createDeviceCredentialStore,
  mergeDeviceCredentialEntries,
  type DeviceCredentialEntry,
  type PendingLoopbackPairing,
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
  };
}

const LOCAL_SERVER_ID = `srv_${"L".repeat(24)}`;
const REMOTE_SERVER_ID = `srv_${"R".repeat(24)}`;
const OTHER_SERVER_ID = `srv_${"O".repeat(24)}`;
const LOCAL_DEVICE_ID = `dev_${"l".repeat(24)}`;
const REMOTE_DEVICE_ID = `dev_${"r".repeat(24)}`;
const LOCAL_REFRESH_TOKEN = "a".repeat(43);
const REMOTE_REFRESH_TOKEN = "b".repeat(43);
const pending: PendingLoopbackPairing = {
  serverId: LOCAL_SERVER_ID,
  transport: "pending-loopback",
  deviceId: LOCAL_DEVICE_ID,
  refreshToken: LOCAL_REFRESH_TOKEN,
  inviteCode: "P".repeat(32),
  preparedAt: 1_000,
  expiresAt: 61_000,
  label: "Local desktop",
};

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

describe("deviceCredentialStore", () => {
  it("round-trips loopback and WebRTC entries keyed by server id", () => {
    const { store } = makeStore(xorCipher);
    expect(store.load()).toBeNull();
    store.save({ [loopback.serverId]: loopback, [webrtc.serverId]: webrtc });
    expect(store.load()).toEqual({ [loopback.serverId]: loopback, [webrtc.serverId]: webrtc });
  });

  it("round-trips the encrypted prepare-before-consume local pairing state", () => {
    const { store } = makeStore(xorCipher);
    store.save({ [pending.serverId]: pending });
    expect(store.load()).toEqual({ [pending.serverId]: pending });
  });

  it("merges workspace-local legacy snapshots by freshness", () => {
    const newerLoopback = { ...loopback, pairedAt: loopback.pairedAt + 10 };
    expect(
      mergeDeviceCredentialEntries([
        { [loopback.serverId]: loopback },
        { [newerLoopback.serverId]: newerLoopback },
      ])
    ).toEqual({ [newerLoopback.serverId]: newerLoopback });
  });

  it("keeps only the newest remote while preserving non-remote fallbacks", () => {
    const otherLoopback = { ...loopback, serverId: OTHER_SERVER_ID };
    const olderRemote = {
      ...webrtc,
      serverId: OTHER_SERVER_ID,
      pairedAt: webrtc.pairedAt - 1,
    };

    expect(
      mergeDeviceCredentialEntries([
        { [otherLoopback.serverId]: otherLoopback },
        { [olderRemote.serverId]: olderRemote },
        { [webrtc.serverId]: webrtc },
      ])
    ).toEqual({
      [otherLoopback.serverId]: otherLoopback,
      [webrtc.serverId]: webrtc,
    });
  });

  it("encrypts at rest", () => {
    const { store, filePath } = makeStore(xorCipher);
    store.save({ [loopback.serverId]: loopback, [webrtc.serverId]: webrtc });
    const onDisk = fs.readFileSync(filePath, "utf8");
    expect(onDisk).not.toContain(LOCAL_REFRESH_TOKEN);
    expect(onDisk).not.toContain(REMOTE_REFRESH_TOKEN);
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

    fs.writeFileSync(
      filePath,
      xorCipher.encrypt(JSON.stringify({ [webrtc.serverId]: { ...webrtc, pairedAt: 1.5 } }))
    );
    expect(store.load()).toBeNull();

    expect(() =>
      store.save({
        [webrtc.serverId]: { ...webrtc, refreshToken: "" },
      })
    ).toThrow(/non-canonical device credential/u);
    expect(store.load()).toBeNull();
  });

  it("rejects non-issuer credentials, missing pairing fields, retired fields, and ambiguity", () => {
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
          workspacePairing: { ...webrtc.workspacePairing, srv: " remote " },
        },
      },
      {
        [webrtc.serverId]: webrtc,
        [OTHER_SERVER_ID]: {
          ...webrtc,
          serverId: OTHER_SERVER_ID,
          workspacePairing: { ...webrtc.workspacePairing, room: "other-room" },
        },
      },
    ];
    for (const entries of invalidEntries) {
      expect(() => store.save(entries as never)).toThrow(/non-canonical device credential/u);
    }
    expect(store.load()).toBeNull();
  });

  it("clear removes the credential file", () => {
    const { store } = makeStore(xorCipher);
    store.save({ [webrtc.serverId]: webrtc });
    store.clear();
    expect(store.load()).toBeNull();
  });
});
