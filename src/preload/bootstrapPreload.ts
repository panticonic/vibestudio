/**
 * Bootstrap launch-gate preload.
 *
 * This is deliberately smaller than the workspace app preload. The shipped
 * launch gate can only call the closed set of host RPC methods needed to
 * launch the selected host target and resolve the startup app approvals that
 * launch returns.
 */

import { contextBridge, ipcRenderer } from "electron";
import type { RpcEnvelope } from "@vibez1/rpc";
import type { TransportBridge } from "./wsTransport.js";
import { assertBootstrapRpcMessageAllowed } from "./bootstrapTransportPolicy.js";

type EnvelopeHandler = (envelope: RpcEnvelope) => void;

type BootstrapBridge = {
  getState: () => Promise<unknown>;
  launchLocalWorkspace: (workspaceName: string) => Promise<unknown>;
  launchEphemeralWorkspace: () => Promise<unknown>;
  pairRemote: (payload: { link: string; label?: string }) => Promise<unknown>;
};

const bootstrapTransport: TransportBridge = (() => {
  const listeners = new Set<EnvelopeHandler>();

  ipcRenderer.on("vibez1:rpc:message", (_event, envelope: RpcEnvelope) => {
    for (const listener of listeners) {
      try {
        listener(envelope);
      } catch (error) {
        console.error("Error in bootstrap transport message handler:", error);
      }
    }
  });

  return {
    async send(envelope: RpcEnvelope): Promise<void> {
      assertBootstrapRpcMessageAllowed(envelope.target, envelope.message);
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
})();

const bootstrapBridge: BootstrapBridge = {
  getState: () => ipcRenderer.invoke("vibez1:bootstrap:get-state"),
  launchLocalWorkspace: (workspaceName) =>
    ipcRenderer.invoke("vibez1:bootstrap:launch-local-workspace", workspaceName),
  launchEphemeralWorkspace: () => ipcRenderer.invoke("vibez1:bootstrap:launch-ephemeral-workspace"),
  pairRemote: (payload) => ipcRenderer.invoke("vibez1:bootstrap:pair-remote", payload),
};

contextBridge.exposeInMainWorld("__vibez1Transport", bootstrapTransport);
contextBridge.exposeInMainWorld("__vibez1Bootstrap", bootstrapBridge);
