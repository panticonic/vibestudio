import { describe, expect, it } from "vitest";
import {
  assertAuthorityPromptRegistry,
  AUTHORITY_PROMPT_REGISTRY,
  authorityPromptCardType,
} from "./promptRegistry.js";

describe("authority prompt registry", () => {
  it("contains the complete acquisition card inventory with safe copy", () => {
    expect(() => assertAuthorityPromptRegistry()).not.toThrow();
    expect(Object.keys(AUTHORITY_PROMPT_REGISTRY).sort()).toEqual([
      "confirm.critical",
      "permission.gated",
      "permission.outside",
      "task.rules",
      "template.add",
      "template.remove",
      "template.suggest",
      "template.update",
    ]);
  });

  it("selects operation-specific template cards from sealed capabilities", () => {
    for (const operation of ["add", "update", "remove", "suggest"] as const) {
      expect(
        authorityPromptCardType({
          tier: "gated",
          capability: `userland:extensions/template-composer/workspace.templates.${operation}#abc`,
          outsideContent: false,
        })
      ).toBe(`template.${operation}`);
    }
    expect(
      authorityPromptCardType({
        tier: "critical",
        capability: "userland:any/workspace.templates.remove#abc",
        outsideContent: false,
      })
    ).toBe("confirm.critical");
  });
});
