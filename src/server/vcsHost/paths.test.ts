import { describe, it, expect } from "vitest";
import { CONTEXT_BINDING_FILE } from "@vibestudio/shared/contextBinding";

import { isWritableVcsPath, normalizeRepositoryPath } from "./paths.js";

describe("host semantic path routing", () => {
  it("delegates to the shared admission predicate without a host policy", () => {
    expect(isWritableVcsPath(CONTEXT_BINDING_FILE)).toBe(false);
    expect(isWritableVcsPath(`packages/foo/${CONTEXT_BINDING_FILE}`)).toBe(false);
    expect(isWritableVcsPath("packages/foo/vibestudio-context.json")).toBe(true);
    expect(isWritableVcsPath("dist/index.js")).toBe(true);
    expect(isWritableVcsPath("coverage/report.json")).toBe(true);
    expect(isWritableVcsPath("../escape")).toBe(false);
    expect(() => normalizeRepositoryPath("packages/.git")).toThrow(/platform-reserved/u);
    expect(() => normalizeRepositoryPath("projects/.gad")).toThrow(/platform-reserved/u);
  });
});
