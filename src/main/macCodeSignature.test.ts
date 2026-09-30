import { describe, expect, it, vi } from "vitest";
import { hasDeveloperIdSignature } from "@vibestudio/credential-client/macCodeSignature";

describe("hasDeveloperIdSignature", () => {
  it("accepts a Developer ID certificate chain on macOS", () => {
    const spawnSync = vi.fn(() => ({
      status: 0,
      stderr: "Authority=Developer ID Application: Panticonic LLC (TEAMID)\n",
    }));
    expect(
      hasDeveloperIdSignature("/Applications/Vibestudio.app/Contents/MacOS/Vibestudio", {
        platform: "darwin",
        spawnSync: spawnSync as never,
      })
    ).toBe(true);
  });

  it("rejects ad-hoc, failed, and non-macOS signatures", () => {
    const adHoc = vi.fn(() => ({ status: 0, stderr: "Signature=adhoc\n" }));
    expect(
      hasDeveloperIdSignature("/tmp/Vibestudio", {
        platform: "darwin",
        spawnSync: adHoc as never,
      })
    ).toBe(false);
    expect(
      hasDeveloperIdSignature("/tmp/Vibestudio", {
        platform: "darwin",
        spawnSync: vi.fn(() => ({
          status: 1,
          stderr: "Authority=Developer ID Application: Invalid\n",
        })) as never,
      })
    ).toBe(false);
    expect(
      hasDeveloperIdSignature("/tmp/Vibestudio", {
        platform: "linux",
        spawnSync: vi.fn(() => {
          throw new Error("must not run");
        }) as never,
      })
    ).toBe(false);
  });
});
