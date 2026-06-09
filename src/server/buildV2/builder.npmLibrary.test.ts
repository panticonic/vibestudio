import { describe, expect, it } from "vitest";
import { buildNpmLibrary } from "./builder.js";

describe("buildNpmLibrary", () => {
  it("rejects test and build toolchains before npm install", async () => {
    await expect(buildNpmLibrary("vitest", "^3.2.4", [])).rejects.toThrow(
      "Unsupported npm package for panel eval: vitest"
    );
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
