/**
 * Panel preload — exposes the host-local shell bridge.
 *
 * App panels only get this preload. Browser panels (external URLs) do NOT —
 * they get browserPreload.ts with autofill only.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  BridgeBodyChunk,
  BridgeStreamMessage,
  BridgeStreamOpen,
  RpcEnvelope,
} from "@vibestudio/rpc";
import { createIpcTransport } from "./ipcTransport.js";

// ID-based event listener pattern (contextBridge cannot serialize closures)
let nextListenerId = 1;
const activeListeners = new Map<
  number,
  (event: IpcRendererEvent, eventName: string, payload: unknown) => void
>();

// Panel RPC over IPC (same `vibestudio:rpc:send`/`:message` channels as the shell
// and app transports). Created once so this webview's inbound listener is wired.
const rpcTransport = createIpcTransport();

const vibestudioShell = {
  // Panel RPC envelope bridge — `createPanelTransport` posts each envelope to the
  // host (ipcDispatcher) as this panel's logical session and receives the demuxed
  // inbound envelopes; the desktop analogue of the mobile PanelWebView postMessage
  // bridge. Without these, getShellBridge() throws at panel startup (blank panel).
  postEnvelope: (envelope: RpcEnvelope) => rpcTransport.send(envelope),
  onEnvelope: (handler: (envelope: RpcEnvelope) => void) => rpcTransport.onMessage(handler),

  // §1.6 upload hop (see @vibestudio/rpc bridgeStream.ts): streaming REQUEST bodies
  // cross the bridge as sequenced chunk messages; ipcDispatcher reassembles them
  // and feeds the panel's WebRTC session. Electron structured-clones Uint8Array,
  // so chunks ride binary (no base64). `streamBodyChunk` is invoke()d so the
  // host's resolution is the pump's backpressure.
  streamChunkFormat: "binary" as const,
  streamOpen: (msg: BridgeStreamOpen) => ipcRenderer.invoke("vibestudio:rpc:stream-open", msg),
  streamBodyChunk: (msg: BridgeBodyChunk) =>
    ipcRenderer.invoke("vibestudio:rpc:stream-body-chunk", msg),
  streamAbort: (opId: string) => ipcRenderer.send("vibestudio:rpc:stream-abort", opId),
  streamAck: (opId: string, seq: number) =>
    ipcRenderer.send("vibestudio:rpc:stream-ack", { opId, seq }),
  onStreamMessage: (handler: (msg: BridgeStreamMessage) => void) => {
    const listener = (_e: IpcRendererEvent, msg: BridgeStreamMessage) => handler(msg);
    ipcRenderer.on("vibestudio:rpc:stream-message", listener);
    return () => ipcRenderer.off("vibestudio:rpc:stream-message", listener);
  },

  getPanelInit: () => ipcRenderer.invoke("vibestudio:getPanelInit"),
  getBootstrapConfig: () => ipcRenderer.invoke("vibestudio:getPanelInit"),
  getInfo: () => ipcRenderer.invoke("vibestudio:bridge.getInfo"),
  focusPanel: (panelId: string) => ipcRenderer.invoke("vibestudio:focusPanel", panelId),

  // Electron-native
  openDevtools: () => ipcRenderer.invoke("vibestudio:openDevtools"),
  openFolderDialog: (opts?: unknown) => ipcRenderer.invoke("vibestudio:openFolderDialog", opts),
  openExternal: (url: string, options?: unknown) =>
    ipcRenderer.invoke("vibestudio:openExternal", url, options),

  // Generic Electron service dispatch — lets panels call Electron-local services
  // (e.g., browser-data, autofill) via IPC instead of going through the server.
  serviceCall: (method: string, ...args: unknown[]) =>
    ipcRenderer.invoke("vibestudio:serviceCall", method, args),

  // Event subscription (Electron→panel push: theme, focus, child-created)
  // Returns a numeric subscription ID; call removeEventListener(id) to unsubscribe.
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
};

contextBridge.exposeInMainWorld("__vibestudioShell", vibestudioShell);
