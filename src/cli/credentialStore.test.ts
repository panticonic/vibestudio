import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertCliProfileIsUnpaired,
  credentialPath,
  loadCliCredentials,
  saveCliCredentials,
  type CliIrohAgentCredentials,
  type CliIrohDeviceCredentials,
} from "./credentialStore.js";

const CURRENT: CliIrohDeviceCredentials = {
  schemaVersion: 5,
  kind: "device",
  url: `iroh://${"bb".repeat(32)}/_workspace/dev`,
  workspaceId: "workspace-dev",
  workspaceName: "dev",
  serverId: `srv_${"s".repeat(24)}`,
  deviceId: `dev_${"d".repeat(24)}`,
  refreshToken: "r".repeat(43),
  transport: "iroh",
  endpointSecret: "E".repeat(43),
  controlPairing: {
    endpointId: "aa".repeat(32),
    relays: ["https://relay.example/"],
    v: 4,
  },
  workspacePairing: {
    endpointId: "bb".repeat(32),
    relays: ["https://relay.example/"],
    v: 4,
  },
  pairedAt: 1,
};

const AGENT: CliIrohAgentCredentials = {
  schemaVersion: 2,
  kind: "agent",
  url: `iroh://${"bb".repeat(32)}/_workspace/dev`,
  workspaceId: "workspace-dev",
  workspaceName: "dev",
  serverId: `srv_${"s".repeat(24)}`,
  entityId: "session:channel-one",
  contextId: "context-one",
  agentId: `agt_${"a".repeat(24)}`,
  agentToken: `agent:agt_${"a".repeat(24)}:${"t".repeat(43)}`,
  transport: "iroh",
  endpointSecret: "F".repeat(43),
  workspacePairing: CURRENT.workspacePairing,
  signedInAt: 2,
};

describe("CLI persisted device credential", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-cli-credential-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", path.join(home, ".config"));
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

  it("round-trips an entity-scoped agent login without a human device identity", () => {
    saveCliCredentials(AGENT);
    expect(loadCliCredentials()).toEqual(AGENT);
    expect(loadCliCredentials()).not.toHaveProperty("deviceId");
    expect(loadCliCredentials()).not.toHaveProperty("refreshToken");
    expect(loadCliCredentials()).not.toHaveProperty("controlPairing");
    if (process.platform !== "win32") {
      expect(fs.statSync(credentialPath()).mode & 0o777).toBe(0o600);
    }
  });

  it("returns null for truncated, unreadable, old, ambiguous, or non-canonical records", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const invalid of [
      "{truncated",
      null,
      [],
      { ...CURRENT, schemaVersion: 1 },
      { ...CURRENT, unknown: true },
      { ...CURRENT, workspaceId: "" },
      { ...CURRENT, workspaceId: " workspace-dev " },
      { ...CURRENT, serverId: "srv_old" },
      { ...CURRENT, deviceId: "dev_old" },
      { ...CURRENT, refreshToken: "old-token" },
      { ...CURRENT, url: `iroh://${"bb".repeat(32)}/_workspace/other` },
      { ...CURRENT, workspaceName: "../dev" },
      { ...CURRENT, pairedAt: 1.5 },
      {
        ...CURRENT,
        workspacePairing: { ...CURRENT.workspacePairing, code: "C".repeat(32) },
      },
      { ...CURRENT, controlPairing: undefined },
      { ...CURRENT, workspacePairing: { ...CURRENT.workspacePairing, v: undefined } },
      { ...CURRENT, workspacePairing: { ...CURRENT.workspacePairing, relays: undefined } },
      {
        ...CURRENT,
        workspacePairing: { ...CURRENT.workspacePairing, endpointId: "AA".repeat(32) },
      },
      { ...CURRENT, workspacePairing: { ...CURRENT.workspacePairing, endpointId: "aa" } },
      {
        ...CURRENT,
        workspacePairing: { ...CURRENT.workspacePairing, relays: ["http://relay.example/"] },
      },
      { ...CURRENT, workspacePairing: { ...CURRENT.workspacePairing, srv: "server" } },
      { ...AGENT, agentId: `agt_${"b".repeat(24)}` },
      { ...AGENT, agentToken: `agent:agt_${"a".repeat(24)}:short` },
      { ...AGENT, deviceId: CURRENT.deviceId },
      {
        ...AGENT,
        transport: "local",
        workspacePairing: undefined,
        endpointSecret: undefined,
        url: "https://server.example/arbitrary",
      },
      {
        ...AGENT,
        transport: "local",
        workspacePairing: undefined,
        endpointSecret: undefined,
        url: "https://server.example/_workspace/other",
      },
      {
        ...AGENT,
        transport: "local",
        workspacePairing: undefined,
        endpointSecret: undefined,
        url: "https://user@server.example/",
      },
    ]) {
      write(invalid);
      expect(loadCliCredentials()).toBeNull();
    }

    fs.rmSync(credentialPath(), { force: true });
    fs.mkdirSync(credentialPath(), { recursive: true });
    expect(loadCliCredentials()).toBeNull();
    expect(warning).toHaveBeenCalled();
  });

  it("diagnoses every non-canonical JSON shape generically", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    write({ deviceId: CURRENT.deviceId });

    expect(loadCliCredentials()).toBeNull();
    expect(warning).toHaveBeenCalledWith(
      expect.stringMatching(/not a canonical CLI credential.*sign in again/su)
    );
    expect(warning).not.toHaveBeenCalledWith(expect.stringMatching(/schema|migrat/iu));
  });

  it("rejects invalid writes without replacing the valid credential", () => {
    saveCliCredentials(CURRENT);
    const before = fs.readFileSync(credentialPath());
    expect(() => saveCliCredentials(null as never)).toThrow(/non-canonical CLI credential/u);
    expect(() => saveCliCredentials({ ...CURRENT, workspacePairing: undefined } as never)).toThrow(
      /non-canonical CLI credential/u
    );
    expect(() =>
      saveCliCredentials({
        ...CURRENT,
        workspacePairing: { ...CURRENT.workspacePairing, relays: ["http://relay.example/"] },
      })
    ).toThrow(/non-canonical CLI credential/u);
    expect(fs.readFileSync(credentialPath())).toEqual(before);
  });

  it("never silently repoints an existing CLI profile to another server or device", () => {
    saveCliCredentials(CURRENT);
    const before = fs.readFileSync(credentialPath());

    expect(() => saveCliCredentials({ ...CURRENT, serverId: `srv_${"x".repeat(24)}` })).toThrow(
      /remote logout.*another server or principal/u
    );
    expect(() => saveCliCredentials({ ...CURRENT, deviceId: `dev_${"x".repeat(24)}` })).toThrow(
      /remote logout.*another server or principal/u
    );
    expect(fs.readFileSync(credentialPath())).toEqual(before);
  });

  it("allows reach, workspace, and token rotation for the same paired device", () => {
    saveCliCredentials(CURRENT);
    const rotated = {
      ...CURRENT,
      workspaceId: "workspace-other",
      workspaceName: "other",
      refreshToken: "n".repeat(43),
      url: `iroh://${"cc".repeat(32)}/_workspace/other`,
      workspacePairing: { ...CURRENT.workspacePairing, endpointId: "cc".repeat(32) },
    };

    saveCliCredentials(rotated);
    expect(loadCliCredentials()).toEqual(rotated);
  });

  it("requires explicit logout before redeeming a new pairing invite", () => {
    expect(() => assertCliProfileIsUnpaired()).not.toThrow();
    saveCliCredentials(CURRENT);
    expect(() => assertCliProfileIsUnpaired()).toThrow(/already paired.*remote logout/u);
  });

  it("refuses to overwrite corrupt credential state during a pairing or refresh", () => {
    write("{truncated");
    expect(() => assertCliProfileIsUnpaired()).toThrow(/Refusing to replace unreadable/u);
    expect(() => saveCliCredentials(CURRENT)).toThrow(/Refusing to replace unreadable/u);
    expect(fs.readFileSync(credentialPath(), "utf8")).toBe("{truncated");
  });
});
