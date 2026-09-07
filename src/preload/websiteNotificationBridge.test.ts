import { afterEach, describe, expect, it, vi } from "vitest";
import { WEBSITE_NOTIFICATION_COMPATIBILITY_SCRIPT } from "@vibestudio/shared/websiteNotificationCompatibility";

const mocks = vi.hoisted(() => ({
  expose: vi.fn(),
  execute: vi.fn(async () => undefined),
  invoke: vi.fn(),
  on: vi.fn(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: mocks.expose },
  webFrame: { executeJavaScript: mocks.execute },
  ipcRenderer: { invoke: mocks.invoke, on: mocks.on },
}));
import { exposeWebsiteNotificationBridge } from "./websiteNotificationBridge.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("desktop notification compatibility adapter", () => {
  it("uses Chromium permission and the canonical script without passing page identity", async () => {
    const requestPermission = vi.fn(async () => "granted");
    vi.stubGlobal("Notification", { permission: "granted", requestPermission });
    exposeWebsiteNotificationBridge();
    const [name, adapter] = mocks.expose.mock.calls[0]!;
    expect(name).toBe("__vibestudioWebsiteNotifications");
    expect(adapter.permission()).toBe("granted");
    await adapter.requestPermission();
    expect(requestPermission).toHaveBeenCalledOnce();
    await adapter.show("Title", { body: "Body" });
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(
      "vibestudio:website-notification:show",
      "Title",
      { body: "Body" }
    );
    expect(mocks.execute).toHaveBeenCalledExactlyOnceWith(
      WEBSITE_NOTIFICATION_COMPATIBILITY_SCRIPT
    );
    const listener = vi.fn();
    adapter.onEvent(listener);
    const receive = mocks.on.mock.calls[0]![1];
    receive({}, { id: "accepted", type: "click" });
    receive({}, { id: "accepted", type: "unexpected" });
    expect(listener).toHaveBeenCalledExactlyOnceWith({ id: "accepted", type: "click" });
  });
});
