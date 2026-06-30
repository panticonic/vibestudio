/**
 * Browser panel preload — autofill only (no __vibez1Electron).
 *
 * Browser panels load arbitrary external websites and must NOT have access
 * to host IPC. Only password autofill is injected.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("__vibez1_autofill", {
  ping: () => ipcRenderer.send("vibez1:autofill:ping"),
});
