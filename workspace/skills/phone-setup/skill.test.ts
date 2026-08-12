import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("phone setup skill", () => {
  it("routes provisioning through the live desktop service", () => {
    const markdown = readFileSync(new URL("./SKILL.md", import.meta.url), "utf8").replace(
      /\s+/gu,
      " "
    );

    expect(markdown).toContain('workers.resolveService("vibestudio.phone-provisioning.v1")');
    expect(markdown).toContain("open its live docs");
    expect(markdown).toContain("Preserve returned provider and device IDs exactly");
    expect(markdown).toContain("adb, Xcode, and the phone are attached to the user's desktop");
    expect(markdown).toContain("Never expose a pairing secret");
    expect(markdown).toContain("A hub device ID");
    expect(markdown).toContain("adb serial");
    expect(markdown).toContain("keep those identities separate");
    expect(markdown).toContain("mobile-debug.verifyWorkspaceReady");
    expect(markdown).toContain("shell's Devices surface");
  });
});
