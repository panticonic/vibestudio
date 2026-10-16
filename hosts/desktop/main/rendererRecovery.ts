import { randomUUID } from "node:crypto";
import { ipcMain, type WebContents } from "electron";
import type { RecoveryKind } from "@vibestudio/rpc/protocol/recoveryCoordinator";

/** Recovery belongs to this renderer incarnation and workspace generation. */
export function recoverRenderer(
  contents: WebContents,
  kind: RecoveryKind,
  workspaceId: string,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted();
  if (contents.isDestroyed()) return Promise.reject(new Error("Recovery renderer was destroyed"));
  const requestId = randomUUID();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (error?: unknown) => {
      if (settled) return;
      settled = true;
      ipcMain.off("vibestudio:rpc:recovered", recovered);
      contents.removeListener("destroyed", destroyed);
      contents.removeListener("render-process-gone", destroyed);
      contents.removeListener("did-start-navigation", navigated);
      signal.removeEventListener("abort", aborted);
      if (error !== undefined) reject(error);
      else resolve();
    };
    const recovered = (
      event: Electron.IpcMainEvent,
      id: unknown,
      failure?: { message?: unknown; code?: unknown; errorKind?: unknown }
    ) => {
      if (event.sender !== contents || id !== requestId) return;
      if (failure) {
        const error = new Error(
          typeof failure.message === "string" ? failure.message : "Renderer recovery failed"
        );
        if (typeof failure.code === "string") Object.assign(error, { code: failure.code });
        if (typeof failure.errorKind === "string")
          Object.assign(error, { errorKind: failure.errorKind });
        settle(error);
      } else settle();
    };
    const destroyed = () => settle(new Error("Renderer ended during recovery"));
    const navigated = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
      if (mainFrame && !inPlace) settle(new Error("Renderer replaced during recovery"));
    };
    const aborted = () => settle(signal.reason);
    ipcMain.on("vibestudio:rpc:recovered", recovered);
    contents.once("destroyed", destroyed);
    contents.once("render-process-gone", destroyed);
    contents.on("did-start-navigation", navigated);
    signal.addEventListener("abort", aborted, { once: true });
    try {
      contents.send("vibestudio:rpc:recovery", kind, workspaceId, requestId);
    } catch (error) {
      settle(error);
    }
  });
}
