import { ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  BridgeBodyChunk,
  BridgeStreamMessage,
  BridgeStreamOpen,
  BridgeStreamShellSurface,
} from "@vibestudio/rpc";

/** One binary, backpressured streaming carrier for panel and app renderers.
 * Main authenticates each WebContents; these methods confer no authority. */
export function createIpcStreamBridge(): BridgeStreamShellSurface {
  return {
    streamChunkFormat: "binary",
    streamOpen: (message: BridgeStreamOpen) =>
      ipcRenderer.invoke("vibestudio:rpc:stream-open", message),
    streamBodyChunk: (message: BridgeBodyChunk) =>
      ipcRenderer.invoke("vibestudio:rpc:stream-body-chunk", message),
    streamAbort: (opId: string) => ipcRenderer.send("vibestudio:rpc:stream-abort", opId),
    streamAck: (opId: string, seq: number) =>
      ipcRenderer.send("vibestudio:rpc:stream-ack", { opId, seq }),
    onStreamMessage(handler: (message: BridgeStreamMessage) => void) {
      const listener = (_event: IpcRendererEvent, message: BridgeStreamMessage) => handler(message);
      ipcRenderer.on("vibestudio:rpc:stream-message", listener);
      return () => ipcRenderer.off("vibestudio:rpc:stream-message", listener);
    },
  };
}
