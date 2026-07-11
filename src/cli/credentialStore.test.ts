import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  credentialPath,
  loadCliCredentials,
  saveCliCredentials,
  type CliCredentials,
} from "./credentialStore.js";

const CURRENT: CliCredentials = {
  schemaVersion: 3,
  kind: "device",
  url: "webrtc://room-current/_workspace/dev",
  workspaceName: "dev",
  serverId: `srv_${"s".repeat(24)}`,
  deviceId: `dev_${"d".repeat(24)}`,
  refreshToken: "r".repeat(43),
  controlPairing: {
    room: "room-control",
    fp: "AA".repeat(32),
    sig: "wss://signal.example/",
    v: 2,
    ice: "all",
  },
  workspacePairing: {
    room: "room-current",
    fp: "AA".repeat(32),
    sig: "wss://signal.example/",
    v: 2,
    ice: "all",
  },
  pairedAt: 1,
};

describe("CLI persisted device credential", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-cli-credential-"));
    vi.stubEnv("HOME", home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  function write(value: unknown): void {
    fs.mkdirSync(path.dirname(credentialPath()), { recursive: true });
    fs.writeFileSync(credentialPath(), typeof value === "string" ? value : JSON.stringify(value));
  }

  it("round-trips only the exact canonical schema", () => {
    saveCliCredentials(CURRENT);
    expect(loadCliCredentials()).toEqual(CURRENT);
    if (process.platform !== "win32") {
      expect(fs.statSync(credentialPath()).mode & 0o777).toBe(0o600);
    }
  });

  it("returns null for truncated, unreadable, old, ambiguous, or non-canonical records", () => {
    const colonFingerprint = Array.from({ length: 32 }, () => "AA").join(":");
    for (const invalid of [
      "{truncated",
      null,
      [],
      { ...CURRENT, schemaVersion: 1 },
      { ...CURRENT, unknown: true },
      { ...CURRENT, serverId: "srv_old" },
      { ...CURRENT, deviceId: "dev_old" },
      { ...CURRENT, refreshToken: "old-token" },
      { ...CURRENT, url: "webrtc://room-current/_workspace/other" },
      { ...CURRENT, workspaceName: "../dev" },
      { ...CURRENT, pairedAt: 1.5 },
      {
        ...CURRENT,
        workspacePairing: { ...CURRENT.workspacePairing, code: "C".repeat(32) },
      },
      { ...CURRENT, controlPairing: undefined },
      { ...CURRENT, workspacePairing: { ...CURRENT.workspacePairing, v: undefined } },
      { ...CURRENT, workspacePairing: { ...CURRENT.workspacePairing, ice: undefined } },
      { ...CURRENT, workspacePairing: { ...CURRENT.workspacePairing, fp: colonFingerprint } },
      { ...CURRENT, workspacePairing: { ...CURRENT.workspacePairing, fp: "aa".repeat(32) } },
      {
        ...CURRENT,
        workspacePairing: { ...CURRENT.workspacePairing, sig: "wss://signal.example" },
      },
      { ...CURRENT, workspacePairing: { ...CURRENT.workspacePairing, srv: " server " } },
    ]) {
      write(invalid);
      expect(loadCliCredentials()).toBeNull();
    }

    fs.rmSync(credentialPath(), { force: true });
    fs.mkdirSync(credentialPath(), { recursive: true });
    expect(loadCliCredentials()).toBeNull();
  });

  it("rejects invalid writes without replacing the valid credential", () => {
    saveCliCredentials(CURRENT);
    const before = fs.readFileSync(credentialPath());
    expect(() => saveCliCredentials(null as never)).toThrow(/non-canonical CLI device credential/u);
    expect(() => saveCliCredentials({ ...CURRENT, workspacePairing: undefined } as never)).toThrow(
      /non-canonical CLI device credential/u
    );
    expect(() =>
      saveCliCredentials({
        ...CURRENT,
        workspacePairing: { ...CURRENT.workspacePairing, sig: "wss://signal.example" },
      })
    ).toThrow(/non-canonical CLI device credential/u);
    expect(fs.readFileSync(credentialPath())).toEqual(before);
  });
});
