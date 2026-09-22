import { describe, expect, it, vi } from "vitest";
import { nativeViewMayUsePermission } from "./nativeViewPermissionPolicy";

describe("native permission fallback", () => {
  function views(overlay = true) {
    return {
      isContentOverlayWebContentsId: (id: number) => overlay && id === 42,
      findViewIdByWebContentsId: vi.fn(() => null),
      getViewInfo: vi.fn(() => null),
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
    const view = {
      type: "app",
      visible: true,
      hostChrome: false,
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      capabilities: [] as "clipboard"[],
    };
    const manager = {
      ...views(false),
      findViewIdByWebContentsId: () => "panel",
      getViewInfo: () => view,
    };
    expect(nativeViewMayUsePermission(manager, 42, "clipboard-read")).toBe(false);
    view.capabilities.push("clipboard");
    expect(nativeViewMayUsePermission(manager, 42, "clipboard-read")).toBe(true);
    view.type = "browser";
    expect(nativeViewMayUsePermission(manager, 42, "fullscreen")).toBe(true);
    expect(nativeViewMayUsePermission(manager, 42, "clipboard-read")).toBe(false);
  });
});
