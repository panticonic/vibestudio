import { ChromiumNetworkProxy } from "@vibestudio/shared/chromiumNetworkProxy";
import type { NetworkEndpointAuthority } from "@vibestudio/shared/networkDestination";
import { randomUUID } from "node:crypto";
import { CdpConnection, type CdpEventEnvelope } from "./browser/cdpConnection.js";
import { BrowserCookieProjector } from "./browserCookieProjector.js";

const RESPONSE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;

export interface ChromiumFetchOpenResult {
  responseId: string;
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  size: number;
}

interface StoredResponse extends ChromiumFetchOpenResult {
  bytes: Uint8Array;
  expiresAt: number;
}

/** Lightweight, panel-free fetches through the host's real Chromium stack. */
export class ChromiumFetchHost {
  private readonly responses = new Map<string, StoredResponse>();

  constructor(
    private readonly cdp: CdpConnection,
    private readonly cookies: BrowserCookieProjector
  ) {}

  async open(
    url: string,
    session: "public" | "browser",
    authority: NetworkEndpointAuthority = { kind: "public" }
  ): Promise<ChromiumFetchOpenResult> {
    this.prune();
    const targetUrl = new URL(url);
    if (
      !["http:", "https:"].includes(targetUrl.protocol) ||
      targetUrl.username ||
      targetUrl.password
    )
      throw new Error("Chromium fetch requires an HTTP(S) URL without userinfo");
    const proxy = new ChromiumNetworkProxy(authority);
    let contextId: string | undefined;
    let targetId: string | undefined;
    let storedResponseId: string | undefined;
    let executionFailure: unknown;
    let executionFailed = false;
    try {
      contextId = await this.createBrowserContext(await proxy.ready);
      if (session === "browser") await this.cookies.prepare(contextId, url);
      const target = (await this.cdp.send("Target.createTarget", {
        url: "about:blank",
        browserContextId: contextId,
        background: true,
      })) as { targetId: string };
      targetId = target.targetId;
      const attached = (await this.cdp.send("Target.attachToTarget", {
        targetId,
        flatten: true,
      })) as { sessionId: string };
      const sessionId = attached.sessionId;
      await Promise.all([
        this.cdp.send("Network.enable", undefined, sessionId),
        this.cdp.send("Page.enable", undefined, sessionId),
      ]);
      const response = await this.navigate(url, sessionId);
      const body = (await this.cdp.send(
        "Network.getResponseBody",
        { requestId: response.requestId },
        sessionId
      )) as { body: string; base64Encoded?: boolean };
      const bytes = body.base64Encoded
        ? Uint8Array.from(Buffer.from(body.body, "base64"))
        : new TextEncoder().encode(body.body);
      if (bytes.byteLength > MAX_RESPONSE_BYTES) {
        throw new Error(`Chromium response exceeds ${MAX_RESPONSE_BYTES} byte limit`);
      }
      const responseId = randomUUID();
      const result: ChromiumFetchOpenResult = {
        responseId,
        url: response.url,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        size: bytes.byteLength,
      };
      storedResponseId = responseId;
      this.responses.set(responseId, { ...result, bytes, expiresAt: Date.now() + RESPONSE_TTL_MS });
      return result;
    } catch (error) {
      executionFailed = true;
      executionFailure = error;
      throw error;
    } finally {
      // Revoke endpoint authority before a CDP close can block. Join every owned
      // disposal independently and retain cleanup failures with the original error.
      const failures: unknown[] = [];
      try {
        await proxy.close();
      } catch (error) {
        failures.push(error);
      }
      const disposals = await Promise.allSettled([
        ...(targetId ? [this.cdp.send("Target.closeTarget", { targetId })] : []),
        ...(contextId
          ? [this.cdp.send("Target.disposeBrowserContext", { browserContextId: contextId })]
          : []),
      ]);
      for (const disposal of disposals)
        if (disposal.status === "rejected") failures.push(disposal.reason);
      if (failures.length) {
        if (storedResponseId) this.responses.delete(storedResponseId);
        throw new AggregateError(
          executionFailed ? [executionFailure, ...failures] : failures,
          "Chromium fetch resource cleanup failed"
        );
      }
    }
  }

  read(responseId: string, offset: number, limit: number): { bytesBase64: string; done: boolean } {
    this.prune();
    const response = this.responses.get(responseId);
    if (!response) throw new Error("Chromium fetch response expired or was closed");
    const start = Math.max(0, Math.min(response.bytes.byteLength, offset));
    const end = Math.min(response.bytes.byteLength, start + Math.max(1, limit));
    return {
      bytesBase64: Buffer.from(response.bytes.subarray(start, end)).toString("base64"),
      done: end >= response.bytes.byteLength,
    };
  }

  close(responseId: string): void {
    this.responses.delete(responseId);
  }

  private async createBrowserContext(proxyServer: string): Promise<string> {
    const result = (await this.cdp.send("Target.createBrowserContext", {
      disposeOnDetach: false,
      proxyServer,
      proxyBypassList: "<-loopback>",
    })) as { browserContextId: string };
    return result.browserContextId;
  }

  private navigate(
    url: string,
    sessionId: string
  ): Promise<{
    requestId: string;
    url: string;
    status: number;
    statusText: string;
    headers: Record<string, string>;
  }> {
    return new Promise((resolve, reject) => {
      let documentResponse:
        | {
            requestId: string;
            url: string;
            status: number;
            statusText: string;
            headers: Record<string, string>;
          }
        | undefined;
      const finish = (error?: Error) => {
        clearTimeout(timer);
        stop();
        if (error) reject(error);
        else if (documentResponse) resolve(documentResponse);
        else reject(new Error("Chromium navigation completed without a document response"));
      };
      const stop = this.cdp.onEvent((event: CdpEventEnvelope) => {
        if (event.sessionId !== sessionId) return;
        const params = event.params as Record<string, unknown>;
        if (event.method === "Network.responseReceived" && params["type"] === "Document") {
          const response = params["response"] as Record<string, unknown>;
          documentResponse = {
            requestId: String(params["requestId"]),
            url: String(response["url"] ?? url),
            status: Number(response["status"] ?? 0),
            statusText: String(response["statusText"] ?? ""),
            headers: normalizeHeaders(response["headers"]),
          };
          return;
        }
        if (
          event.method === "Network.loadingFinished" &&
          documentResponse &&
          params["requestId"] === documentResponse.requestId
        ) {
          const encodedDataLength = Number(params["encodedDataLength"] ?? 0);
          if (encodedDataLength > MAX_RESPONSE_BYTES) {
            finish(new Error(`Chromium response exceeds ${MAX_RESPONSE_BYTES} byte limit`));
            return;
          }
          finish();
        } else if (event.method === "Network.loadingFailed" && params["type"] === "Document") {
          finish(
            new Error(`Chromium fetch failed: ${String(params["errorText"] ?? "network error")}`)
          );
        }
      });
      const timer = setTimeout(
        () => finish(new Error(`Chromium fetch timed out after ${FETCH_TIMEOUT_MS}ms`)),
        FETCH_TIMEOUT_MS
      );
      void this.cdp
        .send("Page.navigate", { url }, sessionId)
        .then((value) => {
          const errorText = (value as { errorText?: string }).errorText;
          if (errorText) finish(new Error(`Chromium fetch failed: ${errorText}`));
        })
        .catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
    });
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, response] of this.responses) {
      if (response.expiresAt <= now) this.responses.delete(id);
    }
  }
}

function normalizeHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([name, header]) => [
      name.toLocaleLowerCase(),
      String(header),
    ])
  );
}
