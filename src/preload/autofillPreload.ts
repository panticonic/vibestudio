import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("__vibez1_autofill", {
  ping: () => ipcRenderer.send("vibez1:autofill:ping"),
});
