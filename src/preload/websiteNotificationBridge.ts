import { WEBSITE_NOTIFICATION_COMPATIBILITY_SCRIPT } from "@vibestudio/shared/websiteNotificationCompatibility";
import { contextBridge, ipcRenderer, webFrame, type IpcRendererEvent } from "electron";

type LifecycleEvent = { id: string; type: "click" | "close" };

export function exposeWebsiteNotificationBridge(): void {
  const listeners = new Set<(event: LifecycleEvent) => void>();
  ipcRenderer.on(
    "vibestudio:website-notification:event",
    (_event: IpcRendererEvent, payload: unknown) => {
      if (!isLifecycleEvent(payload)) return;
      for (const listener of listeners) listener(payload);
    }
  );

  const NativeNotification = globalThis.Notification;
  contextBridge.exposeInMainWorld("__vibestudioWebsiteNotifications", {
    permission: () => NativeNotification.permission,
    requestPermission: () => NativeNotification.requestPermission(),
    show: (title: string, options: unknown) =>
      ipcRenderer.invoke("vibestudio:website-notification:show", title, options),
    close: (id: string) => ipcRenderer.invoke("vibestudio:website-notification:close", id),
    onEvent: (listener: (event: LifecycleEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });

  // Inject the same bundled document source used by mobile, without compiling
  // strings into functions or exposing an evaluator to the page.
  void webFrame.executeJavaScript(WEBSITE_NOTIFICATION_COMPATIBILITY_SCRIPT).catch((error) => {
    console.error("Website notification compatibility could not be installed", error);
  });
}

function isLifecycleEvent(value: unknown): value is LifecycleEvent {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["id"] === "string" && (record["type"] === "click" || record["type"] === "close")
  );
}
