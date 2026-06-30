/**
 * IPC transport bridge for the shell renderer.
 *
 * Replaces the WebSocket transport with Electron IPC (ipcRenderer ↔ ipcMain).
 * The shell no longer needs a WebSocket connection to the RPC server.
 */

import { ipcRenderer } from "electron";
import type { RpcEnvelope } from "@vibez1/rpc";
import type { TransportBridge } from "./wsTransport.js";

type EnvelopeHandler = (envelope: RpcEnvelope) => void;

/**
 * Create an IPC-based transport bridge for the shell.
 *
 * Messages are sent via ipcRenderer.send("vibez1:rpc:send", envelope)
 * and received via ipcRenderer.on("vibez1:rpc:message", (event, envelope)).
 */
export function createIpcTransport(): TransportBridge {
  const listeners = new Set<EnvelopeHandler>();

  // Receive messages from main process
  ipcRenderer.on("vibez1:rpc:message", (_event, envelope: RpcEnvelope) => {
    for (const listener of listeners) {
      try {
        listener(envelope);
      } catch (error) {
        console.error("Error in IPC transport message handler:", error);
      }
    }
  });

  return {
    async send(envelope: RpcEnvelope): Promise<void> {
      ipcRenderer.send("vibez1:rpc:send", envelope);
    },

    onMessage(handler: EnvelopeHandler): () => void {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },

    onRecovery(): () => void {
      return () => {};
    },
  };
}
