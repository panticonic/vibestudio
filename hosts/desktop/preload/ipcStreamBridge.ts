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
  // The native event channel belongs to this renderer bridge, not to each
  // response body. Stream consumers retain their exact opId filtering and own
  // their subscriptions through terminal delivery or cancellation.
  const subscribers = new Set<(message: BridgeStreamMessage) => void>();
  const listener = (_event: IpcRendererEvent, message: BridgeStreamMessage) => {
    for (const subscriber of [...subscribers]) {
      if (subscribers.has(subscriber)) subscriber(message);
    }
  };
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
      // Wrap each subscription so registering one callback twice still gives
      // each caller independent, idempotent release ownership.
      const subscriber = (message: BridgeStreamMessage) => handler(message);
      if (subscribers.size === 0) ipcRenderer.on("vibestudio:rpc:stream-message", listener);
      subscribers.add(subscriber);
      return () => {
        if (!subscribers.delete(subscriber)) return;
        if (subscribers.size === 0) ipcRenderer.off("vibestudio:rpc:stream-message", listener);
      };
    },
  };
}
