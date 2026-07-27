import { describe, expect, it } from "vitest";
import type { ExecFileException } from "node:child_process";
import { isSuccessfulDevTemplateMirrorExit } from "./devTemplateMirror.js";

function exit(code: number): ExecFileException {
  return Object.assign(new Error(`rsync exited ${code}`), { code });
}

describe("isSuccessfulDevTemplateMirrorExit", () => {
  it("accepts a clean rsync exit", () => {
    expect(isSuccessfulDevTemplateMirrorExit(null)).toBe(true);
  });

  it("accepts vanished volatile source files (rsync exit 24)", () => {
    expect(isSuccessfulDevTemplateMirrorExit(exit(24))).toBe(true);
  });

  it("keeps every other rsync failure loud", () => {
    expect(isSuccessfulDevTemplateMirrorExit(exit(23))).toBe(false);
    expect(isSuccessfulDevTemplateMirrorExit(exit(12))).toBe(false);
  });
});
