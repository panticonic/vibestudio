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
  ipcRenderer.invoke("vibestudio:serviceCall", method, args);

const vibestudioApp = {
  getBootstrapConfig: () => ipcRenderer.invoke("vibestudio:getPanelInit"),
  getInfo: () => ipcRenderer.invoke("vibestudio:bridge.getInfo"),
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
    ipcRenderer.on("vibestudio:event", listener);
    return id;
  },
  removeEventListener: (id: number) => {
    const listener = activeListeners.get(id);
    if (listener) {
      ipcRenderer.off("vibestudio:event", listener);
      activeListeners.delete(id);
    }
  },
  // Fire-and-forget signal that the renderer regained network connectivity, so
  // main can nudge the (possibly stale-"connected") server pipe awake. No
  // response — a nudge, never a teardown.
  notifyNetworkOnline: () => ipcRenderer.send("vibestudio:shell.network-online"),
  // Tell main whether DOM focus is currently on a chrome control. The native
  // key forwarder must leave keyboard input in the shell while a user is
  // operating breadcrumbs, the sidebar, dialogs, or form controls.
  setChromeInteractiveFocus: (active: boolean) =>
    ipcRenderer.send("vibestudio:shell.chrome-interactive-focus", active),
};

contextBridge.exposeInMainWorld("__vibestudioApp", vibestudioApp);
contextBridge.exposeInMainWorld("__vibestudioTransport", appTransport);
contextBridge.exposeInMainWorld("__vibestudioShellOverlay", {
  on(handler: (event: unknown) => void) {
    const listener = (_event: IpcRendererEvent, payload: unknown) => handler(payload);
    ipcRenderer.on("vibestudio:shell-overlay:event", listener);
    return () => ipcRenderer.off("vibestudio:shell-overlay:event", listener);
  },
});
// Intents forwarded from the content-overlay surface (a separate WebContents)
// back to the hosted shell that owns the surface's state + RPC.
contextBridge.exposeInMainWorld("__vibestudioContentOverlayHost", {
  on(handler: (payload: unknown) => void) {
    const listener = (_event: IpcRendererEvent, payload: unknown) => handler(payload);
    ipcRenderer.on("vibestudio:content-overlay:forward", listener);
    return () => ipcRenderer.off("vibestudio:content-overlay:forward", listener);
  },
});
contextBridge.exposeInMainWorld("__vibestudioIncomingPairLink", {
  getPending() {
    return ipcRenderer.invoke("vibestudio:drain-pair-link") as Promise<{
      url: string;
      code: string;
    } | null>;
  },
  onLink(handler: (link: { url: string; code: string }) => void) {
    const listener = (_event: IpcRendererEvent, payload: { url: string; code: string }) =>
      handler(payload);
    ipcRenderer.on("vibestudio:incoming-pair-link", listener);
    return () => ipcRenderer.off("vibestudio:incoming-pair-link", listener);
  },
});
contextBridge.exposeInMainWorld("__vibestudioIncomingPanelLocation", {
  getPending() {
    return ipcRenderer.invoke("vibestudio:drain-panel-location") as Promise<unknown>;
  },
  onLocation(handler: (location: unknown) => void) {
    const listener = (_event: IpcRendererEvent, location: unknown) => handler(location);
    ipcRenderer.on("vibestudio:incoming-panel-location", listener);
    return () => ipcRenderer.off("vibestudio:incoming-panel-location", listener);
  },
  prepareWorkspaceRelaunch(location: unknown) {
    return ipcRenderer.invoke(
      "vibestudio:prepare-panel-location-relaunch",
      location
    ) as Promise<void>;
  },
});
