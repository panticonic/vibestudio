import { readWorkspaceTransportIdentity } from "./workspaceTransportIdentity.js";
/**
 * Client preload: the `web-host-1` bridge every web client runs against.
 *
 * The client principal is attested by the main process from WebContents
 * metadata when it hands this document its RPC port; this preload is only the
 * renderer-facing surface. Everything a
 * client may ask of the host sits behind a capability the host checks on every
 * call, so a client that was not granted one gets a rejection, not a stub.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { createRpcPortTransport } from "./rpcPortTransport.js";
import type { WorkspaceConnectionState } from "@vibestudio/shared/workspaceConnection";

interface ClientUpdateOffer {
  clientId: string;
  source: string;
  buildKey: string;
  effectiveVersion: string | null;
  previousEffectiveVersion: string | null;
}

let nextListenerId = 1;
const activeListeners = new Map<
  number,
  (event: IpcRendererEvent, eventName: string, payload: unknown) => void
>();
const identity = readWorkspaceTransportIdentity(process.argv);
// RPC runs over one port straight to the connection process; main only hands it out.
const rpc = createRpcPortTransport({ homeWorkspaceId: identity.workspaceId });
const clientTransport = { ...rpc.transport, ...rpc.streams, identity };
rpc.open();

const vibestudioClient = {
  /** Which client this is, its principal, build and granted capabilities. */
  describe: () => ipcRenderer.invoke("vibestudio:client:describe"),
  getBootstrapConfig: () => ipcRenderer.invoke("vibestudio:getPanelInit"),
  getInfo: () => ipcRenderer.invoke("vibestudio:bridge.getInfo"),
  getProcessPerformanceSnapshot: () => ipcRenderer.invoke("vibestudio:performance.snapshot"),
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
  // response: a nudge, never a teardown.
  notifyNetworkOnline: () => ipcRenderer.send("vibestudio:shell.network-online"),
  // Tell main whether DOM focus is currently on a chrome control. The native
  // key forwarder must leave keyboard input in the client while a user is
  // operating breadcrumbs, the sidebar, dialogs, or form controls.
  setChromeInteractiveFocus: (active: boolean) =>
    ipcRenderer.send("vibestudio:shell.chrome-interactive-focus", active),
  // Native panel views sit above the client in Electron's compositor. Dialog
  // visibility is therefore a window-host concern, not a workspace RPC: it
  // must remain writable while the workspace server is unavailable.
  setShellOverlayActive: (active: boolean) =>
    ipcRenderer.send("vibestudio:shell.overlay-active", active),
  inspectWorkspaceFolder: () => ipcRenderer.invoke("vibestudio:inspectWorkspaceFolder"),
  /** This client's own pending update (every client may take its own; none another's). */
  update: {
    pending: () =>
      ipcRenderer.invoke("vibestudio:client:update-pending") as Promise<ClientUpdateOffer | null>,
    onUpdate(handler: (offer: ClientUpdateOffer | null) => void) {
      const listener = (_event: IpcRendererEvent, offer: ClientUpdateOffer | null) =>
        handler(offer);
      ipcRenderer.on("vibestudio:client-update", listener);
      return () => ipcRenderer.off("vibestudio:client-update", listener);
    },
    restartAtSafePoint: () => ipcRenderer.invoke("vibestudio:client:update-apply") as Promise<void>,
  },
  /** Persisted per client per device, one bounded JSON object, written atomically by the host. */
  state: {
    get: () =>
      ipcRenderer.invoke("vibestudio:client:state-get") as Promise<Record<string, unknown>>,
    set: (value: Record<string, unknown>) =>
      ipcRenderer.invoke("vibestudio:client:state-set", value) as Promise<void>,
  },
  /** `native-menus`: contribute the application menu and the client's own popup. */
  menu: {
    set: (model: unknown) => ipcRenderer.invoke("vibestudio:menu:set", model) as Promise<void>,
    onAction(handler: (actionId: string) => void) {
      const listener = (_event: IpcRendererEvent, actionId: string) => handler(actionId);
      ipcRenderer.on("vibestudio:menu-action", listener);
      return () => ipcRenderer.off("vibestudio:menu-action", listener);
    },
  },
  /** Foreground intents (`vibestudio://c/<id>/<intent>`): held until subscribed, then live. */
  intents: {
    subscribe(handler: (intent: { name: string; params: Record<string, string> }) => void) {
      const listener = (
        _event: IpcRendererEvent,
        intent: { name: string; params: Record<string, string> }
      ) => handler(intent);
      ipcRenderer.on("vibestudio:client-intent", listener);
      void ipcRenderer.invoke("vibestudio:client-intent:subscribe");
      return () => ipcRenderer.off("vibestudio:client-intent", listener);
    },
  },
  /** `integration.install`: add or remove OS launchers for clients; the host confirms with the person. */
  integration: {
    install: (clientId: string) =>
      ipcRenderer.invoke("vibestudio:integration:install", clientId) as Promise<{
        installed: boolean;
      }>,
    remove: (clientId: string) =>
      ipcRenderer.invoke("vibestudio:integration:remove", clientId) as Promise<void>,
    installed: () => ipcRenderer.invoke("vibestudio:integration:installed") as Promise<string[]>,
  },
  /** `global-shortcut`: a system-wide chord that runs one of this client's intents. */
  shortcut: {
    register: (request: {
      id: string;
      accelerator: string;
      intent: string;
      params?: Record<string, string>;
    }) => ipcRenderer.invoke("vibestudio:shortcut:register", request) as Promise<void>,
    unregister: (id: string) =>
      ipcRenderer.invoke("vibestudio:shortcut:unregister", id) as Promise<void>,
    list: () => ipcRenderer.invoke("vibestudio:shortcut:list"),
  },
  /** `tray`: this client's system-tray icon and menu. */
  tray: {
    set: (model: { tooltip?: string; items: unknown[] }) =>
      ipcRenderer.invoke("vibestudio:tray:set", model) as Promise<void>,
    clear: () => ipcRenderer.invoke("vibestudio:tray:clear") as Promise<void>,
    onAction(handler: (actionId: string) => void) {
      const listener = (_event: IpcRendererEvent, actionId: string) => handler(actionId);
      ipcRenderer.on("vibestudio:tray-action", listener);
      return () => ipcRenderer.off("vibestudio:tray-action", listener);
    },
  },
  /** `badge`: this client's share of the application icon's badge count. */
  badge: {
    set: (count: number) => ipcRenderer.invoke("vibestudio:badge:set", count) as Promise<void>,
  },
  /** `panel-hosting`: what only the compositor can do to the panel surface. */
  panelHost: {
    run: (action: string) =>
      ipcRenderer.invoke("vibestudio:panel-host:run", action) as Promise<void>,
  },
  /** `device-session`: development mode for a client on this device. */
  development: {
    setMode: (clientId: string, enabled: boolean) =>
      ipcRenderer.invoke(
        "vibestudio:client:set-development-mode",
        clientId,
        enabled
      ) as Promise<void>,
  },
};

contextBridge.exposeInMainWorld("__vibestudioClient", vibestudioClient);
contextBridge.exposeInMainWorld("__vibestudioNativePanels", {
  openWorkspace: (workspaceId: string) =>
    ipcRenderer.invoke("vibestudio:shell.workspace-open", workspaceId),
  connectNativePanelAdapter: (hello: unknown) =>
    ipcRenderer.invoke("vibestudio:shell.panels-connect", hello),
  applyNativePanelSurfaces: (snapshot: unknown) =>
    ipcRenderer.invoke("vibestudio:shell.panels-apply", snapshot),
});
contextBridge.exposeInMainWorld("__vibestudioTransport", clientTransport);
contextBridge.exposeInMainWorld("__vibestudioWorkspaceConnection", {
  getCurrent: () =>
    ipcRenderer.invoke(
      "vibestudio:workspace-connection-state:get"
    ) as Promise<WorkspaceConnectionState>,
  onChange(handler: (state: WorkspaceConnectionState) => void) {
    const listener = (_event: IpcRendererEvent, state: WorkspaceConnectionState) => handler(state);
    ipcRenderer.on("vibestudio:workspace-connection-state", listener);
    return () => ipcRenderer.off("vibestudio:workspace-connection-state", listener);
  },
});
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
contextBridge.exposeInMainWorld("__vibestudioIncomingShellSurface", {
  /** A surface deep link that arrived before the shell mounted; null otherwise. */
  getPending() {
    return ipcRenderer.invoke("vibestudio:drain-shell-surface") as Promise<unknown>;
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
  openLocation(location: unknown) {
    return ipcRenderer.invoke("vibestudio:open-panel-location", location) as Promise<void>;
  },
});
