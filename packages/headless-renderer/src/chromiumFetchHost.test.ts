import { describe, expect, it, vi } from "vitest";
import { BrowserCookieProjector } from "./browserCookieProjector.js";
import { ChromiumFetchHost } from "./chromiumFetchHost.js";

describe("ChromiumFetchHost", () => {
  it("projects browser cookies inside the host and returns response bytes in chunks", async () => {
    const listeners = new Set<
      (event: { method: string; params: unknown; sessionId?: string }) => void
    >();
    const send = vi.fn(async (method: string, _params?: Record<string, unknown>) => {
      if (method === "Target.createBrowserContext") return { browserContextId: "context-1" };
      if (method === "Target.createTarget") return { targetId: "target-1" };
      if (method === "Target.attachToTarget") return { sessionId: "session-1" };
      if (method === "Page.navigate") {
        queueMicrotask(() => {
          for (const listener of listeners) {
            listener({
              method: "Network.responseReceived",
              sessionId: "session-1",
              params: {
                requestId: "request-1",
                type: "Document",
                response: {
                  url: "https://example.com/final",
                  status: 200,
                  statusText: "OK",
                  headers: { "Content-Type": "text/plain" },
                },
              },
            });
            listener({
              method: "Network.loadingFinished",
              sessionId: "session-1",
              params: { requestId: "request-1" },
            });
          }
        });
        return {};
      }
      if (method === "Network.getResponseBody") return { body: "hello", base64Encoded: false };
      return {};
    });
    const cdp = {
      send,
      onEvent(listener: (event: { method: string; params: unknown; sessionId?: string }) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as never;
    const rpc = {
      call: vi.fn(async () => [
        {
          name: "sid",
          value: "secret",
          domain: "example.com",
          hostOnly: true,
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "lax",
          encryptedValue: "opaque",
          contentHash: "hash",
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    } as never;
    const fetchHost = new ChromiumFetchHost(cdp, new BrowserCookieProjector(cdp, rpc));

    const opened = await fetchHost.open("https://example.com/start", "browser");
    const chunk = fetchHost.read(opened.responseId, 0, 100);

    expect(Buffer.from(chunk.bytesBase64, "base64").toString()).toBe("hello");
    expect(chunk.done).toBe(true);
    expect(send).toHaveBeenCalledWith(
      "Storage.setCookies",
      expect.objectContaining({ browserContextId: "context-1" })
    );
    expect(send).toHaveBeenCalledWith("Target.disposeBrowserContext", expect.anything());
    expect(send).toHaveBeenCalledWith("Target.createBrowserContext", {
      disposeOnDetach: false,
      proxyServer: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/),
      proxyBypassList: "<-loopback>",
    });
  });

  it("revokes the network grant before blocked CDP cleanup and retains every failure", async () => {
    const primary = new Error("attach failed");
    const targetFailure = new Error("target cleanup failed");
    const contextFailure = new Error("context cleanup failed");
    let proxyUrl = "";
    let releaseTarget!: (error: Error) => void;
    const targetClose = new Promise((_resolve, reject) => {
      releaseTarget = reject;
    });
    const send = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "Target.createBrowserContext") {
        proxyUrl = String(params!.proxyServer);
        return { browserContextId: "ctx" };
      }
      if (method === "Target.createTarget") return { targetId: "target" };
      if (method === "Target.attachToTarget") throw primary;
      if (method === "Target.closeTarget") return targetClose;
      if (method === "Target.disposeBrowserContext") throw contextFailure;
      return {};
    });
    const pending = new ChromiumFetchHost({ send } as never, { prepare: vi.fn() } as never)
      .open("https://example.com", "public")
      .catch((error: unknown) => error);
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith("Target.closeTarget", { targetId: "target" })
    );
    await expect(fetch(proxyUrl)).rejects.toThrow();
    expect(send).toHaveBeenCalledWith("Target.disposeBrowserContext", { browserContextId: "ctx" });
    releaseTarget(targetFailure);
    const failure = await pending;
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([primary, targetFailure, contextFailure]);
  });

  it("uses and disposes an isolated cookie-free context for public fetches", async () => {
    const listeners = new Set<
      (event: { method: string; params: unknown; sessionId?: string }) => void
    >();
    const send = vi.fn(async (method: string) => {
      if (method === "Target.createBrowserContext") return { browserContextId: "public-context" };
      if (method === "Target.createTarget") return { targetId: "target" };
      if (method === "Target.attachToTarget") return { sessionId: "session" };
      if (method === "Page.navigate") {
        queueMicrotask(() => {
          for (const listener of listeners) {
            listener({
              method: "Network.responseReceived",
              sessionId: "session",
              params: {
                requestId: "request",
                type: "Document",
                response: {
                  url: "https://example.com",
                  status: 204,
                  statusText: "No Content",
                  headers: {},
                },
              },
            });
            listener({
              method: "Network.loadingFinished",
              sessionId: "session",
              params: { requestId: "request" },
            });
          }
        });
        return {};
      }
      if (method === "Network.getResponseBody") return { body: "", base64Encoded: false };
      return {};
    });
    const cdp = {
      send,
      onEvent(listener: (event: { method: string; params: unknown; sessionId?: string }) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as never;
    const cookies = { prepare: vi.fn() } as never;

    await new ChromiumFetchHost(cdp, cookies).open("https://example.com", "public");

    expect((cookies as { prepare: ReturnType<typeof vi.fn> }).prepare).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith("Target.disposeBrowserContext", {
      browserContextId: "public-context",
    });
  });
});
