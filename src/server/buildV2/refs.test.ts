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

  it("rejects a workspace path appended to a context selector", () => {
    const ref = "ctx:abc123/packages/example/src/index.ts";
    expect(() => validateBuildRef(ref)).toThrowError(
      expect.objectContaining({
        code: "invalid_build_ref",
        errorKind: "application",
        errorData: {
          code: "invalid_build_ref",
          ref,
        },
      })
    );
  });

  it("accepts a complete semantic context identifier", () => {
    expect(validateBuildRef("ctx:8499051c-a23b-4a11-9229-d9d8b7c8c80e")).toBe(
      "ctx:8499051c-a23b-4a11-9229-d9d8b7c8c80e"
    );
  });
});
