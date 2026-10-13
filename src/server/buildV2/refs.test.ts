import { describe, expect, it } from "vitest";
import { validateBuildRef } from "./refs.js";

describe("validateBuildRef", () => {
  it("returns a structured caller-correctable error for an invalid selector", () => {
    expect(() => validateBuildRef("./packages/example/src/index.ts")).toThrowError(
      expect.objectContaining({
        code: "invalid_build_ref",
        errorKind: "application",
        errorData: expect.objectContaining({
          code: "invalid_build_ref",
          ref: "./packages/example/src/index.ts",
          failureKind: "invalid-input",
          retry: { policy: "correct-input", commandIdPolicy: "not-applicable" },
        }),
      })
    );
  });

  it("rejects a workspace path appended to a context selector", () => {
    const ref = "ctx:abc123/packages/example/src/index.ts";
    expect(() => validateBuildRef(ref)).toThrowError(
      expect.objectContaining({
        code: "invalid_build_ref",
        errorKind: "application",
        errorData: expect.objectContaining({
          code: "invalid_build_ref",
          ref,
          failureKind: "invalid-input",
          retry: { policy: "correct-input", commandIdPolicy: "not-applicable" },
        }),
      })
    );
  });

  it("accepts a complete semantic context identifier", () => {
    expect(validateBuildRef("ctx:8499051c-a23b-4a11-9229-d9d8b7c8c80e")).toBe(
      "ctx:8499051c-a23b-4a11-9229-d9d8b7c8c80e"
    );
  });
});

describe("derived context ids", () => {
  it("are valid context build refs (app principals list workers in their own context)", async () => {
    const { contextIdForTargetKey } = await import("@vibestudio/shared/runtime/contextIdentity");
    const contextId = contextIdForTargetKey(
      "ws\x00app-device\x00apps/terminal-browser\x00device-1"
    );
    expect(validateBuildRef(`ctx:${contextId}`)).toBe(`ctx:${contextId}`);
  });
});
