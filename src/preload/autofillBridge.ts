/**
 * `__vibestudio_autofill` bridge for browser panels (external URLs), installed by
 * browserPreload.ts alongside the other browser-surface bridges.
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
