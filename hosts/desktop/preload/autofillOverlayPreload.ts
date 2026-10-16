import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("__vibestudio_autofill_overlay", {
  select: (id: number) => ipcRenderer.send("vibestudio:autofill-overlay:select", id),
  dismiss: () => ipcRenderer.send("vibestudio:autofill-overlay:dismiss"),
});
