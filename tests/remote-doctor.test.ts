// @ts-expect-error Script modules are plain .mjs and intentionally untyped.
import {
  inspectCredentialEndpoint,
  inspectIdentity,
  inspectRetiredTransportDependencies,
  parseArgs,
  runDoctor,
} from "../scripts/cli/remote-doctor.mjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function tmpFile(bytes: Uint8Array, mode = 0o600): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-iroh-doctor-"));
  const file = path.join(dir, "endpoint.key");
  fs.writeFileSync(file, bytes, { mode });
  fs.chmodSync(file, mode);
  return file;
}

const fakeBinding = {
  Endpoint: { builder: vi.fn() },
  SecretKey: {
    fromBytes: (bytes: number[]) => ({
      public: () => ({ toString: () => Buffer.from(bytes).toString("hex") }),
    }),
  },
};

afterEach(() => vi.unstubAllEnvs());

describe("remote-doctor", () => {
  it("selects durable hub and workspace endpoint-key paths", () => {
    vi.stubEnv("XDG_CONFIG_HOME", "/tmp/vibestudio-doctor-xdg");
    expect(parseArgs([]).identity).toBe(
      "/tmp/vibestudio-doctor-xdg/vibestudio/server-auth/iroh/endpoint.key"
    );
    expect(parseArgs(["--workspace", "dev_one"]).identity).toBe(
      "/tmp/vibestudio-doctor-xdg/vibestudio/workspaces/dev_one/reach/iroh/endpoint.key"
    );
    expect(() => parseArgs(["--workspace", "dev", "--identity", "/tmp/key"])).toThrow(/not both/);
  });

  it("derives the advertised Endpoint ID from an exact 0600 32-byte secret", () => {
    const file = tmpFile(new Uint8Array(32).fill(0xab));
    expect(inspectIdentity(file, () => fakeBinding)).toMatchObject({
      ok: true,
      endpointId: "ab".repeat(32),
    });
  });

  it("rejects unsafe permissions and malformed secret lengths", () => {
    expect(inspectIdentity(tmpFile(new Uint8Array(32), 0o644), () => fakeBinding).message).toMatch(
      /0600/
    );
    expect(inspectIdentity(tmpFile(new Uint8Array(31)), () => fakeBinding).message).toMatch(
      /32 bytes/
    );
  });

  it("derives the client Endpoint ID owned by a paired credential", () => {
    const endpointSecret = Buffer.alloc(32, 0xcd).toString("base64url");
    expect(inspectCredentialEndpoint({ endpointSecret }, () => fakeBinding)).toMatchObject({
      ok: true,
      endpointId: "cd".repeat(32),
    });
    expect(inspectCredentialEndpoint({ endpointSecret: "bad" }, () => fakeBinding)).toMatchObject({
      ok: false,
    });
  });

  it("fails when a retired dependency or environment setting survives", () => {
    const resolver = Object.assign(() => fakeBinding, {
      resolve: (name: string) => {
        if (name.includes("datachannel")) return "/installed/retired-package";
        throw new Error("missing");
      },
    });
    expect(inspectRetiredTransportDependencies(resolver)).toMatchObject({ ok: false });

    vi.stubEnv(["VIBESTUDIO", "WEB", "RTC", "MODE"].join("_"), "enabled");
    const emptyResolver = Object.assign(() => fakeBinding, {
      resolve: () => {
        throw new Error("missing");
      },
    });
    expect(inspectRetiredTransportDependencies(emptyResolver)).toMatchObject({ ok: false });
  });

  it("accepts an explicit canonical HTTPS relay set", async () => {
    const result = await runDoctor(
      { ...parseArgs([]), relayUrls: ["https://relay.example/"] },
      { require: () => fakeBinding, unitPath: "/nonexistent/unit.service", credential: null }
    );
    expect(
      result.checks.find((entry: { name: string }) => entry.name === "native-binding")
    ).toMatchObject({ ok: true });
    expect(
      result.checks.find((entry: { name: string }) => entry.name === "relay-config")
    ).toMatchObject({ ok: true });
    expect(
      result.checks.find((entry: { name: string }) => entry.name === "iroh-probe")
    ).toMatchObject({ skipped: true });
    expect(result.ok).toBe(true);
  });

  it("uses the shipped public relay topology when no override or paired reach exists", async () => {
    const defaults = await runDoctor(parseArgs([]), {
      require: () => fakeBinding,
      unitPath: "/nonexistent/unit.service",
      credential: null,
    });
    expect(defaults.ok).toBe(true);
    expect(
      defaults.checks.find((entry: { name: string }) => entry.name === "relay-config")
    ).toMatchObject({
      ok: true,
      message: "2 canonical HTTPS relay(s) from shipped public default",
    });
  });

  it("fails a noncanonical relay override", async () => {
    const malformed = await runDoctor(
      { ...parseArgs([]), relayUrls: ["http://relay.example/"] },
      { require: () => fakeBinding, unitPath: "/nonexistent/unit.service", credential: null }
    );
    expect(malformed.ok).toBe(false);
  });
});
