import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  onBeforeRequest: vi.fn(),
  onHeadersReceived: vi.fn(),
  ipcHandle: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: mocks.ipcHandle,
  },
}));

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("../paths.js", () => ({
  getCentralConfigDirectory: () => "/tmp/vibestudio-adblock-test",
}));

import { AdBlockManager } from "./adBlockManager.js";

function browserSession() {
  return {
    webRequest: {
      onBeforeRequest: mocks.onBeforeRequest,
      onHeadersReceived: mocks.onHeadersReceived,
    },
  } as unknown as Electron.Session;
}

describe("AdBlockManager browser-session lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("attaches before the filter engine is ready and releases its handlers", () => {
    const manager = new AdBlockManager();
    const session = browserSession();

    const release = manager.attachToSession(session);

    expect(mocks.onBeforeRequest).toHaveBeenCalledTimes(1);
    expect(mocks.onBeforeRequest).toHaveBeenCalledWith(
      { urls: ["<all_urls>"] },
      expect.any(Function)
    );
    expect(mocks.onHeadersReceived).toHaveBeenCalledTimes(1);
    expect(mocks.onHeadersReceived).toHaveBeenCalledWith(
      { urls: ["<all_urls>"] },
      expect.any(Function)
    );
    const beforeRequest = mocks.onBeforeRequest.mock.calls[0]?.[1] as
      | ((
          details: Electron.OnBeforeRequestListenerDetails,
          callback: (response: Electron.CallbackResponse) => void
        ) => void)
      | undefined;
    const callback = vi.fn();
    beforeRequest?.({} as Electron.OnBeforeRequestListenerDetails, callback);
    expect(callback).toHaveBeenCalledWith({ cancel: false });

    release();
    expect(mocks.onBeforeRequest).toHaveBeenLastCalledWith(null);
    expect(mocks.onHeadersReceived).toHaveBeenLastCalledWith(null);
  });

  it("reference-counts repeated bindings to the same Electron session", () => {
    const manager = new AdBlockManager();
    const session = browserSession();

    const releaseFirst = manager.attachToSession(session);
    const releaseSecond = manager.attachToSession(session);

    expect(mocks.onBeforeRequest).toHaveBeenCalledTimes(1);
    expect(mocks.onHeadersReceived).toHaveBeenCalledTimes(1);

    releaseFirst();
    expect(mocks.onBeforeRequest).toHaveBeenCalledTimes(1);
    expect(mocks.onHeadersReceived).toHaveBeenCalledTimes(1);

    releaseSecond();
    expect(mocks.onBeforeRequest).toHaveBeenCalledTimes(2);
    expect(mocks.onBeforeRequest).toHaveBeenLastCalledWith(null);
    expect(mocks.onHeadersReceived).toHaveBeenCalledTimes(2);
    expect(mocks.onHeadersReceived).toHaveBeenLastCalledWith(null);
  });
});
