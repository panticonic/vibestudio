import { describe, expect, it } from "vitest";
import {
  parseAdbDevices,
  parseAndroidPackageVersion,
  versionsCompatible,
  compatibleAndroidApp,
} from "../scripts/cli/lib/mobile-device-tools.mjs";

describe("mobile device tools", () => {
  it("pairs the compatible app when an older release and a current internal app coexist", () => {
    const release = { packageId: "app.vibestudio.mobile", versionName: "0.1.33" };
    const internal = {
      packageId: "app.vibestudio.mobile.internal",
      versionName: "0.1.34-internal",
    };
    expect(compatibleAndroidApp([release, internal], "0.1.34")).toBe(internal);
    expect(compatibleAndroidApp([release, internal], "0.1.35")).toBeUndefined();
    expect(
      compatibleAndroidApp([internal, { ...release, versionName: "0.1.34" }], "0.1.34")?.packageId
    ).toBe(release.packageId);
  });

  it("keeps unauthorized devices visible with useful attributes", () => {
    expect(
      parseAdbDevices(
        "List of devices attached\nR58M123 device product:x model:Pixel_8 transport_id:1\nphone unauthorized usb:1-1\n"
      )
    ).toEqual([
      {
        deviceId: "R58M123",
        state: "device",
        attributes: { product: "x", model: "Pixel_8", transport_id: "1" },
      },
      { deviceId: "phone", state: "unauthorized", attributes: { usb: "1-1" } },
    ]);
  });

  it("compares app versions without build metadata", () => {
    expect(parseAndroidPackageVersion("  versionName=1.4.0+22\n")).toBe("1.4.0+22");
    expect(versionsCompatible("1.4.0+22", "v1.4.0")).toBe(true);
    expect(versionsCompatible("1.3.9", "1.4.0")).toBe(false);
  });
});
