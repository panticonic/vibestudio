import * as fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("onboarding skill template handoff", () => {
  it("routes selected registry outcomes through Templates", () => {
    const skill = fs
      .readFileSync(new URL("SKILL.md", import.meta.url), "utf8")
      .replace(/\s+/gu, " ");

    expect(skill).toContain("Template-registry discovery is user-initiated");
    expect(skill).toContain("resolveOnboardingTemplateSelection");
    expect(skill).toContain("exact registry-bound selection");
    expect(skill).toContain("[Templates](../templates/SKILL.md)");
    expect(skill).toMatch(/Templates remains the sole (?:install\/update|installation and update) path/u);
    expect(skill).not.toContain("vibestudio-template-examples.git");
  });
});
