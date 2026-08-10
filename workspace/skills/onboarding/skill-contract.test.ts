import * as fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("onboarding skill template handoff", () => {
  it("routes optional official outcomes through the canonical Templates workflow", () => {
    const skill = fs.readFileSync(new URL("SKILL.md", import.meta.url), "utf8");

    expect(skill).toContain(
      "git+https://github.com/panticonic/vibestudio-template-examples.git"
    );
    expect(skill).toContain("git+https://github.com/panticonic/vibestudio-template-news.git");
    expect(skill).toContain(
      "git+https://github.com/panticonic/vibestudio-template-spectrolite.git"
    );
    expect(skill).toContain("`prepareAdd` and reviewed `add`");
    expect(skill).toMatch(/ask\s+the user whether to add/);
    expect(skill).toContain("Never\nguess a tag or commit");
  });
});
