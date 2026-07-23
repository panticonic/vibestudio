import { describe, expect, it } from "vitest";
import {
  capabilitiesForCheck,
  capabilitiesForRequest,
  viewMayRequestPeripheral,
} from "./browserPermissionController.js";

describe("browser permission capability mapping", () => {
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

  it("maps only the supported non-media site permissions", () => {
    expect(capabilitiesForRequest("geolocation", {} as Electron.PermissionRequest)).toEqual([
      "geolocation",
    ]);
    expect(capabilitiesForRequest("notifications", {} as Electron.PermissionRequest)).toEqual([
      "notifications",
    ]);
    expect(capabilitiesForRequest("clipboard-read", {} as Electron.PermissionRequest)).toEqual([]);
  });

  it("admits workspace apps only when every peripheral is declared", () => {
    expect(
      viewMayRequestPeripheral(
        { type: "app", capabilities: ["camera", "microphone", "location"] },
        ["camera", "microphone", "geolocation"]
      )
    ).toBe(true);
    expect(
      viewMayRequestPeripheral({ type: "app", capabilities: ["camera"] }, ["camera", "microphone"])
    ).toBe(false);
  });

  it("rejects ordinary panels and unmanaged content from the app permission path", () => {
    expect(viewMayRequestPeripheral({ type: "panel", capabilities: ["camera"] }, ["camera"])).toBe(
      false
    );
    expect(viewMayRequestPeripheral(null, ["camera"])).toBe(false);
  });
});
