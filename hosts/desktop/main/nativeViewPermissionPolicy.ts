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
  // A website gets the browser's own pointer-lock behaviour: Chromium grants
  // it only on a user gesture and the person always leaves it with Esc.
  if (permission === "pointerLock" && viewId && views?.getViewInfo(viewId)?.browser) return true;
  if (permission === "fullscreen") {
    // A view the panel host composes is presented by its ViewManager. A
    // standalone client window owns its whole frame, so its own page may
    // take it; the panel-hosting window's chrome never fullscreens itself.
    if (viewId) return views?.canFullscreenView(viewId) ?? false;
    const owner = windows.byWebContents(webContentsId);
    return owner !== null && !owner.hostsPanels;
  }
  const capability: ClientCapability | null =
    permission === "notifications"
      ? "notifications"
      : permission === "openExternal"
        ? "open-external"
        : permission === "clipboard-read" || permission === "clipboard-sanitized-write"
          ? "clipboard"
          : permission === "pointerLock"
            ? // Pointer lock is window behaviour; `theme` is what the former
              // `window-management` capability became for window appearance.
              "theme"
            : null;
  if (capability === null) return false;
  const window = windows.byWebContents(webContentsId);
  if (window) return window.spec.capabilities.includes(capability);
  const view = viewId ? views?.getViewInfo(viewId) : null;
  return view?.type === "client" && view.capabilities.includes(capability);
}
