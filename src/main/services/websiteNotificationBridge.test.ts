import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { WebsiteNotificationBridge } from "./websiteNotificationBridge";

const { handlers, decodeImage } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  decodeImage: vi.fn(() => ({
    isEmpty: () => false,
    getSize: () => ({ width: 16, height: 16 }),
    resize: () => ({ toDataURL: () => "data:image/png;base64,icon" }),
  })),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
    removeHandler: (name: string) => handlers.delete(name),
  },
  nativeImage: { createFromBuffer: decodeImage },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function page(id: number, url = "https://site.test/page") {
  const frame = {
    url,
    origin: new URL(url).origin,
    detached: false,
    isDestroyed: () => false,
    send: vi.fn(),
  };
  const contents = Object.assign(new EventEmitter(), {
    id,
    mainFrame: frame,
    getURL: () => contents.mainFrame.url,
    isDestroyed: () => false,
    send: vi.fn(),
    session: {
      fetch: vi.fn(
        async (_url: string, _options: RequestInit) =>
          new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } })
      ),
    },
  });
  const event = (senderFrame: typeof frame | null = contents.mainFrame) =>
    ({ sender: contents, senderFrame }) as unknown as IpcMainInvokeEvent;
  const navigate = () => {
    // A same-origin, same-URL reload may retain the same frame object.
    contents.emit("did-start-navigation", {}, url, false, true);
  };
  return { contents, frame, event, navigate };
}
function fixture() {
  const first = page(10);
  const second = page(20);
  const contents = [first.contents, second.contents];
  const permissions = {
    refresh: vi.fn(async (): Promise<void> => undefined),
    isGranted: vi.fn(() => true),
    ownsContents: vi.fn((value: WebContents) => contents.includes(value as never)),
  };
  const eventService = { emit: vi.fn() };
  const manager = {
    findViewIdByWebContentsId: vi.fn((id: number) =>
      contents.some((entry) => entry.id === id) ? `panel-${id}` : null
    ),
  };
  const bridge = new WebsiteNotificationBridge({
    permissions: permissions as never,
    eventService: eventService as never,
    getViewManager: () => manager,
  });
  bridge.start();
  const show = (event = first.event(), options: unknown = {}) =>
    handlers.get("vibestudio:website-notification:show")!(
      event,
      "Hello",
      options
    ) as Promise<string>;
  const close = (event: IpcMainInvokeEvent, id: string) =>
    handlers.get("vibestudio:website-notification:close")!(event, id);
  return { first, second, permissions, eventService, manager, bridge, show, close };
}
const bridges: WebsiteNotificationBridge[] = [];
beforeEach(() => {
  handlers.clear();
  decodeImage.mockClear();
});
afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.stop();
});
function setup() {
  const result = fixture();
  bridges.push(result.bridge);
  return result;
}

describe("website notification document ownership", () => {
  it("accepts only the actual owned main frame with a matching nonopaque native origin", async () => {
    const { first, show, permissions } = setup();
    await expect(show(first.event({ ...first.frame }))).rejects.toThrow("main-frame document");
    await expect(show(first.event(null))).rejects.toThrow("main-frame document");
    first.frame.origin = "null";
    await expect(show()).rejects.toThrow("main-frame document");
    first.frame.origin = "https://site.test";
    first.frame.detached = true;
    await expect(show()).rejects.toThrow("main-frame document");
    first.frame.detached = false;
    permissions.ownsContents.mockReturnValue(false);
    await expect(show()).rejects.toThrow("main-frame document");
    expect(permissions.refresh).not.toHaveBeenCalled();
  });

  it("captures document metadata and sends lifecycle messages to the captured frame", async () => {
    const { first, bridge, show, eventService } = setup();
    const id = await show();
    expect(eventService.emit).toHaveBeenCalledWith(
      "notification:show",
      expect.objectContaining({
        id,
        sourcePanelId: "panel-10",
        details: [
          { label: "Origin", value: "https://site.test", mono: true },
          { label: "Page", value: "https://site.test/page", mono: true },
        ],
      })
    );
    bridge.handleAction(id, "website-open");
    expect(first.frame.send.mock.calls.map(([, payload]) => payload.type)).toEqual([
      "click",
      "close",
    ]);
    expect(first.contents.send).not.toHaveBeenCalled();
    expect(first.contents.listenerCount("did-start-navigation")).toBe(0);
  });

  it("retires a pending permission read on same-URL reload before it can publish", async () => {
    const { first, show, permissions, eventService } = setup();
    const pending = deferred<void>();
    permissions.refresh.mockReturnValueOnce(pending.promise);
    const result = show();
    first.navigate();
    expect(first.contents.listenerCount("did-start-navigation")).toBe(0);
    pending.resolve();
    await expect(result).rejects.toThrow("document is no longer active");
    expect(eventService.emit).not.toHaveBeenCalled();
    expect(first.frame.send).not.toHaveBeenCalled();
  });

  it("aborts pending icon fetch on navigation and never publishes its late response", async () => {
    const { first, show, eventService } = setup();
    const pending = deferred<Response>();
    first.contents.session.fetch.mockReturnValueOnce(pending.promise);
    const result = show(first.event(), { icon: "images/icon.png" });
    await vi.waitFor(() => expect(first.contents.session.fetch).toHaveBeenCalledTimes(1));
    const [url, options] = first.contents.session.fetch.mock.calls[0]!;
    expect(url).toBe("https://site.test/images/icon.png");
    expect(options.signal?.aborted).toBe(false);
    first.navigate();
    expect(options.signal?.aborted).toBe(true);
    pending.resolve(
      new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } })
    );
    await expect(result).rejects.toThrow("document is no longer active");
    expect(eventService.emit).not.toHaveBeenCalled();
    expect(first.frame.send).not.toHaveBeenCalled();
  });

  it("cancels a pending icon body read and releases its reader when its document retires", async () => {
    const { first, show, eventService } = setup();
    const reading = deferred<void>();
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull: () => {
          reading.resolve();
        },
        cancel,
      }),
      { headers: { "content-type": "image/png" } }
    );
    first.contents.session.fetch.mockResolvedValueOnce(response);
    const result = show(first.event(), { icon: "/streaming-icon.png" });
    await reading.promise;
    await vi.waitFor(() => expect(response.body?.locked).toBe(true));
    first.navigate();
    await expect(result).rejects.toThrow("document is no longer active");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body?.locked).toBe(false);
    expect(decodeImage).not.toHaveBeenCalled();
    expect(eventService.emit).not.toHaveBeenCalled();
  });

  it.each<ResponseInit>([
    { status: 404, headers: { "content-type": "image/png" } },
    { status: 200, headers: { "content-type": "text/html" } },
    { status: 200, headers: { "content-type": "image/png", "content-length": "131073" } },
  ])("cancels the acquired icon body when headers reject it: %j", async (init) => {
    const { first, show, eventService } = setup();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), init);
    first.contents.session.fetch.mockResolvedValueOnce(response);
    const id = await show(first.event(), { icon: "/invalid-icon" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body?.locked).toBe(false);
    expect(decodeImage).not.toHaveBeenCalled();
    expect(eventService.emit).toHaveBeenCalledWith(
      "notification:show",
      expect.objectContaining({ id })
    );
  });

  it("finishes owned cleanup if the native frame disappears during lifecycle delivery", async () => {
    const { first, show, bridge, eventService } = setup();
    const id = await show();
    first.frame.send.mockImplementationOnce(() => {
      first.frame.detached = true;
      throw new Error("Frame disposed");
    });
    expect(() => bridge.handleAction(id, "website-open")).not.toThrow();
    expect(first.contents.listenerCount("did-start-navigation")).toBe(0);
    expect(eventService.emit).toHaveBeenCalledWith("notification:dismiss", { id });
    const calls = first.frame.send.mock.calls.length;
    bridge.handleAction(id, "website-open");
    expect(first.frame.send).toHaveBeenCalledTimes(calls);
  });

  it.each(["destroyed", "render-process-gone", "stop"])(
    "retires pending work on %s",
    async (reason) => {
      const { first, bridge, show, permissions, eventService } = setup();
      const pending = deferred<void>();
      permissions.refresh.mockReturnValueOnce(pending.promise);
      const result = show();
      if (reason === "stop") bridge.stop();
      else first.contents.emit(reason);
      pending.resolve();
      await expect(result).rejects.toThrow("document is no longer active");
      expect(eventService.emit).not.toHaveBeenCalled();
      expect(first.contents.listenerCount("did-start-navigation")).toBe(0);
    }
  );

  it("does not deliver close/click to a same-origin replacement document", async () => {
    const { first, bridge, show, eventService } = setup();
    const id = await show();
    first.navigate();
    bridge.handleAction(id, "website-open");
    expect(eventService.emit).toHaveBeenCalledWith("notification:dismiss", { id });
    expect(first.frame.send).not.toHaveBeenCalled();
  });

  it("replaces an authorized origin/tag using a new ID and ignores old or foreign-frame close actions", async () => {
    const { first, second, bridge, show, close, eventService } = setup();
    const old = await show(first.event(), { tag: "progress" });
    const replacement = await show(second.event(), { tag: "progress" });
    expect(replacement).not.toBe(old);
    expect(first.frame.send).toHaveBeenCalledWith("vibestudio:website-notification:event", {
      id: old,
      type: "close",
    });
    eventService.emit.mockClear();
    bridge.handleAction(old, "website-open");
    close(first.event(), old);
    close(first.event(), replacement);
    close(second.event({ ...second.frame }), replacement);
    expect(eventService.emit).not.toHaveBeenCalled();
    close(second.event(), replacement);
    expect(eventService.emit).toHaveBeenCalledWith("notification:dismiss", { id: replacement });
  });

  it("does not replace an existing tag if permission is revoked during icon fetch", async () => {
    const { first, second, show, permissions, eventService } = setup();
    const old = await show(first.event(), { tag: "progress" });
    const pending = deferred<Response>();
    second.contents.session.fetch.mockReturnValueOnce(pending.promise);
    const replacement = show(second.event(), { tag: "progress", icon: "/icon.png" });
    await vi.waitFor(() => expect(second.contents.session.fetch).toHaveBeenCalledTimes(1));
    permissions.isGranted.mockReturnValue(false);
    pending.resolve(
      new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } })
    );
    await expect(replacement).rejects.toThrow("not allowed");
    expect(eventService.emit).not.toHaveBeenCalledWith("notification:dismiss", { id: old });
  });
});
