import { describe, expect, it, vi } from "vitest";
import type { ViewManager } from "./viewManager";
import { nativeViewMayUsePermission } from "./nativeViewPermissionPolicy";

describe("native permission fallback", () => {
  it("does not treat window-management as display-capture authority", () => {
    const manager = {
      isContentOverlayWebContentsId: () => false,
      findViewIdByWebContentsId: () => "app",
      getViewInfo: (): NonNullable<ReturnType<ViewManager["getViewInfo"]>> => ({
        type: "app",
        capabilities: ["window-management"],
        visible: true,
        hostChrome: false,
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      }),
      canFullscreenView: () => false,
    };
    expect(nativeViewMayUsePermission(manager, 42, "display-capture")).toBe(false);
    expect(nativeViewMayUsePermission(manager, 42, "pointerLock")).toBe(true);
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
    expect(nativeViewMayUsePermission(manager, 42, "clipboard-sanitized-write")).toBe(true);
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
      expect(nativeViewMayUsePermission(views(), 42, permission)).toBe(false);
    }
  });

  it("rejects unknown and former overlay renderers", () => {
    expect(nativeViewMayUsePermission(views(), 99, "clipboard-sanitized-write")).toBe(false);
    expect(nativeViewMayUsePermission(views(false), 42, "clipboard-sanitized-write")).toBe(false);
  });

  it("preserves app capability checks and browser fullscreen", () => {
    const view: NonNullable<ReturnType<ViewManager["getViewInfo"]>> = {
      type: "app",
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
    expect(nativeViewMayUsePermission(manager, 42, "clipboard-read")).toBe(false);
    view.capabilities = ["clipboard"];
    expect(nativeViewMayUsePermission(manager, 42, "clipboard-read")).toBe(true);
    view.type = "panel";
    manager.canFullscreenView.mockReturnValue(true);
    expect(nativeViewMayUsePermission(manager, 42, "fullscreen")).toBe(true);
    manager.canFullscreenView.mockReturnValue(false);
    expect(nativeViewMayUsePermission(manager, 42, "fullscreen")).toBe(false);
    expect(nativeViewMayUsePermission(manager, 42, "clipboard-read")).toBe(false);
  });
});
