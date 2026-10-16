import { contextBridge, ipcRenderer } from "electron";
import type { WorkspaceProvider } from "@vibestudio/rpc";
import { createIpcTransport } from "./ipcTransport.js";
import { createIpcStreamBridge } from "./ipcStreamBridge.js";
import { createWebsiteConnectionIntent } from "./websiteConnectionIntent.js";

/** A document-private handshake; neither the challenge nor native IPC is exposed. */
export function exposeWebsiteWorkspaceProvider(): void {
  if (!process.isMainFrame) return;
  const intent = createWebsiteConnectionIntent(
    globalThis.document,
    () => navigator.userActivation.isActive
  );
  const document = ipcRenderer.invoke("vibestudio:website:document") as Promise<string>;
  // Loading an ordinary website is valid even if presentation ownership is gone.
  void document.catch(() => {});
  const transport = createIpcTransport();
  const streams = createIpcStreamBridge();
  const listeners = new Set<() => void>();
  let connected = false;
  let generation = 0;
  const requireConnection = () => {
    if (!connected)
      throw Object.assign(new Error("Connect this website to the workspace first"), {
        code: "EWORKSPACE_DISCONNECTED",
      });
  };
  ipcRenderer.on("vibestudio:website:disconnected", () => {
    ++generation;
    connected = false;
    for (const listener of [...listeners]) listener();
  });
  const provider: WorkspaceProvider = {
    async connect() {
      if (!connected) intent.consume();
      const attempt = generation;
      const result = await ipcRenderer.invoke("vibestudio:website:connect", await document);
      if (attempt !== generation) throw new Error("Website connection was retired");
      connected = true;
      return result;
    },
    async disconnect() {
      ++generation;
      connected = false;
      await ipcRenderer.invoke("vibestudio:website:disconnect", await document);
    },
    onDisconnect(handler) {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
    postEnvelope(envelope) {
      requireConnection();
      return transport.send(envelope);
    },
    onEnvelope(handler) {
      return transport.onMessage((envelope) => {
        if (connected) handler(envelope);
      });
    },
    streamChunkFormat: "binary",
    streamOpen(message) {
      requireConnection();
      return streams.streamOpen(message);
    },
    streamBodyChunk(message) {
      requireConnection();
      return streams.streamBodyChunk(message);
    },
    streamAbort(opId) {
      requireConnection();
      return streams.streamAbort(opId);
    },
    streamAck(opId, seq) {
      requireConnection();
      return streams.streamAck(opId, seq);
    },
    onStreamMessage(handler) {
      return streams.onStreamMessage((message) => {
        if (connected) handler(message);
      });
    },
  };
  contextBridge.exposeInMainWorld("vibestudio", provider);
}
