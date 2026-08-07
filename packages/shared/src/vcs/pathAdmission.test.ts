import { describe, expect, it } from "vitest";

import { CONTEXT_BINDING_FILE } from "../contextBinding.js";
import {
  SEMANTIC_VCS_MAX_PATH_UTF8_BYTES,
  SEMANTIC_VCS_MAX_PATH_SEGMENT_UTF8_BYTES,
  assertSemanticVcsPathAdmissible,
  semanticVcsPathAdmission,
} from "./pathAdmission.js";

describe("semanticVcsPathAdmission", () => {
  it("rejects unsafe, non-canonical, and over-budget paths", () => {
    for (const value of ["", "../up", "/abs", "a/../b", "a/./b", "a//b", "a\\b", "x\0y"]) {
      expect(semanticVcsPathAdmission(value), value).toMatchObject({ admissible: false });
    }
    expect(
      semanticVcsPathAdmission(`a/${"é".repeat(SEMANTIC_VCS_MAX_PATH_UTF8_BYTES / 2)}`)
    ).toMatchObject({ admissible: false, reason: "too-long" });
    expect(
      semanticVcsPathAdmission(`a/${"x".repeat(SEMANTIC_VCS_MAX_PATH_SEGMENT_UTF8_BYTES + 1)}/file`)
    ).toMatchObject({ admissible: false, reason: "too-long" });
  });

  it("rejects materializer metadata and exact secret filenames at any depth", () => {
    for (const value of [
      ".git/config",
      "nested/.gad/CHECKOUT.json",
      "src/.env",
      `nested/${CONTEXT_BINDING_FILE}`,
    ]) {
      expect(semanticVcsPathAdmission(value), value).toMatchObject({
        admissible: false,
        reason: "platform-reserved",
      });
      expect(() => assertSemanticVcsPathAdmissible(value)).toThrow(/platform-reserved/u);
    }
  });

  it("admits ordinary tracked output instead of treating names as infrastructure", () => {
    for (const value of [
      "dist/index.js",
      "out/generated.ts",
      "release/checksums.txt",
      "coverage/report.json",
      "test-results/summary.json",
      ".cache/checked-in.json",
      "node_modules/vendor/index.js",
      "artifacts/package.tgz",
      ".env.example",
      ".env.production",
      "src/index.ts",
    ]) {
      expect(semanticVcsPathAdmission(value), value).toEqual({ admissible: true });
    }
  });
});
