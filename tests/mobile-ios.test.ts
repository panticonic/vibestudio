import { describe, expect, it } from "vitest";
import {
  availableIosSimulators,
  bootedIosSimulator,
  iosBuildTarget,
  coreDeviceIosPhones,
  coreDeviceIosApps,
} from "../scripts/cli/lib/mobile-ios.mjs";

const ios = "com.apple.CoreSimulator.SimRuntime.iOS-18-0";
const phone = { udid: "phone-udid", name: "iPhone 15", state: "Booted", isAvailable: true };
const inventory = (devices: Record<string, unknown[]>) => JSON.stringify({ devices });

describe("iOS install target", () => {
  it("discovers only available iOS simulators, including ones not yet booted", () => {
    const shutdown = { ...phone, udid: "shutdown", state: "Shutdown" };
    expect(
      availableIosSimulators(
        JSON.stringify({
          devices: {
            [ios]: [phone, shutdown, { ...phone, udid: "unavailable", isAvailable: false }],
            "com.apple.CoreSimulator.SimRuntime.watchOS-11-0": [{ ...phone, udid: "watch" }],
          },
        })
      )
    ).toEqual([phone, shutdown]);
  });
  it("selects the booted phone without requiring a particular model or runtime", () => {
    expect(bootedIosSimulator(inventory({ [ios]: [phone, { ...phone, state: "Shutdown" }] }))).toBe(
      "phone-udid"
    );
  });

  it("does not select another Apple platform or an unavailable runtime", () => {
    expect(
      bootedIosSimulator(
        inventory({
          [ios]: [phone, { ...phone, udid: "unavailable", isAvailable: false }],
          "com.apple.CoreSimulator.SimRuntime.watchOS-11-0": [{ ...phone, udid: "watch" }],
        })
      )
    ).toBe("phone-udid");
  });

  it("selects an explicit booted simulator when multiple phones are running", () => {
    expect(
      bootedIosSimulator(inventory({ [ios]: [phone, { ...phone, udid: "second" }] }), "second")
    ).toBe("second");
  });

  it("rejects an explicit simulator that is missing or shut down", () => {
    expect(() => bootedIosSimulator(inventory({ [ios]: [phone] }), "missing")).toThrow(
      "not available and booted"
    );
    expect(() =>
      bootedIosSimulator(inventory({ [ios]: [{ ...phone, state: "Shutdown" }] }), phone.udid)
    ).toThrow("not available and booted");
  });

  it("requires a booted iOS simulator", () => {
    expect(() =>
      bootedIosSimulator(inventory({ [ios]: [{ ...phone, state: "Shutdown" }] }))
    ).toThrow("Boot one iPhone simulator");
  });

  it("refuses an ambiguous target instead of installing to an arbitrary simulator", () => {
    expect(() =>
      bootedIosSimulator(inventory({ [ios]: [phone, { ...phone, udid: "second" }] }))
    ).toThrow("Multiple iOS simulators");
  });
});

describe("iOS SDK and product selection", () => {
  it("keeps an explicit simulator UDID on the simulator SDK", () => {
    expect(iosBuildTarget({ simulator: true, device: "sim-udid" }, "sim-udid")).toEqual({
      sdk: "iphonesimulator",
      destination: "platform=iOS Simulator,id=sim-udid",
    });
  });
  it("uses the physical SDK for a connected phone and a generic archive target", () => {
    expect(iosBuildTarget({ device: "phone-udid" })).toEqual({
      sdk: "iphoneos",
      destination: "id=phone-udid",
    });
    expect(iosBuildTarget({})).toEqual({ sdk: "iphoneos", destination: "generic/platform=iOS" });
  });
});

describe("CoreDevice iOS discovery", () => {
  it("reads the selected installed app without conflating other bundle identities", () => {
    expect(
      coreDeviceIosApps(
        JSON.stringify({
          result: {
            apps: [
              { bundleIdentifier: "custom.phone", version: "0.1.52" },
              { bundleIdentifier: "other.phone", version: "0.1.52" },
            ],
          },
        }),
        "custom.phone"
      )
    ).toEqual([{ packageId: "custom.phone", versionName: "0.1.52" }]);
    expect(coreDeviceIosApps('{"result":{"apps":[]}}', "custom.phone")).toEqual([]);
  });
  it("excludes Macs and simulated devices and preserves unpaired phone readiness", () => {
    const device = (udid: string, platform: string, reality: string, pairingState = "paired") => ({
      properties: {
        hardware: { udid, platform, reality },
        state: { name: udid },
        connection: { state: "connected", pairingState },
      },
    });
    expect(
      coreDeviceIosPhones(
        JSON.stringify({
          result: {
            devices: [
              device("phone", "iOS", "physical"),
              device("unpaired", "iOS", "physical", "unpaired"),
              device("mac", "macOS", "physical"),
              device("simulator", "iOS", "simulated"),
            ],
          },
        })
      ).map(({ deviceId, ready }) => ({ deviceId, ready }))
    ).toEqual([
      { deviceId: "phone", ready: true },
      { deviceId: "unpaired", ready: false },
    ]);
  });
});
