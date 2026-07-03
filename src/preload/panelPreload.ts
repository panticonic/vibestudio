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
} from "@vibez1/rpc";
import { createIpcTransport } from "./ipcTransport.js";

// ID-based event listener pattern (contextBridge cannot serialize closures)
let nextListenerId = 1;
const activeListeners = new Map<
  number,
  (event: IpcRendererEvent, eventName: string, payload: unknown) => void
>();

// Panel RPC over IPC (same `vibez1:rpc:send`/`:message` channels as the shell
// and app transports). Created once so this webview's inbound listener is wired.
const rpcTransport = createIpcTransport();

const vibez1Shell = {
  // Panel RPC envelope bridge — `createPanelTransport` posts each envelope to the
  // host (ipcDispatcher) as this panel's logical session and receives the demuxed
  // inbound envelopes; the desktop analogue of the mobile PanelWebView postMessage
  // bridge. Without these, getShellBridge() throws at panel startup (blank panel).
  postEnvelope: (envelope: RpcEnvelope) => rpcTransport.send(envelope),
  onEnvelope: (handler: (envelope: RpcEnvelope) => void) => rpcTransport.onMessage(handler),

  // §1.6 upload hop (see @vibez1/rpc bridgeStream.ts): streaming REQUEST bodies
  // cross the bridge as sequenced chunk messages; ipcDispatcher reassembles them
  // and feeds the panel's WebRTC session. Electron structured-clones Uint8Array,
  // so chunks ride binary (no base64). `streamBodyChunk` is invoke()d so the
  // host's resolution is the pump's backpressure.
  streamChunkFormat: "binary" as const,
  streamOpen: (msg: BridgeStreamOpen) => ipcRenderer.invoke("vibez1:rpc:stream-open", msg),
  streamBodyChunk: (msg: BridgeBodyChunk) =>
    ipcRenderer.invoke("vibez1:rpc:stream-body-chunk", msg),
  streamAbort: (opId: string) => ipcRenderer.send("vibez1:rpc:stream-abort", opId),
  streamAck: (opId: string, seq: number) =>
    ipcRenderer.send("vibez1:rpc:stream-ack", { opId, seq }),
  onStreamMessage: (handler: (msg: BridgeStreamMessage) => void) => {
    const listener = (_e: IpcRendererEvent, msg: BridgeStreamMessage) => handler(msg);
    ipcRenderer.on("vibez1:rpc:stream-message", listener);
    return () => ipcRenderer.off("vibez1:rpc:stream-message", listener);
  },

  getPanelInit: () => ipcRenderer.invoke("vibez1:getPanelInit"),
  getBootstrapConfig: () => ipcRenderer.invoke("vibez1:getPanelInit"),
  getInfo: () => ipcRenderer.invoke("vibez1:bridge.getInfo"),
  focusPanel: (panelId: string) => ipcRenderer.invoke("vibez1:focusPanel", panelId),

  // Electron-native
  openDevtools: () => ipcRenderer.invoke("vibez1:openDevtools"),
  openFolderDialog: (opts?: unknown) => ipcRenderer.invoke("vibez1:openFolderDialog", opts),
  openExternal: (url: string, options?: unknown) =>
    ipcRenderer.invoke("vibez1:openExternal", url, options),

  // Generic Electron service dispatch — lets panels call Electron-local services
  // (e.g., browser-data, autofill) via IPC instead of going through the server.
  serviceCall: (method: string, ...args: unknown[]) =>
    ipcRenderer.invoke("vibez1:serviceCall", method, args),

  // Event subscription (Electron→panel push: theme, focus, child-created)
  // Returns a numeric subscription ID; call removeEventListener(id) to unsubscribe.
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

contextBridge.exposeInMainWorld("__vibez1Shell", vibez1Shell);
