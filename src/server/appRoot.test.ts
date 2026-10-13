import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readHostBuildFingerprint,
  resolveNativeTypeScriptServerPath,
  resolveRequiredAppRoot,
  resolveRequiredHostArtifactRoot,
} from "./appRoot.js";

describe("resolveRequiredAppRoot", () => {
  it("prefers the exact command argument", () => {
    expect(
      resolveRequiredAppRoot({
        argument: "/candidate/host",
        env: { VIBESTUDIO_APP_ROOT: "/installed/host" },
      })
    ).toBe("/candidate/host");
  });

  it("accepts an exact launcher environment", () => {
    expect(resolveRequiredAppRoot({ env: { VIBESTUDIO_APP_ROOT: "/installed/host" } })).toBe(
      "/installed/host"
    );
  });

  it("never infers artifact identity from cwd", () => {
    expect(() => resolveRequiredAppRoot({ env: {} })).toThrow(
      "process working directory is not an execution input"
    );
  });
});

describe("resolveRequiredHostArtifactRoot", () => {
  it("accepts only the exact launcher generation", () => {
    expect(
      resolveRequiredHostArtifactRoot({ VIBESTUDIO_HOST_ARTIFACT_ROOT: "/host/generation" })
    ).toBe("/host/generation");
    expect(() =>
      resolveRequiredHostArtifactRoot({ VIBESTUDIO_APP_ROOT: "/installed/host" })
    ).toThrow("VIBESTUDIO_HOST_ARTIFACT_ROOT");
  });
});

describe("readHostBuildFingerprint", () => {
  it("reads the receipt from the exact launcher generation", () => {
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-app-root-"));
    const generation = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-host-generation-"));
    const expected = {
      version: 1 as const,
      mode: "development" as const,
      fingerprint: "a".repeat(64),
      inputCount: 42,
    };
    try {
      fs.writeFileSync(
        path.join(generation, "host-build-fingerprint.json"),
        JSON.stringify(expected)
      );

      expect(fs.existsSync(path.join(appRoot, "dist", "host-build-fingerprint.json"))).toBe(false);
      expect(readHostBuildFingerprint(generation)).toEqual(expected);
    } finally {
      fs.rmSync(appRoot, { recursive: true, force: true });
      fs.rmSync(generation, { recursive: true, force: true });
    }
  });

  it("rejects an incomplete generation receipt", () => {
    const generation = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-host-generation-"));
    try {
      fs.writeFileSync(
        path.join(generation, "host-build-fingerprint.json"),
        JSON.stringify({ version: 1, fingerprint: "a".repeat(64) })
      );
      expect(() => readHostBuildFingerprint(generation)).toThrow("malformed");
    } finally {
      fs.rmSync(generation, { recursive: true, force: true });
    }
  });
});

describe("resolveNativeTypeScriptServerPath", () => {
  it("maps a packaged Electron root to the physical unpacked compiler", () => {
    expect(
      resolveNativeTypeScriptServerPath(
        "/Applications/Vibestudio.app/Contents/Resources/app.asar",
        "darwin",
        "arm64"
      )
    ).toBe(
      "/Applications/Vibestudio.app/Contents/Resources/app.asar.unpacked/node_modules/@typescript/typescript-darwin-arm64/lib/tsc"
    );
  });

  it("keeps source installs rooted in their physical checkout", () => {
    expect(resolveNativeTypeScriptServerPath("/work/vibestudio", "linux", "x64")).toBe(
      "/work/vibestudio/node_modules/@typescript/typescript-linux-x64/lib/tsc"
    );
  });

  it("uses the native Windows executable name", () => {
    expect(resolveNativeTypeScriptServerPath("C:\\Vibestudio", "win32", "x64")).toMatch(
      /node_modules[/\\]@typescript[/\\]typescript-win32-x64[/\\]lib[/\\]tsc\.exe$/u
    );
  });
});
