import { describe, expect, it, vi } from "vitest";
import { checks, parseDoctorArgs } from "../scripts/cli/mobile-doctor.mjs";

function environment() {
  return {
    platform: "darwin",
    has: vi.fn(() => true),
    capture: vi.fn(() => ({ ok: true, stdout: "", stderr: "" })),
    exists: () => false,
    signing: { exists: false, team: "", bundleId: "", apsEnvironment: "" },
  };
}

describe("mobile doctor targets", () => {
  it("checks simulator tooling without requiring a physical signing team", () => {
    const deps = environment();
    const result = checks(parseDoctorArgs(["--platform", "ios", "--simulator"]), deps);
    expect(result.every((check) => check.ok || check.severity === "warn")).toBe(true);
    expect(result.map((check) => check.name)).not.toContain("ios.signing-config");
    expect(result.map((check) => check.name)).not.toContain("ios.signing-identity");
    expect(deps.capture).not.toHaveBeenCalled();
    expect(deps.has.mock.calls.flat()).not.toContain("adb");
  });

  it("requires signing for physical iOS builds", () => {
    const result = checks(parseDoctorArgs(["--platform", "ios"]), environment());
    expect(result.find((check) => check.name === "ios.signing-config")?.ok).toBe(false);
    expect(result.find((check) => check.name === "ios.signing-identity")?.ok).toBe(false);
  });

  it("reports unsupported explicit iOS requests instead of skipping them off macOS", () => {
    const deps = { ...environment(), platform: "linux" };
    expect(
      checks(parseDoctorArgs(["--platform", "ios"]), deps).find(
        (check) => check.name === "ios.macos"
      )?.ok
    ).toBe(false);
    expect(
      checks(parseDoctorArgs([]), deps)
        .filter((check) => check.name.startsWith("ios."))
        .every((check) => check.skipped)
    ).toBe(true);
  });

  it("uses the APNs environment contract rather than the retired push boolean", () => {
    const deps = environment();
    deps.signing.apsEnvironment = "invalid";
    const options = parseDoctorArgs(["--platform", "ios", "--simulator"]);
    expect(checks(options, deps).find((check) => check.name === "ios.push-entitlement")?.ok).toBe(
      false
    );
    deps.signing.apsEnvironment = "development";
    expect(checks(options, deps).find((check) => check.name === "ios.push-entitlement")?.ok).toBe(
      true
    );
  });

  it("rejects ambiguous target and unknown arguments", () => {
    expect(() => parseDoctorArgs(["--simulator"])).toThrow("requires --platform ios");
    expect(() => parseDoctorArgs(["--platform", "watchos"])).toThrow("android or ios");
    expect(() => parseDoctorArgs(["--ignored"])).toThrow("Unknown option");
  });
});
