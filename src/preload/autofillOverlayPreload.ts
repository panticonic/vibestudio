import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("__vibez1_autofill_overlay", {
  select: (id: number) => ipcRenderer.send("vibez1:autofill-overlay:select", id),
  dismiss: () => ipcRenderer.send("vibez1:autofill-overlay:dismiss"),
});
