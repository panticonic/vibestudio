import { describe, expect, it } from "vitest";
import {
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
