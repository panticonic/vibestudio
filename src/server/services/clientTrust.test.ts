import { describe, expect, it } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { callerHasCapability, isInteractiveClient, isTrustedDeviceCaller } from "./clientTrust.js";

const PRINCIPAL = "client:browser:web:device-1";

describe("clientTrust", () => {
  it("grants device-level capabilities to host principals, not to a caller kind", () => {
    expect(callerHasCapability(createVerifiedCaller("server", "server"), "panel-hosting")).toBe(
      true
    );
    expect(
      callerHasCapability(createVerifiedCaller("server:untrusted", "server"), "panel-hosting")
    ).toBe(false);
    expect(
      callerHasCapability(createVerifiedCaller("electron-main", "shell"), "panel-hosting")
    ).toBe(true);
    expect(
      callerHasCapability(createVerifiedCaller("shell:device-1", "shell"), "panel-hosting")
    ).toBe(true);
    expect(
      callerHasCapability(createVerifiedCaller("random-shell", "shell"), "panel-hosting")
    ).toBe(false);
  });

  it("does not hand hosts the ordinary capabilities a client must be granted", () => {
    expect(callerHasCapability(createVerifiedCaller("server", "server"), "tray")).toBe(false);
  });

  it("grants the headless host panel hosting", () => {
    expect(
      callerHasCapability(createVerifiedCaller("headless-host", "shell"), "panel-hosting")
    ).toBe(true);
  });

  it("grants a client exactly the capabilities its registry entry holds", () => {
    const caller = createVerifiedCaller(PRINCIPAL, "client");
    const deps = {
      hasClientCapability: (callerId: string, capability: string) =>
        callerId === PRINCIPAL && capability === "panel-hosting",
    };
    expect(callerHasCapability(caller, "panel-hosting", deps)).toBe(true);
    expect(callerHasCapability(caller, "device-session", deps)).toBe(false);
    expect(
      callerHasCapability(
        createVerifiedCaller("client:other:web:device-1", "client"),
        "panel-hosting",
        deps
      )
    ).toBe(false);
    expect(callerHasCapability(caller, "panel-hosting")).toBe(false);
  });

  it("trusts a client to act as the device only through device-session", () => {
    const caller = createVerifiedCaller(PRINCIPAL, "client");
    expect(
      isTrustedDeviceCaller(caller, {
        hasClientCapability: (_callerId, capability) => capability === "device-session",
      })
    ).toBe(true);
    expect(
      isTrustedDeviceCaller(caller, {
        hasClientCapability: (_callerId, capability) => capability === "panel-hosting",
      })
    ).toBe(false);
  });

  it("counts a person-facing client or device host, not the server or headless renderer", () => {
    const deviceSession = { hasClientCapability: () => true };
    expect(isInteractiveClient(createVerifiedCaller(PRINCIPAL, "client"), deviceSession)).toBe(
      true
    );
    expect(isInteractiveClient(createVerifiedCaller(PRINCIPAL, "client"))).toBe(false);
    expect(isInteractiveClient(createVerifiedCaller("shell:device-1", "shell"))).toBe(true);
    expect(isInteractiveClient(createVerifiedCaller("electron-main", "shell"))).toBe(true);
    expect(isInteractiveClient(createVerifiedCaller("headless-host", "shell"))).toBe(false);
    expect(isInteractiveClient(createVerifiedCaller("server", "server"))).toBe(false);
  });
});
