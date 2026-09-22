import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ handlers: new Map<string, Function>(), views: [] as any[] }));
vi.mock("electron", () => ({
  ipcMain: {
    on: (name: string, fn: Function) => mocks.handlers.set(name, fn),
    removeListener: (name: string) => mocks.handlers.delete(name),
  },
  WebContentsView: class {
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    webContents = {
      id: 42,
      isDestroyed: () => false,
      on: vi.fn(),
      loadURL: async () => {},
      send: vi.fn(),
      focus: vi.fn(),
      close: vi.fn(),
    };
    constructor() {
      mocks.views.push(this);
    }
    setBounds(bounds: typeof this.bounds) {
      this.bounds = bounds;
    }
    getBounds() {
      return this.bounds;
    }
    setBackgroundColor() {}
    setVisible() {}
  },
}));
import { ShellContentOverlayView } from "./shellContentOverlayView";

function send(channel: string, payload: unknown, sender = 42) {
  mocks.handlers.get(`vibestudio:content-overlay:${channel}`)!({ sender: { id: sender } }, payload);
}

describe("Quickfire overlay geometry", () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.views.length = 0;
  });
  function setup() {
    const overlay = new ShellContentOverlayView("preload", () => "https://shell.local", vi.fn());
    const size = [1200, 900];
    overlay.setWindow({
      getContentSize: () => size,
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    } as any);
    const options = {
      surface: "quickfire",
      bounds: { x: 0, y: 0, width: 1000, height: 800 },
      theme: { appearance: "dark" as const },
    };
    overlay.show(options);
    send("size", { width: 720, height: 500 });
    return { overlay, view: mocks.views[0]!, size, options };
  }
  it("keeps a dragged position across content updates and reopening", () => {
    const { overlay, view, options } = setup();
    send("drag", { phase: "start", screenX: 100, screenY: 100 });
    send("drag", { phase: "move", screenX: 230, screenY: 180 });
    send("drag", { phase: "end", screenX: 230, screenY: 180 });
    const placed = { ...view.bounds };
    expect(placed).toMatchObject({ x: 142, y: 92 });
    send("size", { width: 600, height: 700 });
    overlay.update({ props: { streaming: true } });
    expect(view.bounds).toEqual(placed);
    overlay.hide();
    overlay.show(options);
    expect(view.bounds).toEqual(placed);
    overlay.destroy();
  });
  it("resizes beyond the original cap, expands, and restores the chosen bounds", () => {
    const { overlay, view, size } = setup();
    send("geometry", { action: "resize-start", screenX: 700, screenY: 500 });
    send("geometry", { action: "resize-end", screenX: 900, screenY: 600 });
    const resized = { ...view.bounds };
    expect(resized).toMatchObject({ width: 920, height: 600 });
    send("geometry", { action: "toggle-expand" });
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 1200, height: 900 });
    send("size", { width: 1200, height: 900 });
    send("geometry", { action: "toggle-expand" });
    expect(view.bounds).toEqual(resized);
    size[0] = 600;
    size[1] = 400;
    overlay.update({});
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 600, height: 400 });
    overlay.destroy();
  });
  it("restores auto-fit size after expansion and ignores foreign senders", () => {
    const { overlay, view } = setup();
    const initial = { ...view.bounds };
    send("geometry", { action: "toggle-expand" }, 99);
    expect(view.bounds).toEqual(initial);
    send("geometry", { action: "toggle-expand" });
    send("size", { width: 1200, height: 900 });
    send("geometry", { action: "toggle-expand" });
    expect(view.bounds).toEqual(initial);
    overlay.destroy();
  });
});
