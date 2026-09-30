import { describe, expect, it } from "vitest";
import { bootedIosSimulator } from "../scripts/cli/lib/mobile-ios.mjs";

const ios = "com.apple.CoreSimulator.SimRuntime.iOS-18-0";
const phone = { udid: "phone-udid", name: "iPhone 15", state: "Booted", isAvailable: true };
const inventory = (devices: Record<string, unknown[]>) => JSON.stringify({ devices });

describe("iOS install target", () => {
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
