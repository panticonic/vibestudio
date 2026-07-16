import { describe, expect, it } from "vitest";
import { createStoredShellCredential, parseStoredShellCredential } from "./storedCredential.js";

const pairing = {
  room: "room-1111",
  fp: "AA".repeat(32),
  sig: "wss://signal.example/",
  v: 2 as const,
  ice: "all" as const,
  code: "C".repeat(32),
};
const DEVICE_ID = `dev_${"d".repeat(24)}`;
const REFRESH_TOKEN = "r".repeat(43);

describe("mobile stored shell credential", () => {
  it("canonicalizes current issuer coordinates and round-trips without the one-time code", () => {
    const issuerPairing = {
      ...pairing,
      fp: Array.from({ length: 32 }, () => "AA").join(":"),
      sig: "wss://signal.example",
    };
    const stored = createStoredShellCredential(
      { deviceId: DEVICE_ID, refreshToken: REFRESH_TOKEN },
      issuerPairing,
      issuerPairing,
      123
    );
    expect(stored).not.toHaveProperty("controlPairing.code");
    expect(stored).not.toHaveProperty("workspacePairing.code");
    expect(stored.workspacePairing).toMatchObject({
      fp: "AA".repeat(32),
      sig: "wss://signal.example/",
      v: 2,
      ice: "all",
    });
    expect(parseStoredShellCredential(JSON.stringify(stored))).toEqual(stored);
  });

  it("rejects unversioned, old-version, extra-field, and code-bearing records", () => {
    const current = createStoredShellCredential(
      { deviceId: DEVICE_ID, refreshToken: REFRESH_TOKEN },
      pairing,
      pairing,
      123
    );
    for (const stale of [
      { ...current, schemaVersion: undefined },
      { ...current, schemaVersion: 1 },
      { ...current, workspaceId: "retired-binding" },
      { ...current, deviceId: "dev-1" },
      { ...current, refreshToken: "refresh-token" },
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
      expect(parseStoredShellCredential(JSON.stringify(stale))).toBeNull();
    }
    expect(parseStoredShellCredential("{truncated")).toBeNull();
    expect(parseStoredShellCredential(JSON.stringify([]))).toBeNull();
  });

  it("refuses to create records from non-issuer credentials or incomplete pairings", () => {
    expect(() =>
      createStoredShellCredential(
        { deviceId: "dev-1", refreshToken: REFRESH_TOKEN },
        pairing,
        pairing,
        123
      )
    ).toThrow(/current issuer/u);
    expect(() =>
      createStoredShellCredential(
        { deviceId: DEVICE_ID, refreshToken: "refresh-token" },
        pairing,
        pairing,
        123
      )
    ).toThrow(/current issuer/u);
    expect(() =>
      createStoredShellCredential(
        { deviceId: DEVICE_ID, refreshToken: REFRESH_TOKEN, retired: true } as never,
        pairing,
        pairing,
        123
      )
    ).toThrow(/current issuer/u);
    expect(() =>
      createStoredShellCredential(
        { deviceId: DEVICE_ID, refreshToken: REFRESH_TOKEN },
        { ...pairing, v: undefined } as never,
        pairing,
        123
      )
    ).toThrow(/non-canonical WebRTC pairing/u);
    expect(() =>
      createStoredShellCredential(
        { deviceId: DEVICE_ID, refreshToken: REFRESH_TOKEN },
        { ...pairing, ice: undefined } as never,
        pairing,
        123
      )
    ).toThrow(/non-canonical WebRTC pairing/u);
    expect(() =>
      createStoredShellCredential(
        { deviceId: DEVICE_ID, refreshToken: REFRESH_TOKEN },
        { ...pairing, retired: true } as never,
        pairing,
        123
      )
    ).toThrow(/non-canonical WebRTC pairing/u);
  });
});
