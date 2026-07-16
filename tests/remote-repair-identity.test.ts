// @ts-expect-error Script modules are plain .mjs and intentionally untyped.
import { parseArgs, repairIdentity, repairImpact } from "../scripts/cli/remote-repair-identity.mjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CERT = "-----BEGIN CERTIFICATE-----\nnew-cert\n-----END CERTIFICATE-----\n";
const KEY = "-----BEGIN PRIVATE KEY-----\nnew-key\n-----END PRIVATE KEY-----\n";

function repairArtifacts(dir: string): string[] {
  return fs.readdirSync(dir).filter((entry) => entry.includes(".repair"));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("remote-repair-identity", () => {
  it("refuses an implicit or hub identity repair", () => {
    expect(() => parseArgs([])).toThrow(/--workspace is required/);
    expect(() =>
      parseArgs(["--identity", "/tmp/vibestudio/server-auth/webrtc/identity.pem"])
    ).toThrow(/Unknown argument/);
  });

  it("makes a workspace child an explicit target with workspace-only recovery", () => {
    vi.stubEnv("XDG_CONFIG_HOME", "/tmp/vibestudio-repair-xdg");
    const options = parseArgs(["--workspace", "dev_one"]);
    expect(options).toMatchObject({ workspace: "dev_one" });
    expect(options.identity).toContain(
      path.join("workspaces", "dev_one", "reach", "webrtc", "identity.pem")
    );
    expect(repairImpact(options)).toMatch(/hub control remain valid/);
    expect(repairImpact(options)).toMatch(/re-route this workspace/);
  });

  it("does not let an identity environment override retarget the workspace command", () => {
    vi.stubEnv("XDG_CONFIG_HOME", "/tmp/vibestudio-repair-xdg");
    vi.stubEnv("VIBESTUDIO_WEBRTC_IDENTITY", "/tmp/other-child-identity.pem");
    expect(parseArgs(["--workspace", "dev_one"]).identity).toContain(
      path.join("workspaces", "dev_one", "reach", "webrtc", "identity.pem")
    );
  });

  it("generates the replacement before moving the live identity", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-repair-"));
    const identity = path.join(dir, "identity.pem");
    fs.writeFileSync(identity, "old-identity", { mode: 0o600 });
    let observedLiveIdentity = "";

    const result = repairIdentity(
      { identity, workspace: "dev", yes: true },
      {
        spawnSync: (_command: string, args: string[]) => {
          observedLiveIdentity = fs.readFileSync(identity, "utf8");
          const keyPath = args[args.indexOf("-keyout") + 1];
          const certPath = args[args.indexOf("-out") + 1];
          fs.writeFileSync(keyPath, KEY);
          fs.writeFileSync(certPath, CERT);
          return { status: 0, stdout: "", stderr: "" };
        },
      }
    );

    expect(observedLiveIdentity).toBe("old-identity");
    expect(fs.readFileSync(identity, "utf8")).toContain("new-cert");
    expect(fs.readFileSync(identity, "utf8")).toContain("new-key");
    expect(fs.readFileSync(result.backup, "utf8")).toBe("old-identity");
    expect(result.impact).toMatch(/re-route this workspace/);
    expect(repairArtifacts(dir)).toEqual([]);
  });

  it("keeps the live identity untouched when generation fails", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-repair-"));
    const identity = path.join(dir, "identity.pem");
    fs.writeFileSync(identity, "old-identity", { mode: 0o600 });

    expect(() =>
      repairIdentity(
        { identity, workspace: "dev", yes: true },
        { spawnSync: () => ({ status: 1, stdout: "", stderr: "generation failed" }) }
      )
    ).toThrow(/generation failed/);
    expect(fs.readFileSync(identity, "utf8")).toBe("old-identity");
    expect(repairArtifacts(dir)).toEqual([]);
  });

  it("rejects a concurrent repair of the same identity", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-repair-"));
    const identity = path.join(dir, "identity.pem");
    fs.writeFileSync(identity, "old-identity", { mode: 0o600 });

    repairIdentity(
      { identity, workspace: "dev", yes: true },
      {
        spawnSync: (_command: string, args: string[]) => {
          expect(() =>
            repairIdentity(
              { identity, workspace: "dev", yes: true },
              { spawnSync: () => ({ status: 0, stdout: "", stderr: "" }) }
            )
          ).toThrow(/identity repair already in progress/);
          fs.writeFileSync(args[args.indexOf("-keyout") + 1], KEY);
          fs.writeFileSync(args[args.indexOf("-out") + 1], CERT);
          return { status: 0, stdout: "", stderr: "" };
        },
      }
    );

    expect(fs.readFileSync(identity, "utf8")).toContain("new-key");
    expect(repairArtifacts(dir)).toEqual([]);
  });

  it("removes generated secret material when assembly fails", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-repair-"));
    const identity = path.join(dir, "identity.pem");
    fs.writeFileSync(identity, "old-identity", { mode: 0o600 });

    expect(() =>
      repairIdentity(
        { identity, workspace: "dev", yes: true },
        {
          spawnSync: (_command: string, args: string[]) => {
            fs.writeFileSync(args[args.indexOf("-out") + 1], CERT);
            return { status: 0, stdout: "", stderr: "" };
          },
        }
      )
    ).toThrow();
    expect(fs.readFileSync(identity, "utf8")).toBe("old-identity");
    expect(repairArtifacts(dir)).toEqual([]);
  });
});
