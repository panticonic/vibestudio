import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readIosSigningConfig } from "../scripts/cli/lib/mobile-ios-signing.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function root() {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "ios-signing-test-"));
  roots.push(value);
  return value;
}
describe("shared iOS signing configuration", () => {
  it("uses the same locally selected bundle for install and device inspection", () => {
    const directory = root();
    fs.writeFileSync(
      path.join(directory, "Signing.local.xcconfig"),
      "VIBESTUDIO_IOS_TEAM_ID = LOCALTEAM\nVIBESTUDIO_IOS_BUNDLE_ID = custom.phone\nVIBESTUDIO_IOS_APS_ENV = development\n"
    );
    expect(readIosSigningConfig(directory, {})).toMatchObject({
      teamId: "LOCALTEAM",
      bundleId: "custom.phone",
      apsEnvironment: "development",
    });
    expect(
      readIosSigningConfig(directory, { VIBESTUDIO_IOS_BUNDLE_ID: "environment.phone" }).bundleId
    ).toBe("environment.phone");
  });
  it("accepts environment signing without requiring a local file", () => {
    expect(readIosSigningConfig(root(), { VIBESTUDIO_IOS_TEAM_ID: "ENVTEAM" })).toMatchObject({
      exists: false,
      teamId: "ENVTEAM",
      bundleId: "app.vibestudio.mobile",
      apsEnvironment: "",
    });
  });
});
