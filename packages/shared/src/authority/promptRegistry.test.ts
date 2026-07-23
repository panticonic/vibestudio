import { describe, expect, it } from "vitest";
import { assertAuthorityPromptRegistry, AUTHORITY_PROMPT_REGISTRY } from "./promptRegistry.js";

describe("authority prompt registry", () => {
  it("contains the complete acquisition card inventory with safe copy", () => {
    expect(() => assertAuthorityPromptRegistry()).not.toThrow();
    expect(Object.keys(AUTHORITY_PROMPT_REGISTRY).sort()).toEqual([
      "confirm.critical",
      "permission.gated",
      "permission.outside",
    ]);
  });
});
