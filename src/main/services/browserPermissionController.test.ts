import { describe, expect, it } from "vitest";
import {
  browserSecurityOrigin,
  capabilitiesForCheck,
  capabilitiesForRequest,
  deniedPeripheralCapability,
  viewMayRequestPeripheral,
} from "./browserPermissionController.js";

describe("browser permission capability mapping", () => {
  it("represents tuple and opaque security origins without aliasing opaque documents", () => {
    expect(browserSecurityOrigin("https://example.com/path", "opaque-a")).toEqual({
      kind: "tuple",
      scheme: "https",
      host: "example.com",
      port: "443",
      serialized: "https://example.com",
    });
    expect(
      browserSecurityOrigin(
        "blob:https://example.com/00000000-0000-0000-0000-000000000000",
        "opaque-a"
      )
    ).toMatchObject({ kind: "tuple", serialized: "https://example.com" });
    expect(browserSecurityOrigin("data:text/plain,hello", "opaque-a")).toEqual({
      kind: "opaque",
      nonce: "opaque-a",
    });
    expect(browserSecurityOrigin("data:text/plain,hello", "opaque-b")).not.toEqual(
      browserSecurityOrigin("data:text/plain,hello", "opaque-a")
    );
  });

  it("splits media requests into camera and microphone grants", () => {
    expect(
      capabilitiesForRequest("media", {
        mediaTypes: ["video", "audio", "audio"],
      } as Electron.MediaAccessPermissionRequest)
    ).toEqual(["camera", "microphone"]);
    expect(
      capabilitiesForRequest("media", {
        mediaTypes: [],
      } as unknown as Electron.MediaAccessPermissionRequest)
    ).toEqual([]);
  });

  it("maps synchronous media checks to one exact capability", () => {
    expect(
      capabilitiesForCheck("media", {
        mediaType: "video",
      } as Electron.PermissionCheckHandlerHandlerDetails)
    ).toEqual(["camera"]);
    expect(
      capabilitiesForCheck("media", {
        mediaType: "audio",
      } as Electron.PermissionCheckHandlerHandlerDetails)
    ).toEqual(["microphone"]);
    expect(
      capabilitiesForCheck("media", {} as Electron.PermissionCheckHandlerHandlerDetails)
    ).toEqual([]);
  });

  it("maps supported non-media site permissions to the canonical grant set", () => {
    expect(capabilitiesForRequest("geolocation", {} as Electron.PermissionRequest)).toEqual([
      "geolocation",
    ]);
    expect(capabilitiesForRequest("notifications", {} as Electron.PermissionRequest)).toEqual([
      "notifications",
    ]);
    expect(capabilitiesForRequest("clipboard-read", {} as Electron.PermissionRequest)).toEqual([
      "clipboard",
    ]);
    expect(
      capabilitiesForCheck(
        "clipboard-sanitized-write",
        {} as Electron.PermissionCheckHandlerHandlerDetails
      )
    ).toEqual(["clipboard"]);
  });

  it("admits workspace apps only when every peripheral is declared", () => {
    expect(
      viewMayRequestPeripheral(
        { type: "app", capabilities: ["camera", "microphone", "location"] },
        ["camera", "microphone", "geolocation"],
        "https://example.com"
      )
    ).toBe(true);
    expect(
      viewMayRequestPeripheral(
        { type: "app", capabilities: ["camera"] },
        ["camera", "microphone"],
        "https://example.com"
      )
    ).toBe(false);
  });

  it("admits exact-identity workspace panels only within the declared resource scope", () => {
    const exactIdentity = {
      type: "panel",
      capabilities: [],
      codeIdentity: {
        source: "panels/terminal",
        effectiveVersion: "ev-terminal",
        executionDigest: "a".repeat(64),
        requested: [
          {
            capability: "clipboard",
            resource: { kind: "origin" as const, origin: "https://allowed.example" },
          },
        ],
      },
    };
    expect(viewMayRequestPeripheral(exactIdentity, ["clipboard"], "https://allowed.example")).toBe(
      true
    );
    expect(
      viewMayRequestPeripheral(exactIdentity, ["clipboard"], "https://different.example")
    ).toBe(false);
    expect(
      viewMayRequestPeripheral(
        { type: "panel", capabilities: ["camera"] },
        ["camera"],
        "https://allowed.example"
      )
    ).toBe(false);
    expect(
      viewMayRequestPeripheral(
        {
          type: "panel",
          capabilities: [],
          codeIdentity: {
            ...exactIdentity.codeIdentity,
            effectiveVersion: null,
          },
        },
        ["clipboard"],
        "https://allowed.example"
      )
    ).toBe(false);
    expect(viewMayRequestPeripheral(null, ["camera"], "https://allowed.example")).toBe(false);
  });

  it("keeps device privacy denial ahead of any unit or site approval", () => {
    expect(
      deniedPeripheralCapability(["camera", "microphone"], (capability) => capability === "camera")
    ).toBe("microphone");
    expect(deniedPeripheralCapability(["camera"], () => true)).toBeUndefined();
  });
});
