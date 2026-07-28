import { describe, expect, it } from "vitest";
import { buildNpmLibrary } from "./builder.js";

describe("buildNpmLibrary", () => {
  it("returns structured caller-correctable errors for invalid npm coordinates", async () => {
    await expect(buildNpmLibrary("@missing-scope-only", "1.0.0", [])).rejects.toMatchObject({
      code: "invalid_package_specifier",
      errorData: {
        code: "invalid_package_specifier",
        specifier: "@missing-scope-only",
      },
    });
    await expect(buildNpmLibrary("example", "github:owner/repo", [])).rejects.toMatchObject({
      code: "invalid_package_version",
      errorData: {
        code: "invalid_package_version",
        version: "github:owner/repo",
      },
    });
  });

  it("rejects test and build toolchains before npm install", async () => {
    await expect(buildNpmLibrary("vitest", "^3.2.4", [])).rejects.toMatchObject({
      code: "unsupported_package",
      errorData: { code: "unsupported_package", specifier: "vitest" },
    });
    await expect(buildNpmLibrary("@vitest/browser", "^3.2.4", [])).rejects.toThrow(
      "Unsupported npm package for panel eval: @vitest/browser"
    );
    await expect(buildNpmLibrary("vite", "^7.3.1", [])).rejects.toThrow(
      "Unsupported npm package for panel eval: vite"
    );
    await expect(buildNpmLibrary("esbuild", "^0.27.0", [])).rejects.toThrow(
      "Unsupported npm package for panel eval: esbuild"
    );
  });
});
