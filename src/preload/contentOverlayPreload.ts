/**
 * Content-overlay preload — the bridge for the rich content overlay surface (a
 * shell React surface floated above the panels). Unlike the rows overlay preload
 * (which renders DOM itself under `script-src 'none'`), this document runs the
 * real shell bundle, so the preload is a thin IPC bridge only.
 *
 * Deliberately exposes NO RPC transport: the surface is pure presentation, fed
 * `props` from the chrome and emitting opaque `intent` payloads back. Keeping it
 * RPC-free avoids a second `selfId:"shell"` client colliding with the chrome's.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

const renderHandlers = new Set<(message: unknown) => void>();
// The surface mounts via an async dynamic import, so the first render message
// from main typically arrives before it subscribes. Buffer the latest and
// replay it on subscribe so the surface never misses its initial props.
let lastMessage: unknown = null;

ipcRenderer.on("vibez1:content-overlay:render", (_event: IpcRendererEvent, message: unknown) => {
  lastMessage = message;
  for (const handler of renderHandlers) handler(message);
});

// Clear (the overlay was hidden): drop the buffer and unmount any live surface
// so a reused overlay never flashes stale content on its next show.
ipcRenderer.on("vibez1:content-overlay:clear", () => {
  lastMessage = null;
  for (const handler of renderHandlers) handler(null);
});

contextBridge.exposeInMainWorld("__vibez1ContentOverlay", {
  onRender(handler: (message: unknown) => void) {
    renderHandlers.add(handler);
    if (lastMessage !== null) handler(lastMessage);
    return () => renderHandlers.delete(handler);
  },
  reportSize(height: number) {
    ipcRenderer.send("vibez1:content-overlay:size", { height });
  },
  emitIntent(payload: unknown) {
    ipcRenderer.send("vibez1:content-overlay:intent", { payload });
  },
  reportDrag(phase: "start" | "move" | "end", screenX: number, screenY: number) {
    ipcRenderer.send("vibez1:content-overlay:drag", { phase, screenX, screenY });
  },
});
