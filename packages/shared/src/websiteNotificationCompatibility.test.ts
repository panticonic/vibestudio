import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  WEBSITE_NOTIFICATION_COMPATIBILITY_SCRIPT,
  type WebsiteNotificationAdapter,
} from "./websiteNotificationCompatibility.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture(permission: NotificationPermission = "granted") {
  let receive!: Parameters<WebsiteNotificationAdapter["onEvent"]>[0];
  const adapter = {
    permission: vi.fn(() => permission),
    requestPermission: vi.fn(async () => "granted" as const),
    show: vi.fn(async () => "notification-1"),
    close: vi.fn(async () => undefined),
    onEvent: (listener: typeof receive) => {
      receive = listener;
      return () => undefined;
    },
  } satisfies WebsiteNotificationAdapter;
  class Registration {}
  const world = {
    EventTarget,
    Event,
    DOMException,
    ServiceWorkerRegistration: Registration,
    __vibestudioWebsiteNotifications: adapter,
  };
  runInNewContext(WEBSITE_NOTIFICATION_COMPATIBILITY_SCRIPT, world);
  const Notification = (world as unknown as { Notification: typeof globalThis.Notification })
    .Notification;
  const registration = new Registration() as unknown as ServiceWorkerRegistration;
  return {
    Notification,
    registration,
    adapter,
    receive: (type: "click" | "close", id = "notification-1") => receive({ id, type }),
  };
}

describe("shared website notification compatibility", () => {
  it.each(["default", "denied"] as const)(
    "does not prompt when construction is %s",
    (permission) => {
      const { Notification, adapter } = fixture(permission);
      expect(Notification.permission).toBe(permission);
      expect(() => new Notification("Hello")).toThrow("permission has not been granted");
      expect(adapter.requestPermission).not.toHaveBeenCalled();
      expect(adapter.show).not.toHaveBeenCalled();
    }
  );

  it("reads remembered permission from the adapter and explicitly requests permission", async () => {
    const { Notification, adapter } = fixture("default");
    adapter.permission.mockReturnValue("granted");
    expect(Notification.permission).toBe("granted");
    const callback = vi.fn();
    await expect(Notification.requestPermission(callback)).resolves.toBe("granted");
    expect(callback).toHaveBeenCalledWith("granted");
    expect(adapter.requestPermission).toHaveBeenCalledOnce();
  });

  it("delivers accepted show, exact click and one close, retaining page-only data", async () => {
    const { Notification, adapter, receive } = fixture();
    const pending = deferred<string>();
    adapter.show.mockReturnValueOnce(pending.promise);
    const notification = new Notification("Hello", {
      body: "Body",
      tag: "tag",
      data: { private: true },
    });
    const events: string[] = [];
    for (const type of ["show", "click", "close"])
      notification.addEventListener(type, () => events.push(type));
    await Promise.resolve();
    expect(events).toEqual([]);
    expect(adapter.show).toHaveBeenCalledWith("Hello", {
      body: "Body",
      tag: "tag",
      silent: false,
      icon: undefined,
    });
    expect(notification.data).toEqual({ private: true });
    pending.resolve("notification-1");
    await vi.waitFor(() => expect(events).toEqual(["show"]));
    receive("click", "foreign");
    receive("click");
    receive("close");
    receive("close");
    receive("click");
    expect(events).toEqual(["show", "click", "close"]);
  });

  it("closing before acceptance closes the eventual host notification without showing it", async () => {
    const { Notification, adapter } = fixture();
    const pending = deferred<string>();
    adapter.show.mockReturnValueOnce(pending.promise);
    const notification = new Notification("Hello");
    notification.onshow = vi.fn();
    notification.onclose = vi.fn();
    notification.close();
    notification.close();
    pending.resolve("notification-1");
    await vi.waitFor(() => expect(notification.onclose).toHaveBeenCalledOnce());
    expect(notification.onshow).not.toHaveBeenCalled();
    expect(adapter.close).toHaveBeenCalledExactlyOnceWith("notification-1");
  });

  it("keeps close observable when native delivery precedes its acknowledgement", async () => {
    const { Notification, adapter, receive } = fixture();
    const notification = new Notification("Hello");
    notification.onshow = vi.fn();
    notification.onclose = vi.fn();
    await vi.waitFor(() => expect(notification.onshow).toHaveBeenCalledOnce());
    adapter.close.mockImplementationOnce(async () => {
      receive("close");
    });
    notification.close();
    await vi.waitFor(() => expect(notification.onclose).toHaveBeenCalledOnce());
    receive("close");
    expect(notification.onclose).toHaveBeenCalledOnce();
  });

  it("reports rejected host acceptance as an error event", async () => {
    const { Notification, adapter } = fixture();
    adapter.show.mockRejectedValueOnce(new Error("Revoked"));
    const notification = new Notification("Hello");
    notification.onerror = vi.fn();
    notification.onshow = vi.fn();
    await vi.waitFor(() => expect(notification.onerror).toHaveBeenCalledOnce());
    expect(notification.onshow).not.toHaveBeenCalled();
  });

  it("retains a native close arriving before its show acknowledgement", async () => {
    const { Notification, adapter, receive } = fixture();
    const pending = deferred<string>();
    adapter.show.mockReturnValueOnce(pending.promise);
    const notification = new Notification("Hello");
    const closed = vi.fn();
    notification.onclose = closed;
    receive("close");
    pending.resolve("notification-1");
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
    receive("click");
    receive("close");
    expect(closed).toHaveBeenCalledOnce();
    expect(adapter.close).not.toHaveBeenCalled();
  });

  it("settles showNotification only after actual host acceptance and propagates rejection", async () => {
    const { registration, adapter } = fixture();
    const pending = deferred<string>();
    adapter.show.mockReturnValueOnce(pending.promise);
    const settled = vi.fn();
    const result = registration.showNotification("Hello").then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    pending.resolve("notification-1");
    await result;
    expect(settled).toHaveBeenCalledOnce();
    adapter.show.mockRejectedValueOnce(new Error("Revoked"));
    await expect(registration.showNotification("Later")).rejects.toThrow("Revoked");
  });
});
