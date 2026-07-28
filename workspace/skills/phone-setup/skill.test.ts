import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("phone setup skill", () => {
  it("documents the executable service boundary without inventing a skill package", () => {
    const markdown = readFileSync(new URL("./SKILL.md", import.meta.url), "utf8");

    expect(markdown).toContain('rpc.call("main", "phoneProvisioning.providers", [])');
    expect(markdown).toContain("Do not import");
    expect(markdown).toContain("@workspace-skills/phone-setup");
    expect(markdown).toContain("Do not add an eval-level `authority`");
    expect(markdown).toContain('approvals: "pregranted-only"');
    expect(markdown).toContain("Allow USB debugging?");
    expect(markdown).toContain("Trust This Computer");
    expect(markdown).toContain("Pairing timed out after delivery");
  });
});
