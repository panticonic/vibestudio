import { describe, expect, it } from "vitest";
import { assertReleaseVersion } from "../scripts/check-release-version.mjs";

describe("release version contract", () => {
  it("accepts only an exact stable tag and committed package version", () => {
    expect(assertReleaseVersion("v1.2.3", "1.2.3")).toBe("1.2.3");
  });

  it("rejects malformed or mismatched release coordinates", () => {
    expect(() => assertReleaseVersion("1.2.3", "1.2.3")).toThrow(/v-prefixed/u);
    expect(() => assertReleaseVersion("v1.2.3-rc.1", "1.2.3-rc.1")).toThrow(/stable/u);
    expect(() => assertReleaseVersion("v1.2.3+build.1", "1.2.3+build.1")).toThrow(/stable/u);
    expect(() => assertReleaseVersion("v01.2.3", "01.2.3")).toThrow(/stable/u);
    expect(() => assertReleaseVersion("v1.2.4", "1.2.3")).toThrow(
      /does not match committed package version/u
    );
  });
});
