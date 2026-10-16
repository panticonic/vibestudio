/**
 * Preload of the compact ask window: host UI for a background intent run from a
 * global shortcut. It holds no session; it hands the typed text to the host and
 * shows the text the host returns.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("__vibestudioAsk", {
  submit: (text: string) => ipcRenderer.invoke("vibestudio:ask:submit", text) as Promise<string>,
  close: () => ipcRenderer.send("vibestudio:ask:close"),
});
