/**
 * App preload — privileged workspace-app bridge.
 *
 * The app principal is enforced in the main process from WebContents metadata;
 * this preload is only the renderer-facing transport surface.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { createIpcTransport } from "./ipcTransport.js";

let nextListenerId = 1;
const activeListeners = new Map<
  number,
  (event: IpcRendererEvent, eventName: string, payload: unknown) => void
>();
const appTransport = createIpcTransport();

const serviceCall = (method: string, ...args: unknown[]) =>
  ipcRenderer.invoke("vibez1:serviceCall", method, args);

const vibez1App = {
  getBootstrapConfig: () => ipcRenderer.invoke("vibez1:getPanelInit"),
  getInfo: () => ipcRenderer.invoke("vibez1:bridge.getInfo"),
  serviceCall,
  native: {
    menu: {
      call: (method: string, ...args: unknown[]) => serviceCall(`menu.${method}`, ...args),
    },
    notifications: {
      call: (method: string, ...args: unknown[]) => serviceCall(`notification.${method}`, ...args),
    },
    // No `tray` / `globalShortcut` bridges: the `tray` and `global-shortcut`
    // capabilities are declarable in the unit manifest but are NOT in this host's
    // supported set (ELECTRON_APP_HOST_CAPABILITIES in src/main/appOrchestrator.ts),
    // so an app requesting them is rejected before it ever loads. Exposing a
    // throwing stub here would only be a capability that lies about existing.
    fs: {
      call: (method: string, ...args: unknown[]) => serviceCall(`fs.${method}`, ...args),
    },
  },
  addEventListener: (handler: (event: string, payload: unknown) => void): number => {
    const id = nextListenerId++;
    const listener = (_e: IpcRendererEvent, event: string, payload: unknown) =>
      handler(event, payload);
    activeListeners.set(id, listener);
    ipcRenderer.on("vibez1:event", listener);
    return id;
  },
  removeEventListener: (id: number) => {
    const listener = activeListeners.get(id);
    if (listener) {
      ipcRenderer.off("vibez1:event", listener);
      activeListeners.delete(id);
    }
  },
};

contextBridge.exposeInMainWorld("__vibez1App", vibez1App);
contextBridge.exposeInMainWorld("__vibez1Transport", appTransport);
contextBridge.exposeInMainWorld("__vibez1ShellOverlay", {
  on(handler: (event: unknown) => void) {
    const listener = (_event: IpcRendererEvent, payload: unknown) => handler(payload);
    ipcRenderer.on("vibez1:shell-overlay:event", listener);
    return () => ipcRenderer.off("vibez1:shell-overlay:event", listener);
  },
});
// Intents forwarded from the content-overlay surface (a separate WebContents)
// back to the hosted shell that owns the surface's state + RPC.
contextBridge.exposeInMainWorld("__vibez1ContentOverlayHost", {
  on(handler: (payload: unknown) => void) {
    const listener = (_event: IpcRendererEvent, payload: unknown) => handler(payload);
    ipcRenderer.on("vibez1:content-overlay:forward", listener);
    return () => ipcRenderer.off("vibez1:content-overlay:forward", listener);
  },
});
contextBridge.exposeInMainWorld("__vibez1IncomingPairLink", {
  getPending() {
    return ipcRenderer.invoke("vibez1:drain-pair-link") as Promise<{
      url: string;
      code: string;
    } | null>;
  },
  onLink(handler: (link: { url: string; code: string }) => void) {
    const listener = (_event: IpcRendererEvent, payload: { url: string; code: string }) =>
      handler(payload);
    ipcRenderer.on("vibez1:incoming-pair-link", listener);
    return () => ipcRenderer.off("vibez1:incoming-pair-link", listener);
  },
});
