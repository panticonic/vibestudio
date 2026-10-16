/**
 * Launch-gate preload.
 *
 * The gate is host UI that exists before any client does. It holds no session
 * and makes no RPC call: the host pushes launch and connection state to it, and
 * it asks the host (a closed set of IPC channels) to relay the person's choices.
 */

import { contextBridge, ipcRenderer } from "electron";

type BootstrapBridge = {
  getState: () => Promise<unknown>;
  getLaunchState: () => Promise<unknown>;
  resolveApprovals: (decision: "once" | "deny") => Promise<unknown>;
  launchLocalWorkspace: (workspaceName: string) => Promise<unknown>;
  pairRemote: (payload: { link: string; label?: string }) => Promise<unknown>;
  retryStartup: () => Promise<unknown>;
  chooseConnection: () => Promise<unknown>;
  openLog: (path: string) => Promise<unknown>;
  onStateChanged: (handler: (state: unknown) => void) => () => void;
  onLaunchState: (handler: (state: unknown) => void) => () => void;
};

function subscribe(channel: string, handler: (state: unknown) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, state: unknown): void => handler(state);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const bootstrapBridge: BootstrapBridge = {
  getState: () => ipcRenderer.invoke("vibestudio:bootstrap:get-state"),
  getLaunchState: () => ipcRenderer.invoke("vibestudio:bootstrap:get-launch-state"),
  resolveApprovals: (decision) =>
    ipcRenderer.invoke("vibestudio:bootstrap:resolve-approvals", decision),
  launchLocalWorkspace: (workspaceName) =>
    ipcRenderer.invoke("vibestudio:bootstrap:launch-local-workspace", workspaceName),
  pairRemote: (payload) => ipcRenderer.invoke("vibestudio:bootstrap:pair-remote", payload),
  retryStartup: () => ipcRenderer.invoke("vibestudio:bootstrap:retry-startup"),
  chooseConnection: () => ipcRenderer.invoke("vibestudio:bootstrap:choose-connection"),
  openLog: (path) => ipcRenderer.invoke("vibestudio:bootstrap:open-log", path),
  onStateChanged: (handler) => subscribe("vibestudio:bootstrap:state-changed", handler),
  onLaunchState: (handler) => subscribe("vibestudio:bootstrap:launch-state", handler),
};

contextBridge.exposeInMainWorld("__vibestudioBootstrap", bootstrapBridge);
