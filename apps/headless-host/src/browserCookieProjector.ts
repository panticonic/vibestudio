import { browserCookieToChromium, type StoredCookie } from "@vibestudio/browser-data";
import type { RpcClient } from "@vibestudio/rpc";
import { CdpConnection } from "./browser/cdpConnection.js";

/**
 * Projects canonical imported cookies directly into a Chromium browser
 * context. Cookie values stay inside the authenticated native host: neither
 * panel code nor the agent runtime receives them.
 */
export class BrowserCookieProjector {
  constructor(
    private readonly cdp: CdpConnection,
    private readonly rpc: Pick<RpcClient, "call">
  ) {}

  async prepare(browserContextId: string, rawUrl: string): Promise<void> {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    const cookies = await this.rpc.call<StoredCookie[]>(
      "main",
      "browserVaultNative.getCookiesForOrigin",
      [url.origin]
    );
    if (cookies.length === 0) return;
    await this.cdp.send("Storage.setCookies", {
      browserContextId,
      cookies: cookies.map(browserCookieToChromium),
    });
  }
}
