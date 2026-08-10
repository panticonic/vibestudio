import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("phone setup skill", () => {
  it("documents the executable service boundary without inventing a skill package", () => {
    const markdown = readFileSync(new URL("./SKILL.md", import.meta.url), "utf8");

    expect(markdown).toContain('workers.resolveService("vibestudio.phone-provisioning.v1")');
    expect(markdown).toContain("discovery.devices.filter");
    expect(markdown).toContain("deviceId: ready[0].deviceId");
    expect(markdown).toContain('extensions.invoke("mobile-debug", "listDevices", [])');
    expect(markdown).toContain("do not try to map it from the");
    expect(markdown).toMatch(/is\s+not an adb serial/u);
    expect(markdown).toContain("Reuse `phone.targetId`");
    expect(markdown).toContain("This skill is documentation, not an importable code package");
    expect(markdown).toContain("no such runtime package exists");
    expect(markdown).toContain("Do not add an eval-level `authority`");
    expect(markdown).toContain('approvals: "pregranted-only"');
    expect(markdown).toContain("Allow USB debugging?");
    expect(markdown).toContain("Trust This Computer");
    expect(markdown).toContain("Pairing timed out after delivery");
  });
});
