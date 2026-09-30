import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { iosMarketingVersion } from "../scripts/generate-mobile-version.mjs";

describe("native mobile application version", () => {
  it("maps release and prerelease SemVer to Apple's numeric marketing version", () => {
    expect(iosMarketingVersion("1.2.3")).toBe("1.2.3");
    expect(iosMarketingVersion("1.2.3-beta.4+build.5")).toBe("1.2.3");
    expect(() => iosMarketingVersion("invalid")).toThrow("Invalid application SemVer");
  });

  it("uses the same generated app version in Debug and Release without Pod overrides", () => {
    const project = fs.readFileSync("apps/mobile/ios/Vibestudio.xcodeproj/project.pbxproj", "utf8");
    expect(project).not.toContain("MARKETING_VERSION =");
    for (const mode of ["Debug", "Release"]) {
      expect(fs.readFileSync(`apps/mobile/ios/Vibestudio.${mode}.xcconfig`, "utf8")).toContain(
        '#include "Vibestudio.Version.xcconfig"'
      );
    }
  });
});
