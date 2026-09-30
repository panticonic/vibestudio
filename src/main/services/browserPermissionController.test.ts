import { scopedNativePartition } from "../nativeStorageScope";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserPermissionController,
  browserSecurityOrigin,
  capabilitiesForCheck,
  capabilitiesForRequest,
  deniedPeripheralCapability,
  viewMayRequestPeripheral,
} from "./browserPermissionController.js";

vi.mock("electron", () => ({ systemPreferences: { getMediaAccessStatus: () => "granted" } }));

function mediaHarness(
  options: {
    capabilities?: string[];
    browser?: boolean;
    consent?: () => Promise<boolean>;
    approve?: () => Promise<unknown>;
  } = {}
) {
  const events = new EventEmitter();
  const url = "https://media.example/test";
  const contents = Object.assign(events, {
    id: 1,
    getURL: () => url,
    isDestroyed: () => false,
  }) as unknown as Electron.WebContents;
  const request = vi.fn(async (_service: string, method: string) =>
    method === "snapshot"
      ? { environmentKey: "browser_media", grants: [] }
      : options.approve
        ? options.approve()
        : { decision: "once", granted: true, grants: [] }
  );
  const consent = vi.fn(options.consent ?? (async () => true));
  const controller = new BrowserPermissionController({
    nativeStorageScope: "media-test",
    serverClient: { call: request, onDirectEvent: () => () => {} } as never,
    eventService: { emit: vi.fn() } as never,
    getViewManager: () =>
      ({
        findViewIdByWebContentsId: () => "panel:media",
        isContentOverlayWebContentsId: () => false,
        getViewPartition: () =>
          options.browser
            ? scopedNativePartition("media-test", "persist:browser-environment:browser_media")
            : undefined,
        getViewInfo: () => ({ type: "app", capabilities: options.capabilities ?? [] }),
      }) as never,
    isTargetUnderAutomation: () => false,
    requestDeviceMediaAccess: consent,
  });
  const decide = vi.fn();
  return {
    controller,
    contents,
    events,
    request,
    consent,
    decide,
    start(permission: "media" | "display-capture", isMainFrame = true) {
      controller.requestPermission(contents, permission, decide, {
        requestingUrl: url,
        securityOrigin: "https://media.example",
        mediaTypes: ["video"],
        isMainFrame,
      } as Electron.MediaAccessPermissionRequest);
    },
  };
}

function controllerHarness(options: { contentOverlay?: boolean } = {}) {
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
    isContentOverlayWebContentsId: (id: number) => options.contentOverlay === true && id === 43,
    getViewInfo: (id: string) => (id === "panel:terminal" ? viewInfo : null),
    getViewPartition: (id: string) => (id === "panel:terminal" ? undefined : null),
  };
  const contents = {
    id: options.contentOverlay ? 43 : 42,
    getURL: () => url,
    isDestroyed: () => false,
    on: () => undefined,
    once: () => undefined,
    off: () => undefined,
  } as unknown as Electron.WebContents;
  const controller = new BrowserPermissionController({
    nativeStorageScope: "test-host-device",
    serverClient: serverClient as never,
    eventService: { emit: () => undefined } as never,
    getViewManager: () => manager as never,
    isTargetUnderAutomation: () => false,
    requestDeviceMediaAccess: async () => true,
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
  it("cancels a native OS prompt when the document reloads", async () => {
    let resolve!: (value: boolean) => void;
    const harness = mediaHarness({
      capabilities: ["camera"],
      consent: () =>
        new Promise((r) => {
          resolve = r;
        }),
    });
    harness.start("media");
    expect(harness.consent).toHaveBeenCalledOnce();
    harness.events.emit("did-start-navigation", {}, harness.contents.getURL(), false, true);
    expect(harness.decide.mock.calls).toEqual([[false]]);
    resolve(true);
    await vi.waitFor(() => expect(harness.events.listenerCount("did-start-navigation")).toBe(0));
    expect(harness.decide.mock.calls).toEqual([[false]]);
  });
  it("gets site approval before requesting OS permission and honors OS denial", async () => {
    let resolve!: (result: unknown) => void;
    const harness = mediaHarness({
      browser: true,
      approve: () =>
        new Promise((r) => {
          resolve = r;
        }),
      consent: async () => false,
    });
    await harness.controller.attachBrowserEnvironment();
    harness.start("media");
    expect(harness.consent).not.toHaveBeenCalled();
    resolve({ decision: "once", granted: true, grants: [] });
    await vi.waitFor(() => expect(harness.decide.mock.calls).toEqual([[false]]));
    expect(harness.consent).toHaveBeenCalledOnce();
  });
  it("requires screen consent even for a declared app and excludes child frames", async () => {
    const harness = mediaHarness({ capabilities: ["screen-capture"] });
    harness.start("display-capture", false);
    expect(harness.decide.mock.calls).toEqual([[false]]);
    expect(harness.request).not.toHaveBeenCalled();
    harness.decide.mockClear();
    harness.start("display-capture");
    await vi.waitFor(() => expect(harness.decide.mock.calls).toEqual([[true]]));
    expect(harness.request).toHaveBeenCalledOnce();
    harness.decide.mockClear();
    harness.start("display-capture");
    await vi.waitFor(() => expect(harness.decide.mock.calls).toEqual([[true]]));
    expect(harness.request).toHaveBeenCalledTimes(2);
  });
  it("maps native display capture separately from camera and microphone", () => {
    expect(
      capabilitiesForRequest("display-capture", {
        mediaTypes: ["video", "audio"],
      } as Electron.MediaAccessPermissionRequest)
    ).toEqual(["screen-capture"]);
    expect(
      capabilitiesForCheck("display-capture", {
        mediaType: "video",
      } as Electron.PermissionCheckHandlerHandlerDetails)
    ).toEqual(["screen-capture"]);
  });

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

  it("allows user-activated copy from an isolated shell content overlay", () => {
    const { controller, contents, url, listener } = controllerHarness({ contentOverlay: true });
    const decisions: boolean[] = [];

    expect(
      controller.checkPermission(contents, "clipboard-sanitized-write", url, {
        requestingUrl: url,
      } as Electron.PermissionCheckHandlerHandlerDetails)
    ).toBe(true);
    controller.requestPermission(
      contents,
      "clipboard-sanitized-write",
      (allowed) => decisions.push(allowed),
      { requestingUrl: url } as Electron.PermissionRequest
    );
    controller.requestPermission(contents, "clipboard-read", (allowed) => decisions.push(allowed), {
      requestingUrl: url,
    } as Electron.PermissionRequest);

    expect(decisions).toEqual([true, false]);
    expect(listener()).toBeNull();
  });

  it("attaches and detaches browser-site grants without stopping local enforcement", async () => {
    const { controller, contents, url, released } = controllerHarness();

    expect(controller.isGranted(url, "notifications")).toBe(false);
    await expect(controller.attachBrowserEnvironment()).resolves.toBe(
      scopedNativePartition("test-host-device", "persist:browser-environment:browser_test")
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
