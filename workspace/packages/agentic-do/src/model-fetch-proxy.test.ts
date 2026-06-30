import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createModelCredentialSentinel,
  installUrlBoundModelFetchProxy,
} from "./model-fetch-proxy.js";

type Vibez1ModelFetchProxyGlobals = typeof globalThis & {
  __vibez1ModelFetchProxyState?: unknown;
  __vibez1ModelFetchProxyInstalled?: boolean;
  __vibez1PrepareModelWebSocket?: (
    url: string,
    headers: Headers | Record<string, string>
  ) => { url: string } | null;
};

const originalFetch = globalThis.fetch;

function resetModelFetchProxyGlobals(): void {
  const globals = globalThis as Vibez1ModelFetchProxyGlobals;
  globalThis.fetch = originalFetch;
  delete globals.__vibez1ModelFetchProxyState;
  delete globals.__vibez1ModelFetchProxyInstalled;
  delete globals.__vibez1PrepareModelWebSocket;
}

function decodeWebSocketMetadata(url: string): Record<string, string> {
  const encoded = new URL(url).searchParams.get("__vibez1_ws_headers");
  expect(encoded).toBeTruthy();
  const normalized = encoded!.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return Object.fromEntries(JSON.parse(Buffer.from(padded, "base64").toString("utf8")));
}

describe("model fetch proxy websocket preparation", () => {
  afterEach(() => {
    resetModelFetchProxyGlobals();
    vi.restoreAllMocks();
  });

  it("encodes ChatGPT Codex websocket headers with the required origin", () => {
    globalThis.fetch = vi.fn(async () => new Response("ok")) as unknown as typeof fetch;
    installUrlBoundModelFetchProxy("https://chatgpt.com/backend-api", vi.fn());

    const globals = globalThis as Vibez1ModelFetchProxyGlobals;
    const prepared = globals.__vibez1PrepareModelWebSocket?.(
      "wss://chatgpt.com/backend-api/codex/responses",
      {
        Authorization: `Bearer ${createModelCredentialSentinel()}`,
        "OpenAI-Beta": "responses_websockets=2026-02-06",
        "chatgpt-account-id": "acct-1",
        "session-id": "session-1",
      }
    );

    expect(prepared?.url).toContain("__vibez1_ws_headers=");
    const metadata = decodeWebSocketMetadata(prepared!.url);
    expect(metadata).toMatchObject({
      "openai-beta": "responses_websockets=2026-02-06",
      "chatgpt-account-id": "acct-1",
      origin: "https://chatgpt.com",
      "session-id": "session-1",
    });
    expect(metadata).not.toHaveProperty("authorization");
  });

  it("routes fetch websocket upgrades through encoded metadata without the sentinel bearer", async () => {
    const originalFetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
    globalThis.fetch = originalFetchMock as unknown as typeof fetch;
    const routeFetcher = vi.fn(async () => new Response("proxied"));
    installUrlBoundModelFetchProxy("https://chatgpt.com/backend-api", routeFetcher);

    await globalThis.fetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${createModelCredentialSentinel()}`,
        Upgrade: "websocket",
        "OpenAI-Beta": "responses_websockets=2026-02-06",
        "session-id": "session-1",
      },
    });

    expect(routeFetcher).not.toHaveBeenCalled();
    expect(originalFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = originalFetchMock.mock.calls[0]!;
    expect(String(url)).toContain("__vibez1_ws_headers=");
    const metadata = decodeWebSocketMetadata(String(url));
    expect(metadata).toMatchObject({
      "openai-beta": "responses_websockets=2026-02-06",
      origin: "https://chatgpt.com",
      "session-id": "session-1",
    });
    expect(metadata).not.toHaveProperty("authorization");
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
  });
});
