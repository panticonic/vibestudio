import { describe, expect, it } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { callerHasPlatformCapability, isAuthorizedChrome } from "./chromeTrust.js";

describe("chromeTrust", () => {
  it("grants platform capabilities by concrete platform principal, not caller kind", () => {
    expect(
      callerHasPlatformCapability(createVerifiedCaller("server", "server"), "panel-hosting")
    ).toBe(true);
    expect(
      callerHasPlatformCapability(
        createVerifiedCaller("server:untrusted", "server"),
        "panel-hosting"
      )
    ).toBe(false);

    expect(
      callerHasPlatformCapability(createVerifiedCaller("electron-main", "shell"), "panel-hosting")
    ).toBe(true);
    expect(
      callerHasPlatformCapability(createVerifiedCaller("shell:device-1", "shell"), "panel-hosting")
    ).toBe(true);
    expect(
      callerHasPlatformCapability(createVerifiedCaller("random-shell", "shell"), "panel-hosting")
    ).toBe(false);
  });

  it("grants the headless host panel hosting", () => {
    const headless = createVerifiedCaller("headless-host", "shell");

    expect(callerHasPlatformCapability(headless, "panel-hosting")).toBe(true);
  });

  it("still recognizes authorized chrome apps through the app capability hook", () => {
    const caller = createVerifiedCaller("app:apps/mobile:device-1", "app");

    expect(
      isAuthorizedChrome(caller, {
        hasAppCapability: (callerId, capability) =>
          callerId === "app:apps/mobile:device-1" && capability === "panel-hosting",
      })
    ).toBe(true);
  });
});
