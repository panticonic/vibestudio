import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ANDROID_AVD,
  androidEmulatorSerial,
  parseReadyAndroidDevices,
  resolveAvdManager,
  selectAndroidSystemImage,
  selectExistingAndroidAvd,
  selectReadyAndroidDevice,
  waitForAndroidBoot,
} from "../scripts/cli/lib/android-avd.mjs";

describe("Android boot readiness", () => {
  afterEach(() => vi.useRealTimers());

  it("waits through adb disconnects until the owned device reports boot completion", async () => {
    vi.useFakeTimers();
    const exec = vi
      .fn()
      .mockRejectedValueOnce(new Error("device not found"))
      .mockResolvedValueOnce({ stdout: "0\n" })
      .mockRejectedValueOnce(new Error("device offline"))
      .mockResolvedValueOnce({ stdout: "1\n" });
    const ready = waitForAndroidBoot("emulator-5556", 5_000, exec);
    await vi.advanceTimersByTimeAsync(3_000);
    await ready;
    expect(exec).toHaveBeenCalledTimes(4);
    for (const [, args] of exec.mock.calls) {
      expect(args).toEqual(["-s", "emulator-5556", "shell", "getprop", "sys.boot_completed"]);
    }
  });

  it("bounds each probe and reports the last adb failure at the deadline", async () => {
    vi.useFakeTimers();
    const exec = vi.fn().mockRejectedValue(new Error("device offline"));
    const failed = expect(waitForAndroidBoot("emulator-5556", 1_500, exec)).rejects.toThrow(
      /emulator-5556: device offline/
    );
    await vi.advanceTimersByTimeAsync(1_500);
    await failed;
    expect(exec.mock.calls.map(([, , options]) => options.timeout)).toEqual([1_500, 500]);
  });

  it("fails immediately when adb cannot be launched", async () => {
    const error = Object.assign(new Error("adb is missing"), { code: "ENOENT" });
    const exec = vi.fn().mockRejectedValue(error);
    await expect(waitForAndroidBoot("emulator-5556", 5_000, exec)).rejects.toBe(error);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

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
