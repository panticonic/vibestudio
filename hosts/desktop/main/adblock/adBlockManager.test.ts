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

import { AdBlockManager, requestPageUrl } from "./adBlockManager.js";
import { FiltersEngine, Request } from "@ghostery/adblocker";

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

  it("records a tab's page before the engine is ready, because later requests need it", () => {
    // Every subresource is classified against this URL. While recording it
    // happened after the engine check, the first page a tab ever loaded was
    // classified without a source for its whole lifetime.
    const manager = new AdBlockManager();
    manager.attachToSession(browserSession());
    const beforeRequest = mocks.onBeforeRequest.mock.calls[0]?.[1] as (
      details: Electron.OnBeforeRequestListenerDetails,
      callback: (response: Electron.CallbackResponse) => void
    ) => void;

    const callback = vi.fn();
    beforeRequest(
      {
        resourceType: "mainFrame",
        webContentsId: 7,
        url: "https://news.example.org/story",
      } as Electron.OnBeforeRequestListenerDetails,
      callback
    );

    expect(callback).toHaveBeenCalledWith({});
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

describe("the page a request is filtered against", () => {
  it("prefers the tab's own main-frame URL over a header the page can withhold", () => {
    expect(
      requestPageUrl(
        { referrer: "https://referrer.example/", url: "https://ads.example.com/a.js" },
        "https://news.example.org/story"
      )
    ).toBe("https://news.example.org/story");
  });

  it("falls back to the referrer, then to the request itself", () => {
    expect(
      requestPageUrl(
        { referrer: "https://news.example.org/", url: "https://ads.example.com/a.js" },
        undefined
      )
    ).toBe("https://news.example.org/");
    expect(requestPageUrl({ url: "https://ads.example.com/a.js" }, undefined)).toBe(
      "https://ads.example.com/a.js"
    );
  });

  it("is what decides whether third-party and domain rules can match at all", async () => {
    // The reason the fallback order above matters, stated as the engine states
    // it. A request with no source is first-party to nothing, so these rule
    // shapes — most of EasyPrivacy, much of EasyList — stop matching entirely.
    const engine = await FiltersEngine.parse(
      ["||ads.example.com^$third-party", "/banner-ad.js$domain=news.example.org"].join("\n"),
      { enableCompression: true }
    );
    const matches = (sourceUrl: string, url: string): boolean =>
      engine.match(Request.fromRawDetails({ url, sourceUrl, type: "script", tabId: 1 })).match;

    const page = "https://news.example.org/story";
    expect(matches(page, "https://ads.example.com/a.js")).toBe(true);
    expect(matches(page, "https://news.example.org/banner-ad.js")).toBe(true);
    expect(matches("", "https://ads.example.com/a.js")).toBe(false);
    expect(matches("", "https://news.example.org/banner-ad.js")).toBe(false);
  });
});
