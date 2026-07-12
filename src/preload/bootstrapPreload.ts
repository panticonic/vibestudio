/**
 * Bootstrap launch-gate preload.
 *
 * This is deliberately smaller than the workspace app preload. The shipped
 * launch gate can only call the closed set of host RPC methods needed to
 * launch the selected host target and resolve the startup app approvals that
 * launch returns.
 */

import { contextBridge, ipcRenderer } from "electron";
import type { RpcEnvelope } from "@vibestudio/rpc";
import type { TransportBridge } from "./wsTransport.js";
import { assertBootstrapRpcMessageAllowed } from "./bootstrapTransportPolicy.js";

type EnvelopeHandler = (envelope: RpcEnvelope) => void;

type BootstrapBridge = {
  getState: () => Promise<unknown>;
  launchLocalWorkspace: (workspaceName: string) => Promise<unknown>;
  launchEphemeralWorkspace: () => Promise<unknown>;
  pairRemote: (payload: { link: string; label?: string }) => Promise<unknown>;
  retryStartup: () => Promise<unknown>;
  chooseConnection: () => Promise<unknown>;
  openLog: (path: string) => Promise<unknown>;
};

const bootstrapTransport: TransportBridge = (() => {
  const listeners = new Set<EnvelopeHandler>();

  ipcRenderer.on("vibestudio:rpc:message", (_event, envelope: RpcEnvelope) => {
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
      ipcRenderer.send("vibestudio:rpc:send", envelope);
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
  getState: () => ipcRenderer.invoke("vibestudio:bootstrap:get-state"),
  launchLocalWorkspace: (workspaceName) =>
    ipcRenderer.invoke("vibestudio:bootstrap:launch-local-workspace", workspaceName),
  launchEphemeralWorkspace: () =>
    ipcRenderer.invoke("vibestudio:bootstrap:launch-ephemeral-workspace"),
  pairRemote: (payload) => ipcRenderer.invoke("vibestudio:bootstrap:pair-remote", payload),
  retryStartup: () => ipcRenderer.invoke("vibestudio:bootstrap:retry-startup"),
  chooseConnection: () => ipcRenderer.invoke("vibestudio:bootstrap:choose-connection"),
  openLog: (path) => ipcRenderer.invoke("vibestudio:bootstrap:open-log", path),
};

contextBridge.exposeInMainWorld("__vibestudioTransport", bootstrapTransport);
contextBridge.exposeInMainWorld("__vibestudioBootstrap", bootstrapBridge);
