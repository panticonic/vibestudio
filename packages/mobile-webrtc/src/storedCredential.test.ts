import { describe, expect, it } from "vitest";
import {
  createPairedMobileConnection,
  createRoutedMobileConnection,
  parseStoredMobileConnection,
  selectMobileConnectionWorkspace,
} from "./storedCredential.js";

const pairing = {
  room: "room-1111",
  fp: "AA".repeat(32),
  sig: "wss://signal.example/",
  v: 3 as const,
  ice: "all" as const,
  code: "C".repeat(32),
  exp: 2_000_000_000_000,
};
const reconnectReach = {
  room: pairing.room,
  fp: pairing.fp,
  sig: pairing.sig,
  v: pairing.v,
  ice: pairing.ice,
};
const DEVICE_ID = `dev_${"d".repeat(24)}`;
const REFRESH_TOKEN = "r".repeat(43);

describe("mobile stored shell credential", () => {
  it("switches workspaces without a fresh pairing code", () => {
    const routed = createRoutedMobileConnection(
      createPairedMobileConnection(
        { deviceId: DEVICE_ID, refreshToken: REFRESH_TOKEN },
        pairing,
        "ws-one",
        123
      ),
      reconnectReach
    );

    // The stored pairing has no `code` or `exp` — it was consumed at pairing
    // time — so switching must not route back through the fresh-pairing path.
    const switched = selectMobileConnectionWorkspace(routed, "ws-two");

    expect(switched).toEqual({
      schemaVersion: 4,
      phase: "paired",
      credential: { deviceId: DEVICE_ID, refreshToken: REFRESH_TOKEN },
      controlPairing: routed.controlPairing,
      selectedWorkspaceId: "ws-two",
      pairedAt: 123,
    });
    // The reach that addressed the workspace being left must not survive.
    expect(switched).not.toHaveProperty("workspacePairing");
    // A round trip through storage still parses, so the switch is persistable.
    expect(parseStoredMobileConnection(JSON.stringify(switched))).toEqual(switched);
  });

  it("keeps switching idempotent for the already-selected workspace", () => {
    const paired = createPairedMobileConnection(
      { deviceId: DEVICE_ID, refreshToken: REFRESH_TOKEN },
      pairing,
      "ws-one",
      123
    );

    expect(selectMobileConnectionWorkspace(paired, "ws-one")).toEqual(paired);
  });

  it("round-trips the paired checkpoint without accepting a workspace reach", () => {
    const paired = createPairedMobileConnection(
      { deviceId: DEVICE_ID, refreshToken: REFRESH_TOKEN },
      pairing,
      "ws-one",
      123
    );
    expect(parseStoredMobileConnection(JSON.stringify(paired))).toEqual(paired);
    expect(
      parseStoredMobileConnection(JSON.stringify({ ...paired, workspacePairing: pairing }))
    ).toBeNull();
    expect(
      parseStoredMobileConnection(
        JSON.stringify({ ...paired, phase: "routed", workspacePairing: undefined })
      )
    ).toBeNull();
  });

  it("canonicalizes current issuer coordinates and round-trips without the one-time code", () => {
    const issuerPairing = {
      ...pairing,
      fp: Array.from({ length: 32 }, () => "AA").join(":"),
      sig: "wss://signal.example",
    };
    const paired = createPairedMobileConnection(
      { deviceId: DEVICE_ID, refreshToken: REFRESH_TOKEN },
      issuerPairing,
      "ws-one",
      123
    );
    const stored = createRoutedMobileConnection(paired, {
      ...reconnectReach,
      fp: issuerPairing.fp,
      sig: issuerPairing.sig,
    });
    expect(stored).not.toHaveProperty("controlPairing.code");
    expect(stored).not.toHaveProperty("workspacePairing.code");
    expect(stored.workspacePairing).toMatchObject({
      fp: "AA".repeat(32),
      sig: "wss://signal.example/",
      v: 3,
      ice: "all",
    });
    expect(stored).toMatchObject({
      schemaVersion: 4,
      phase: "routed",
      selectedWorkspaceId: "ws-one",
    });
    expect(parseStoredMobileConnection(JSON.stringify(stored))).toEqual(stored);
  });

  it("rejects unversioned, old-version, extra-field, and code-bearing records", () => {
    const current = createRoutedMobileConnection(
      createPairedMobileConnection(
        { deviceId: DEVICE_ID, refreshToken: REFRESH_TOKEN },
        pairing,
        "ws-one",
        123
      ),
      reconnectReach
    );
    for (const stale of [
      { ...current, schemaVersion: undefined },
      { ...current, schemaVersion: 1 },
      { ...current, phase: undefined },
      { ...current, selectedWorkspaceId: undefined },
      { ...current, credential: undefined },
      { ...current, workspaceId: "retired-binding" },
      { ...current, credential: { ...current.credential, deviceId: "dev-1" } },
      { ...current, credential: { ...current.credential, refreshToken: "refresh-token" } },
      { ...current, pairedAt: 0 },
      { ...current, pairedAt: 1.5 },
      {
        ...current,
        workspacePairing: { ...current.workspacePairing, code: "must-not-persist" },
      },
      { ...current, controlPairing: undefined },
      { ...current, workspacePairing: { ...current.workspacePairing, v: 1 } },
      { ...current, workspacePairing: { ...current.workspacePairing, v: undefined } },
      { ...current, workspacePairing: { ...current.workspacePairing, ice: undefined } },
      { ...current, workspacePairing: { ...current.workspacePairing, unknown: true } },
      {
        ...current,
        workspacePairing: {
          ...current.workspacePairing,
          fp: Array.from({ length: 32 }, () => "AA").join(":"),
        },
      },
      { ...current, workspacePairing: { ...current.workspacePairing, fp: "aa".repeat(32) } },
      {
        ...current,
        workspacePairing: { ...current.workspacePairing, sig: "wss://signal.example" },
      },
      { ...current, workspacePairing: { ...current.workspacePairing, srv: "server" } },
    ]) {
      expect(parseStoredMobileConnection(JSON.stringify(stale))).toBeNull();
    }
    expect(parseStoredMobileConnection("{truncated")).toBeNull();
    expect(parseStoredMobileConnection(JSON.stringify([]))).toBeNull();
  });

  it("rejects retired schema-v3 records", () => {
    const legacy = {
      schemaVersion: 3,
      deviceId: DEVICE_ID,
      refreshToken: REFRESH_TOKEN,
      controlPairing: createPairedMobileConnection(
        { deviceId: DEVICE_ID, refreshToken: REFRESH_TOKEN },
        pairing,
        "unused",
        123
      ).controlPairing,
      workspacePairing: createRoutedMobileConnection(
        createPairedMobileConnection(
          { deviceId: DEVICE_ID, refreshToken: REFRESH_TOKEN },
          pairing,
          "unused",
          123
        ),
        reconnectReach
      ).workspacePairing,
      pairedAt: 123,
    };
    expect(parseStoredMobileConnection(JSON.stringify(legacy))).toBeNull();
    expect(parseStoredMobileConnection(JSON.stringify({ ...legacy, phase: "routed" }))).toBeNull();
  });

  it("refuses to create records from non-issuer credentials or incomplete pairings", () => {
    expect(() =>
      createPairedMobileConnection(
        { deviceId: "dev-1", refreshToken: REFRESH_TOKEN },
        pairing,
        "ws-one",
        123
      )
    ).toThrow(/current issuer/u);
    expect(() =>
      createPairedMobileConnection(
        { deviceId: DEVICE_ID, refreshToken: "refresh-token" },
        pairing,
        "ws-one",
        123
      )
    ).toThrow(/current issuer/u);
    expect(() =>
      createPairedMobileConnection(
        { deviceId: DEVICE_ID, refreshToken: REFRESH_TOKEN, retired: true } as never,
        pairing,
        "ws-one",
        123
      )
    ).toThrow(/current issuer/u);
    expect(() =>
      createPairedMobileConnection(
        { deviceId: DEVICE_ID, refreshToken: REFRESH_TOKEN },
        { ...pairing, v: undefined } as never,
        "ws-one",
        123
      )
    ).toThrow(/control WebRTC pairing: has an unsupported protocol version/u);
    expect(() =>
      createPairedMobileConnection(
        { deviceId: DEVICE_ID, refreshToken: REFRESH_TOKEN },
        { ...pairing, ice: undefined } as never,
        "ws-one",
        123
      )
    ).toThrow(/control WebRTC pairing: has an invalid ICE transport policy/u);
    expect(() =>
      createPairedMobileConnection(
        { deviceId: DEVICE_ID, refreshToken: REFRESH_TOKEN },
        { ...pairing, retired: true } as never,
        "ws-one",
        123
      )
    ).toThrow(/control WebRTC pairing: contains unexpected field\(s\): retired/u);
  });
});
