import * as fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("onboarding skill template handoff", () => {
  it("routes optional official outcomes through the canonical Templates workflow", () => {
    const skill = fs.readFileSync(new URL("SKILL.md", import.meta.url), "utf8");

    expect(skill).toContain("current verified template\nregistry");
    expect(skill).toContain("does not\nmaintain a second list of official repository URLs");
    expect(skill).not.toContain("vibestudio-template-examples.git");
    expect(skill).toContain("single reviewed `add` workflow");
    expect(skill).toContain("`Review & add`");
    expect(skill).toContain("resolveOnboardingTemplateSelection");
    expect(skill).toContain("Never\nguess a tag or commit");
  });
});
