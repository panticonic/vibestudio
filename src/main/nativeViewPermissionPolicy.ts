import type { ViewManager } from "./viewManager";
import type { AppCapability } from "@vibestudio/shared/unitManifest";

/** Session fallback for native views that have no workspace permission controller. */
export function nativeViewMayUsePermission(
  views: Pick<
    ViewManager,
    "isContentOverlayWebContentsId" | "findViewIdByWebContentsId" | "getViewInfo"
  >,
  webContentsId: number,
  permission: string
): boolean {
  // The isolated overlay is application chrome, not an admitted workspace app.
  // Copy writes text; it must not acquire clipboard-read authority.
  if (views.isContentOverlayWebContentsId(webContentsId)) {
    return permission === "clipboard-sanitized-write";
  }
  const viewId = views.findViewIdByWebContentsId(webContentsId);
  if (!viewId) return false;
  const view = views.getViewInfo(viewId);
  if (permission === "fullscreen" && view?.type === "browser") return true;
  const capability: AppCapability | null =
    permission === "notifications"
      ? "notifications"
      : permission === "openExternal"
        ? "open-external"
        : permission === "clipboard-read" || permission === "clipboard-sanitized-write"
          ? "clipboard"
          : permission === "fullscreen" ||
              permission === "pointerLock" ||
              permission === "display-capture"
            ? "window-management"
            : null;
  return capability !== null && view?.type === "app" && view.capabilities.includes(capability);
}
