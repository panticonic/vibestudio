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
    // Pointer lock belongs to no client capability, so no client may take it.
    expect(nativeViewMayUsePermission(manager, noWindows, 42, "pointerLock")).toBe(false);
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
