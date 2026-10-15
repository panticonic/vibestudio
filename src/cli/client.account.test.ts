import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./client.js";
import { credentialPath, loadCliIdentity, saveCliCredentials } from "./credentialStore.js";

describe("account-only CLI control commands", () => {
  let profile: string;
  beforeEach(() => {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-account-cli-"));
    vi.stubEnv("XDG_CONFIG_HOME", profile);
    saveCliCredentials({
      schemaVersion: 6,
      phase: "account",
      kind: "device",
      transport: "local",
      url: "http://127.0.0.1:1234",
      serverId: `srv_${"S".repeat(24)}`,
      deviceId: `dev_${"D".repeat(24)}`,
      refreshToken: "R".repeat(43),
      pairedAt: 1,
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(profile, { recursive: true, force: true });
  });
  it("reports paired identity and unselected workspace without a workspace RPC", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(main(["remote", "status", "--json"])).resolves.toBe(0);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('"workspaceSelected":false'));
    expect(loadCliIdentity()).toMatchObject({ phase: "account" });
  });
  it("allows logout before workspace selection", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(main(["remote", "logout", "--json"])).resolves.toBe(0);
    expect(fs.existsSync(credentialPath())).toBe(false);
  });
});
