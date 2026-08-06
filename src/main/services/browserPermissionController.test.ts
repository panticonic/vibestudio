import { describe, expect, it } from "vitest";
import {
  BrowserPermissionController,
  browserSecurityOrigin,
  capabilitiesForCheck,
  capabilitiesForRequest,
  deniedPeripheralCapability,
  viewMayRequestPeripheral,
} from "./browserPermissionController.js";

function controllerHarness() {
  const url = "https://workspace.test/panel";
  const viewInfo = {
    type: "panel",
    capabilities: [],
    codeIdentity: {
      source: "panels/terminal",
      effectiveVersion: "ev-terminal",
      executionDigest: "a".repeat(64),
      requested: [
        {
          capability: "clipboard",
          resource: { kind: "prefix" as const, prefix: "" },
        },
      ],
    },
  };
  let eventListener: ((payload: never) => void) | null = null;
  let released = false;
  const serverClient = {
    call: async (_service: string, method: string) => {
      if (method !== "snapshot") throw new Error(`Unexpected method ${method}`);
      return {
        environmentKey: "browser_test",
        grants: [
          {
            origin: "https://workspace.test",
            capability: "notifications",
            decision: "allow",
            scope: "session",
            updatedAt: 1,
          },
        ],
      };
    },
    onDirectEvent: (_event: string, listener: (payload: never) => void) => {
      eventListener = listener;
      return () => {
        released = true;
        eventListener = null;
      };
    },
  };
  const manager = {
    findViewIdByWebContentsId: (id: number) => (id === 42 ? "panel:terminal" : null),
    getViewInfo: (id: string) => (id === "panel:terminal" ? viewInfo : null),
    getViewPartition: (id: string) => (id === "panel:terminal" ? undefined : null),
  };
  const contents = {
    id: 42,
    getURL: () => url,
    isDestroyed: () => false,
    on: () => undefined,
    once: () => undefined,
    off: () => undefined,
  } as unknown as Electron.WebContents;
  const controller = new BrowserPermissionController({
    serverClient: serverClient as never,
    eventService: { emit: () => undefined } as never,
    getViewManager: () => manager as never,
    isTargetUnderAutomation: () => false,
  });
  return {
    controller,
    contents,
    url,
    released: () => released,
    listener: () => eventListener,
  };
}

describe("browser permission capability mapping", () => {
  it("allows local panel clipboard access before browser-data attaches", () => {
    const { controller, contents, url, listener } = controllerHarness();
    const decisions: boolean[] = [];

    controller.requestPermission(
      contents,
      "clipboard-sanitized-write",
      (allowed) => decisions.push(allowed),
      { requestingUrl: url } as Electron.PermissionRequest
    );
    controller.requestPermission(contents, "clipboard-read", (allowed) => decisions.push(allowed), {
      requestingUrl: url,
    } as Electron.PermissionRequest);

    expect(decisions).toEqual([true, true]);
    expect(listener()).toBeNull();
  });

  it("attaches and detaches browser-site grants without stopping local enforcement", async () => {
    const { controller, contents, url, released } = controllerHarness();

    expect(controller.isGranted(url, "notifications")).toBe(false);
    await expect(controller.attachBrowserEnvironment()).resolves.toBe(
      "persist:browser-environment:browser_test"
    );
    expect(controller.isGranted(url, "notifications")).toBe(true);

    controller.detachBrowserEnvironment();
    expect(released()).toBe(true);
    expect(controller.isGranted(url, "notifications")).toBe(false);
    let allowed = false;
    controller.requestPermission(
      contents,
      "clipboard-sanitized-write",
      (decision) => {
        allowed = decision;
      },
      { requestingUrl: url } as Electron.PermissionRequest
    );
    expect(allowed).toBe(true);
  });

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
