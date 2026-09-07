export type WebsiteNotificationPermission = "default" | "denied" | "granted";

export interface WebsiteNotificationAdapter {
  permission(): WebsiteNotificationPermission;
  requestPermission(): Promise<WebsiteNotificationPermission>;
  show(title: string, options: unknown): Promise<string>;
  close(id: string): Promise<void>;
  onEvent(listener: (event: { id: string; type: "click" | "close" }) => void): () => void;
}

/**
 * One document script for Electron and mobile WebViews. Keep this self-contained:
 * mobile injects source text and must not recover it from Hermes function bytecode.
 * The native adapter owns permissions and delivery; page-supplied identity is never authority.
 */
export const WEBSITE_NOTIFICATION_COMPATIBILITY_SCRIPT = String.raw`
(() => {
  const api = globalThis.__vibestudioWebsiteNotifications;
  if (!api) return;
  const live = new Map();
  const pending = new Set();
  const earlyEvents = new Map();
  class WorkspaceNotification extends EventTarget {
    static get permission() { return api.permission(); }
    static requestPermission(callback) {
      const result = api.requestPermission();
      if (callback) void result.then(callback);
      return result;
    }
    constructor(title, options = {}) {
      super();
      this.title = String(title);
      this.body = options.body ?? "";
      this.tag = options.tag ?? "";
      this.data = options.data;
      this.onclick = null;
      this.onshow = null;
      this.onerror = null;
      this.onclose = null;
      this.notificationId = null;
      this.closed = false;
      this.closeDelivered = false;
      if (api.permission() !== "granted") {
        throw new DOMException("Notification permission has not been granted", "NotAllowedError");
      }
      pending.add(this);
      this.accepted = Promise.resolve().then(() => api.show(this.title, {
        body: this.body, tag: this.tag, silent: options.silent ?? false, icon: options.icon,
      })).then((id) => {
        this.notificationId = id;
        live.set(id, this);
        const events = earlyEvents.get(id) ?? [];
        earlyEvents.delete(id);
        if (!this.closed) this.emit("show");
        for (const type of events) deliver(id, type);
        if (this.closed && !this.closeDelivered) return this.closeAccepted();
      }).finally(() => {
        pending.delete(this);
        if (pending.size === 0) earlyEvents.clear();
      });
      // Notification construction is synchronous; failures arrive as events.
      // The same promise also gives showNotification its actual acceptance outcome.
      void this.accepted.catch(() => {
        if (!this.closed) this.emit("error");
      });
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      if (this.notificationId) void this.closeAccepted().catch(() => this.emit("error"));
    }
    async closeAccepted() {
      const id = this.notificationId;
      if (!id) return;
      await api.close(id);
      // Some native carriers deliver close before their acknowledgement, others after.
      // Complete once in either order, including a close before show was accepted.
      this.finishClose();
    }
    finishClose() {
      if (this.closeDelivered) return;
      this.closeDelivered = true;
      this.closed = true;
      if (this.notificationId) live.delete(this.notificationId);
      this.notificationId = null;
      this.emit("close");
    }
    emit(type) {
      const event = new Event(type);
      this.dispatchEvent(event);
      const handler = this["on" + type];
      if (typeof handler === "function") handler.call(this, event);
    }
  }
  function deliver(id, type) {
    const notification = live.get(id);
    if (!notification) return;
    if (type === "close") notification.finishClose();
    else if (type === "click" && !notification.closed) notification.emit("click");
  }
  api.onEvent(({ id, type }) => {
    if (!live.has(id) && pending.size > 0) {
      const events = earlyEvents.get(id) ?? [];
      events.push(type);
      earlyEvents.set(id, events);
      return;
    }
    deliver(id, type);
  });
  Object.defineProperty(globalThis, "Notification", {
    value: WorkspaceNotification, configurable: false, writable: false,
  });
  const registrationPrototype = globalThis.ServiceWorkerRegistration?.prototype;
  if (registrationPrototype) {
    Object.defineProperty(registrationPrototype, "showNotification", {
      value(title, options = {}) {
        try { return new WorkspaceNotification(title, options).accepted; }
        catch (error) { return Promise.reject(error); }
      },
      configurable: false, writable: false,
    });
  }
})();
`;
