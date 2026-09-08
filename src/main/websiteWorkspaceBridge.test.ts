import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { WebsiteWorkspaceBridge } from "./websiteWorkspaceBridge.js";

function fixture() {
  const events = new EventEmitter();
  const contents = Object.assign(events, {
    id: 7,
    mainFrame: { url: "https://example.com/app" },
    getURL: () => contents.mainFrame.url,
    isDestroyed: () => false,
    send: vi.fn(),
  });
  const call = vi.fn(
    async (_service: string, method: string, _args: unknown[]): Promise<unknown> =>
      method === "connect" ? true : undefined
  );
  const retireTransport = vi.fn();
  let changed:
    | ((payload: { runtimeId: string; documentId: string; connected: boolean }) => void)
    | undefined;
  const onDirectEvent = vi.fn((_event: string, listener: typeof changed) => {
    changed = listener;
    return () => {
      changed = undefined;
    };
  });
  const bootstrap = vi.fn(async () => ({
    entityId: "panel:browser",
    slotId: "slot-1",
    contextId: "context-1",
    theme: "dark",
    parentId: null,
    gatewayConfig: { token: "must-not-leak" },
    env: { SECRET: "must-not-leak" },
  }));
  const bridge = new WebsiteWorkspaceBridge({
    resolve: () => ({
      runtimeId: "panel:browser",
      client: { call, onDirectEvent } as unknown as import("./serverClient.js").ServerClient,
      bootstrap,
    }),
    retireTransport,
  });
  const event = () =>
    ({ sender: contents, senderFrame: contents.mainFrame }) as unknown as IpcMainInvokeEvent;
  let documentId: string | undefined;
  const connect = async (input = event()) => {
    documentId ??= await bridge.begin(input);
    return bridge.connect(input, documentId);
  };
  return {
    bridge,
    contents,
    call,
    retireTransport,
    bootstrap,
    event,
    connect,
    changed: (payload: Parameters<NonNullable<typeof changed>>[0]) => changed?.(payload),
  };
}

describe("native website workspace provider", () => {
  it("attests the actual origin and only returns public runtime coordinates after approval", async () => {
    const f = fixture();
    expect(f.bridge.connected(f.contents as unknown as WebContents)).toBe(false);
    const result = await f.connect(f.event());
    expect(f.call).toHaveBeenNthCalledWith(1, "websiteHosting", "begin", [
      expect.objectContaining({ origin: "https://example.com", runtimeId: "panel:browser" }),
    ]);
    expect(result).toEqual({
      origin: "https://example.com",
      documentId: expect.any(String),
      bootstrap: {
        runtimeId: "panel:browser",
        slotId: "slot-1",
        contextId: "context-1",
        theme: "dark",
        parentId: null,
        parentEntityId: null,
      },
    });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(f.bridge.connected(f.contents as unknown as WebContents)).toBe(true);
    await f.bridge.close();
  });

  it("rejects subframes and opaque documents without consulting workspace services", async () => {
    const f = fixture();
    await expect(
      f.connect({ ...f.event(), senderFrame: {} } as IpcMainInvokeEvent)
    ).rejects.toThrow(/top-level/);
    f.contents.mainFrame.url = "data:text/html,hello";
    await expect(f.connect(f.event())).rejects.toThrow(/HTTP/);
    expect(f.call).not.toHaveBeenCalled();
    await f.bridge.close();
  });

  it("keeps declined pages disconnected and does not fetch bootstrap metadata", async () => {
    const f = fixture();
    f.call.mockImplementation(async (_s, method) => (method === "connect" ? false : undefined));
    await expect(f.connect(f.event())).rejects.toThrow(/declined/);
    expect(f.bootstrap).not.toHaveBeenCalled();
    expect(f.bridge.connected(f.contents as unknown as WebContents)).toBe(false);
    await f.bridge.close();
  });

  it("retires access at navigation start and never delivers a late approval", async () => {
    const f = fixture();
    let resolve!: (value: unknown) => void;
    f.call.mockImplementation(async (_s, method) =>
      method === "connect"
        ? new Promise((done) => {
            resolve = done;
          })
        : undefined
    );
    const pending = f.connect(f.event());
    const rejected = expect(pending).rejects.toThrow(/replaced/);
    await vi.waitFor(() => expect(f.call).toHaveBeenCalledTimes(2));
    f.contents.emit("did-start-navigation", {}, "https://example.com/next", false, true);
    expect(f.retireTransport).toHaveBeenCalledOnce();
    expect(f.bridge.connected(f.contents as unknown as WebContents)).toBe(false);
    resolve(true);
    await rejected;
    expect(f.bootstrap).not.toHaveBeenCalled();
    await f.bridge.close();
  });

  it("preserves same-document navigation and removes listeners on shutdown", async () => {
    const f = fixture();
    await f.connect(f.event());
    f.contents.emit("did-start-navigation", {}, "https://example.com/#next", true, true);
    expect(f.bridge.connected(f.contents as unknown as WebContents)).toBe(true);
    await f.bridge.close();
    expect(f.contents.listenerCount("did-start-navigation")).toBe(0);
    expect(f.contents.listenerCount("render-process-gone")).toBe(0);
    await expect(f.connect(f.event())).rejects.toThrow(/closed/);
  });
});

it("rejects an old preload challenge even when Chromium reuses the same main frame", async () => {
  const f = fixture();
  const old = await f.bridge.begin(f.event());
  await f.bridge.connect(f.event(), old);
  f.contents.emit("did-start-navigation", {}, "https://example.com/app", false, true);
  const fresh = await f.bridge.begin(f.event());
  expect(fresh).not.toBe(old);
  await expect(f.bridge.connect(f.event(), old)).rejects.toThrow(/replaced/);
  await expect(f.bridge.connect(f.event(), fresh)).resolves.toBeDefined();
  await f.bridge.close();
});

it("reconnects the same document with a fresh execution and ignores an old execution's withdrawal", async () => {
  const f = fixture();
  const challenge = await f.bridge.begin(f.event());
  const first = (await f.bridge.connect(f.event(), challenge)) as { documentId: string };
  await f.bridge.disconnect(f.event(), challenge);
  const second = (await f.bridge.connect(f.event(), challenge)) as { documentId: string };
  expect(second.documentId).not.toBe(first.documentId);
  f.changed({ runtimeId: "panel:browser", documentId: first.documentId, connected: false });
  expect(f.bridge.connected(f.contents as unknown as WebContents)).toBe(true);
  f.changed({ runtimeId: "panel:browser", documentId: second.documentId, connected: false });
  expect(f.bridge.connected(f.contents as unknown as WebContents)).toBe(false);
  expect(f.contents.send).toHaveBeenCalledWith("vibestudio:website:disconnected");
  await f.bridge.close();
});
