import { describe, expect, it } from "vitest";
import { validateBuildRef } from "./refs.js";

describe("validateBuildRef", () => {
  it("returns a structured caller-correctable error for an invalid selector", () => {
    expect(() => validateBuildRef("./packages/example/src/index.ts")).toThrowError(
      expect.objectContaining({
        code: "invalid_build_ref",
        errorKind: "application",
        errorData: {
          code: "invalid_build_ref",
          ref: "./packages/example/src/index.ts",
        },
      })
    );
  });
});
