import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const sendCommand = vi.fn();
  const browserSession = {
    cookies: {
      on: vi.fn(),
      off: vi.fn(),
      flushStore: vi.fn(async () => {}),
    },
  };
  const bridge = {
    webContents: {
      debugger: {
        attach: vi.fn(),
        sendCommand,
        isAttached: vi.fn(() => true),
        detach: vi.fn(),
      },
      isDestroyed: vi.fn(() => false),
      close: vi.fn(),
    },
  };
  return {
    sendCommand,
    browserSession,
    bridge,
    fromPartition: vi.fn(() => browserSession),
    WebContentsView: vi.fn(() => bridge),
  };
});

vi.mock("electron", () => ({
  session: { fromPartition: electron.fromPartition },
  WebContentsView: electron.WebContentsView,
}));

import { ChromiumCookieJar, fromCdpCookie, toCdpCookie } from "./chromiumCookieJar.js";

describe("ChromiumCookieJar mappings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electron.sendCommand.mockImplementation(async (method: string) => {
      if (method === "Network.getAllCookies") return { cookies: [] };
      if (method === "Network.setCookie") return { success: true };
      return {};
    });
  });

  it("uses target-scoped Network cookie commands for an Electron partition", async () => {
    const jar = new ChromiumCookieJar("persist:browser-environment:test");
    await jar.start(() => {});
    await jar.snapshot();
    await jar.set({
      name: "sid",
      value: "secret",
      domain: "example.test",
      hostOnly: true,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
    });

    expect(electron.fromPartition).toHaveBeenCalledWith("persist:browser-environment:test");
    expect(electron.sendCommand).toHaveBeenCalledWith("Network.getAllCookies");
    expect(electron.sendCommand).toHaveBeenCalledWith(
      "Network.setCookie",
      expect.objectContaining({ name: "sid", url: "https://example.test/" })
    );
    expect(
      electron.sendCommand.mock.calls.some(([method]) => String(method).startsWith("Storage."))
    ).toBe(false);
  });

  it("surfaces a target-scoped cookie rejection", async () => {
    electron.sendCommand.mockImplementation(async (method: string) => {
      if (method === "Network.getAllCookies") return { cookies: [] };
      if (method === "Network.setCookie") return { success: false };
      return {};
    });
    const jar = new ChromiumCookieJar("persist:browser-environment:test");
    await jar.start(() => {});

    await expect(
      jar.set({
        name: "sid",
        value: "secret",
        domain: "example.test",
        hostOnly: true,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
      })
    ).rejects.toThrow("Chromium rejected cookie sid for example.test");
  });

  it("round-trips a complete partitioned cookie key", () => {
    const partitionKey = {
      topLevelSite: "https://top.example",
      hasCrossSiteAncestor: true,
    };
    const canonical = fromCdpCookie({
      name: "sid",
      value: "secret",
      domain: ".embedded.example",
      path: "/account",
      expires: 1_900_000_000,
      httpOnly: true,
      secure: true,
      session: false,
      sameSite: "None",
      sourceScheme: "Secure",
      sourcePort: 443,
      partitionKey,
    });

    expect(canonical).toMatchObject({
      partitionKey,
      hostOnly: false,
      sameSite: "no_restriction",
      expirationDate: 1_900_000_000,
    });
    expect(toCdpCookie(canonical)).toMatchObject({
      partitionKey,
      domain: ".embedded.example",
      sameSite: "None",
      expires: 1_900_000_000,
    });
  });

  it("keeps host-only cookies host-only by omitting the CDP domain parameter", () => {
    expect(
      toCdpCookie({
        name: "sid",
        value: "secret",
        domain: "example.test",
        hostOnly: true,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
      })
    ).not.toHaveProperty("domain");
  });
});
