import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

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

  contextBridge.exposeInMainWorld("__vibestudioWebsiteNotifications", {
    show: (title: string, options: unknown) =>
      ipcRenderer.invoke("vibestudio:website-notification:show", title, options),
    close: (id: string) => ipcRenderer.invoke("vibestudio:website-notification:close", id),
    onEvent: (listener: (event: LifecycleEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });

  contextBridge.executeInMainWorld({ func: installNotificationCompatibilityLayer });
}

function isLifecycleEvent(value: unknown): value is LifecycleEvent {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["id"] === "string" && (record["type"] === "click" || record["type"] === "close")
  );
}

function installNotificationCompatibilityLayer(): void {
  type Bridge = {
    show(title: string, options: unknown): Promise<string>;
    close(id: string): Promise<void>;
    onEvent(listener: (event: { id: string; type: "click" | "close" }) => void): () => void;
  };
  const bridge = (globalThis as typeof globalThis & { __vibestudioWebsiteNotifications?: Bridge })
    .__vibestudioWebsiteNotifications;
  const NativeNotification = globalThis.Notification;
  if (!bridge || !NativeNotification) return;
  const api = bridge;

  const live = new Map<string, VibestudioNotification>();
  class VibestudioNotification extends EventTarget {
    static get permission(): NotificationPermission {
      return NativeNotification.permission;
    }

    static requestPermission(
      deprecatedCallback?: NotificationPermissionCallback
    ): Promise<NotificationPermission> {
      const result = NativeNotification.requestPermission();
      if (deprecatedCallback) void result.then(deprecatedCallback);
      return result;
    }

    readonly title: string;
    readonly body: string;
    readonly tag: string;
    readonly data: unknown;
    onclick: ((this: Notification, ev: Event) => unknown) | null = null;
    onshow: ((this: Notification, ev: Event) => unknown) | null = null;
    onerror: ((this: Notification, ev: Event) => unknown) | null = null;
    onclose: ((this: Notification, ev: Event) => unknown) | null = null;
    private notificationId: string | null = null;
    private closed = false;

    constructor(title: string, options: NotificationOptions = {}) {
      super();
      this.title = String(title);
      this.body = options.body ?? "";
      this.tag = options.tag ?? "";
      this.data = options.data;
      if (NativeNotification.permission !== "granted") {
        throw new DOMException("Notification permission has not been granted", "NotAllowedError");
      }
      void api
        .show(this.title, {
          body: this.body,
          tag: this.tag,
          silent: options.silent ?? false,
          icon: options.icon,
        })
        .then((id) => {
          if (this.closed) {
            void api.close(id);
            return;
          }
          this.notificationId = id;
          live.set(id, this);
          this.emit("show");
        })
        .catch(() => this.emit("error"));
    }

    close(): void {
      this.closed = true;
      if (!this.notificationId) return;
      const id = this.notificationId;
      this.notificationId = null;
      live.delete(id);
      void api.close(id);
    }

    emit(type: "show" | "click" | "error" | "close"): void {
      const event = new Event(type);
      this.dispatchEvent(event);
      const handler = this[`on${type}`] as ((event: Event) => unknown) | null;
      handler?.call(this as unknown as Notification, event);
    }
  }

  api.onEvent(({ id, type }) => {
    const notification = live.get(id);
    if (!notification) return;
    notification.emit(type);
    if (type === "close") live.delete(id);
  });
  Object.defineProperty(globalThis, "Notification", {
    value: VibestudioNotification,
    configurable: false,
    writable: false,
  });
  const registrationPrototype = globalThis.ServiceWorkerRegistration?.prototype;
  if (registrationPrototype) {
    Object.defineProperty(registrationPrototype, "showNotification", {
      value(title: string, options: NotificationOptions = {}): Promise<void> {
        new VibestudioNotification(String(title), options);
        return Promise.resolve();
      },
      configurable: false,
      writable: false,
    });
  }
}
