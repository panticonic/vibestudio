import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  getSources: vi.fn(),
  fromFrame: vi.fn(),
  handle: vi.fn(),
  windows: [] as unknown[],
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class Window extends EventEmitter {
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), {
      id: 100 + native.windows.length,
      mainFrame: {},
      setWindowOpenHandler: vi.fn(),
    });
    static fromWebContents() {
      return null;
    }
    constructor() {
      super();
      native.windows.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      this.emit("closed");
    }
    setContentProtection = vi.fn();
    loadFile = vi.fn(async () => {});
    show = vi.fn();
    focus = vi.fn();
  }
  return {
    BrowserWindow: Window,
    desktopCapturer: { getSources: native.getSources },
    webContents: { fromFrame: native.fromFrame },
    ipcMain: { handle: native.handle },
  };
});
import { DisplayCapturePicker } from "./displayCapturePicker.js";

function harness() {
  const frame = {};
  const owner = Object.assign(new EventEmitter(), {
    mainFrame: frame,
    isDestroyed: () => false,
    getURL: () => "https://example.com/meeting",
  });
  native.fromFrame.mockReturnValue(owner);
  const source = {
    id: "window:1",
    name: "Meeting",
    thumbnail: { toDataURL: () => "data:image/png;base64,example" },
  };
  native.getSources.mockResolvedValue([source]);
  const picker = new DisplayCapturePicker({ htmlPath: "/picker.html", preloadPath: "/picker.cjs" });
  const request = {
    frame,
    securityOrigin: "https://example.com",
    userGesture: true,
    videoRequested: true,
    audioRequested: true,
  } as Electron.DisplayMediaRequestHandlerHandlerRequest;
  return { picker, request, source, owner };
}

describe("trusted display source chooser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    native.windows.length = 0;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("requires the main document, matching origin, and user activation before enumeration", async () => {
    const { picker, request } = harness();
    await expect(picker.pick({ ...request, userGesture: false })).resolves.toEqual({});
    await expect(picker.pick({ ...request, frame: {} as Electron.WebFrameMain })).resolves.toEqual(
      {}
    );
    await expect(
      picker.pick({ ...request, securityOrigin: "https://attacker.example" })
    ).resolves.toEqual({});
    expect(native.getSources).not.toHaveBeenCalled();
  });

  it("cancels pending native enumeration when the owner reloads", async () => {
    const { picker, request, source, owner } = harness();
    let complete!: (sources: unknown[]) => void;
    native.getSources.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const result = picker.pick(request);
    owner.emit("did-start-navigation", {}, owner.getURL(), false, true);
    await expect(result).resolves.toEqual({});
    complete([source]);
    await Promise.resolve();
    expect(native.windows).toHaveLength(0);
    expect(owner.listenerCount("did-start-navigation")).toBe(0);
  });

  it("uses the Linux portal's selected source without another chooser", async () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    const { picker, request, source } = harness();
    await expect(picker.pick(request)).resolves.toEqual({ video: source });
    expect(native.windows).toHaveLength(0);
  });

  it("keeps inventory in trusted chrome, binds selection to its main frame, and denies forged audio", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    const { picker, request, source, owner } = harness();
    const result = picker.pick(request);
    await vi.waitFor(() => expect(native.windows).toHaveLength(1));
    const window = native.windows[0] as {
      destroyed: boolean;
      webContents: { id: number; mainFrame: unknown };
    };
    const invoke = native.handle.mock.calls[0]![1];
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    expect(() => invoke({ ...event, sender: { id: 999 } }, "snapshot")).toThrow(/Untrusted/);
    expect(() => invoke({ ...event, senderFrame: {} }, "snapshot")).toThrow(/Untrusted/);
    const snapshot = invoke(event, "snapshot");
    expect(snapshot.sources[0]).not.toHaveProperty("id");
    expect(snapshot.audioAvailable).toBe(false);
    expect(() => invoke(event, "choose", "0", true)).toThrow(/Invalid/);
    invoke(event, "choose", 0, true);
    await expect(result).resolves.toEqual({ video: source });
    expect(window.destroyed).toBe(true);
    expect(owner.listenerCount("did-start-navigation")).toBe(0);
    expect(() => invoke(event, "snapshot")).toThrow(/Untrusted/);
  });

  it("closing the chooser cancels the request and cleans up owner listeners", async () => {
    const { picker, request, owner } = harness();
    const result = picker.pick(request);
    await vi.waitFor(() => expect(native.windows).toHaveLength(1));
    (native.windows[0] as { destroy(): void }).destroy();
    await expect(result).resolves.toEqual({});
    expect(owner.listenerCount("did-start-navigation")).toBe(0);
  });
});
