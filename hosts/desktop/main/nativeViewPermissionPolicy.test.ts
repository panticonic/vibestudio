import { describe, expect, it, vi } from "vitest";
import type { ViewManager } from "./viewManager";
import type { ClientCapability } from "@vibestudio/workspace-contracts/clients";
import { nativeViewMayUsePermission } from "./nativeViewPermissionPolicy";

const noWindows = { byWebContents: () => null };

function windowsHolding(...capabilities: ClientCapability[]) {
  return { byWebContents: () => ({ spec: { capabilities } }) as never };
}

describe("native permission fallback", () => {
  it("grants nothing a client's capabilities do not name", () => {
    const manager = {
      isContentOverlayWebContentsId: () => false,
      findViewIdByWebContentsId: () => "client",
      getViewInfo: (): NonNullable<ReturnType<ViewManager["getViewInfo"]>> => ({
        type: "client",
        capabilities: ["theme", "devtools"],
        visible: true,
        hostChrome: false,
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      }),
      canFullscreenView: () => false,
    };
    expect(nativeViewMayUsePermission(manager, noWindows, 42, "display-capture")).toBe(false);
    expect(nativeViewMayUsePermission(manager, noWindows, 42, "pointerLock")).toBe(true);
    expect(nativeViewMayUsePermission(manager, noWindows, 42, "midiSysex")).toBe(false);
  });

  it("lets a website lock the pointer the way a browser does, but not read MIDI devices", () => {
    const manager = {
      isContentOverlayWebContentsId: () => false,
      findViewIdByWebContentsId: () => "browser",
      getViewInfo: (): NonNullable<ReturnType<ViewManager["getViewInfo"]>> => ({
        type: "panel",
        browser: true,
        capabilities: [],
        visible: true,
        hostChrome: false,
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      }),
      canFullscreenView: () => false,
    };
    expect(nativeViewMayUsePermission(manager, noWindows, 42, "pointerLock")).toBe(true);
    expect(nativeViewMayUsePermission(manager, noWindows, 42, "midi")).toBe(false);
    expect(nativeViewMayUsePermission(manager, noWindows, 42, "openExternal")).toBe(false);
  });

  it("maps pointer lock to the window-appearance capability", () => {
    expect(nativeViewMayUsePermission(null, windowsHolding("theme"), 7, "pointerLock")).toBe(true);
    expect(nativeViewMayUsePermission(null, windowsHolding("clipboard"), 7, "pointerLock")).toBe(
      false
    );
  });

  it("lets a standalone client window fullscreen itself but not the panel host's chrome", () => {
    const owner = (hostsPanels: boolean) => ({
      byWebContents: () => ({ hostsPanels, spec: { capabilities: [] } }) as never,
    });
    expect(nativeViewMayUsePermission(null, owner(false), 7, "fullscreen")).toBe(true);
    expect(nativeViewMayUsePermission(null, owner(true), 7, "fullscreen")).toBe(false);
    expect(nativeViewMayUsePermission(null, noWindows, 7, "fullscreen")).toBe(false);
  });

  function views(overlay = true) {
    return {
      isContentOverlayWebContentsId: (id: number) => overlay && id === 42,
      findViewIdByWebContentsId: vi.fn(() => null),
      getViewInfo: vi.fn(() => null),
      canFullscreenView: vi.fn(() => false),
    };
  }

  it("allows copying from the isolated overlay with no workspace panel identity", () => {
    const manager = views();
    expect(nativeViewMayUsePermission(manager, noWindows, 42, "clipboard-sanitized-write")).toBe(
      true
    );
    expect(manager.findViewIdByWebContentsId).not.toHaveBeenCalled();
  });

  it("does not grant clipboard reads or other peripheral permissions to overlays", () => {
    for (const permission of [
      "clipboard-read",
      "media",
      "geolocation",
      "display-capture",
      "openExternal",
    ]) {
      expect(nativeViewMayUsePermission(views(), noWindows, 42, permission)).toBe(false);
    }
  });

  it("rejects unknown and former overlay renderers", () => {
    expect(nativeViewMayUsePermission(views(), noWindows, 99, "clipboard-sanitized-write")).toBe(
      false
    );
    expect(
      nativeViewMayUsePermission(views(false), noWindows, 42, "clipboard-sanitized-write")
    ).toBe(false);
  });

  it("preserves client capability checks and browser fullscreen", () => {
    const view: NonNullable<ReturnType<ViewManager["getViewInfo"]>> = {
      type: "client",
      visible: true,
      hostChrome: false,
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      capabilities: [],
    };
    const manager = {
      ...views(false),
      findViewIdByWebContentsId: () => "panel",
      getViewInfo: () => view,
    };
    expect(nativeViewMayUsePermission(manager, noWindows, 42, "clipboard-read")).toBe(false);
    view.capabilities = ["clipboard"];
    expect(nativeViewMayUsePermission(manager, noWindows, 42, "clipboard-read")).toBe(true);
    view.type = "panel";
    manager.canFullscreenView.mockReturnValue(true);
    expect(nativeViewMayUsePermission(manager, noWindows, 42, "fullscreen")).toBe(true);
    manager.canFullscreenView.mockReturnValue(false);
    expect(nativeViewMayUsePermission(manager, noWindows, 42, "fullscreen")).toBe(false);
    expect(nativeViewMayUsePermission(manager, noWindows, 42, "clipboard-read")).toBe(false);
  });

  it("answers for a client window that has no compositor at all", () => {
    expect(
      nativeViewMayUsePermission(null, windowsHolding("notifications"), 7, "notifications")
    ).toBe(true);
    expect(nativeViewMayUsePermission(null, windowsHolding("clipboard"), 7, "notifications")).toBe(
      false
    );
    expect(nativeViewMayUsePermission(null, noWindows, 7, "notifications")).toBe(false);
  });
});
