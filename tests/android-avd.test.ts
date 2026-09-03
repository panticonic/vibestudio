import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANDROID_AVD,
  androidEmulatorSerial,
  parseReadyAndroidDevices,
  resolveAvdManager,
  selectAndroidSystemImage,
  selectExistingAndroidAvd,
  selectReadyAndroidDevice,
} from "../scripts/cli/lib/android-avd.mjs";

describe("Android AVD resolution", () => {
  it("derives the owned adb serial from the emulator's reported console port", () => {
    expect(androidEmulatorSerial("5556\n")).toBe("emulator-5556");
    expect(() => androidEmulatorSerial("5555")).toThrow(/invalid console port/);
    expect(() => androidEmulatorSerial("other-device")).toThrow(/invalid console port/);
  });

  it("selects one concrete ready adb target deterministically", () => {
    const devices = parseReadyAndroidDevices(
      "List of devices attached\nemulator-5556\tdevice\nphone-1\toffline\nemulator-5554\tdevice\n"
    );
    expect(devices).toEqual(["emulator-5556", "emulator-5554"]);
    expect(selectReadyAndroidDevice(devices)).toBe("emulator-5554");
    expect(selectReadyAndroidDevice(devices, "emulator-5556")).toBe("emulator-5556");
    expect(selectReadyAndroidDevice(devices, "missing")).toBeNull();
  });

  it("honors an explicitly selected installed AVD", () => {
    expect(selectExistingAndroidAvd(["Pixel_8", DEFAULT_ANDROID_AVD], "Pixel_8")).toBe("Pixel_8");
  });

  it("rejects an unavailable explicit AVD instead of silently changing targets", () => {
    expect(() => selectExistingAndroidAvd(["Pixel_8"], "Missing_Device")).toThrow(
      /Missing_Device.*Pixel_8/
    );
  });

  it("prefers the standard AVD and otherwise deterministically reuses an installed AVD", () => {
    expect(selectExistingAndroidAvd(["Pixel_8", DEFAULT_ANDROID_AVD])).toBe(DEFAULT_ANDROID_AVD);
    expect(selectExistingAndroidAvd(["Pixel_9", "Pixel_8"])).toBe("Pixel_8");
    expect(selectExistingAndroidAvd([])).toBeNull();
  });

  it("selects the newest preferred-ABI Google system image for provisioning", () => {
    expect(
      selectAndroidSystemImage(
        [
          {
            api: "android-35",
            flavor: "google_apis",
            abi: "x86_64",
            packageId: "system-images;android-35;google_apis;x86_64",
          },
          {
            api: "android-36",
            flavor: "google_apis_playstore",
            abi: "x86_64",
            packageId: "system-images;android-36;google_apis_playstore;x86_64",
          },
        ],
        "x64"
      )?.packageId
    ).toBe("system-images;android-36;google_apis_playstore;x86_64");
  });

  it("finds versioned command-line tools when the latest alias is absent", async () => {
    const sdkRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vibestudio-avd-tools-"));
    const expected = path.join(sdkRoot, "cmdline-tools", "12.0", "bin", "avdmanager");
    try {
      await fsp.mkdir(path.dirname(expected), { recursive: true });
      await fsp.writeFile(expected, "");
      expect(await resolveAvdManager(sdkRoot)).toBe(expected);
    } finally {
      await fsp.rm(sdkRoot, { recursive: true, force: true });
    }
  });
});
