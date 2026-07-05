/**
 * Shared `__vibestudio_autofill` bridge for browser-panel preloads.
 *
 * This global is registered by TWO preload entry points — browserPreload.ts and
 * autofillPreload.ts — but both attach to the SAME surface: browser panels
 * (external URLs) created by PanelView.createViewForBrowser, which selects
 * `browserPreloadPath ?? autofillPreloadPath`. browserPreload is the live path
 * (browserPreloadPath is always set in src/main/index.ts); autofillPreload
 * remains only as the defensive `??` fallback. They exist as two esbuild entry
 * points, so the actual bridge shape lives here once to prevent the exposed
 * global and channel name from drifting between them.
 *
 * The bridge intentionally carries only an argless ping() notification: browser
 * panels load arbitrary web content and must NOT be handed any host IPC surface.
 */
import { contextBridge, ipcRenderer } from "electron";

export function exposeAutofillBridge(): void {
  contextBridge.exposeInMainWorld("__vibestudio_autofill", {
    ping: () => ipcRenderer.send("vibestudio:autofill:ping"),
  });
}
