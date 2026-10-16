import type { ViewManager } from "./viewManager";
import type { ClientWindows } from "./clientWindow.js";
import type { ClientCapability } from "@vibestudio/workspace-contracts/clients";

/** Session fallback for native views that have no workspace permission controller. */
export function nativeViewMayUsePermission(
  views: Pick<
    ViewManager,
    | "isContentOverlayWebContentsId"
    | "findViewIdByWebContentsId"
    | "getViewInfo"
    | "canFullscreenView"
  > | null,
  windows: Pick<ClientWindows, "byWebContents">,
  webContentsId: number,
  permission: string
): boolean {
  // The isolated overlay is application chrome, not an admitted client.
  // Copy writes text; it must not acquire clipboard-read authority.
  if (views?.isContentOverlayWebContentsId(webContentsId)) {
    return permission === "clipboard-sanitized-write";
  }
  const viewId = views?.findViewIdByWebContentsId(webContentsId);
  if (permission === "fullscreen")
    return viewId ? (views?.canFullscreenView(viewId) ?? false) : false;
  const capability: ClientCapability | null =
    permission === "notifications"
      ? "notifications"
      : permission === "openExternal"
        ? "open-external"
        : permission === "clipboard-read" || permission === "clipboard-sanitized-write"
          ? "clipboard"
          : null;
  if (capability === null) return false;
  const window = windows.byWebContents(webContentsId);
  if (window) return window.spec.capabilities.includes(capability);
  const view = viewId ? views?.getViewInfo(viewId) : null;
  return view?.type === "client" && view.capabilities.includes(capability);
}
