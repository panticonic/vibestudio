import { describe, expect, it, vi } from "vitest";
import * as http from "node:http";
import { handleExternalOpenPayload } from "./oauthLoopbackHandoff.js";

describe("handleExternalOpenPayload", () => {
  it("opens plain external URLs without starting an OAuth callback", async () => {
    const openExternal = vi.fn(async () => undefined);
    const forwardOAuthCallback = vi.fn(async () => undefined);
    const cancelOAuth = vi.fn(async () => undefined);

    await handleExternalOpenPayload(
      {
        url: "https://example.test/path",
        callerId: "shell:test",
        callerKind: "shell",
      },
      {
        openExternal,
        forwardOAuthCallback,
        cancelOAuth,
      }
    );

    expect(openExternal).toHaveBeenCalledWith("https://example.test/path");
    expect(forwardOAuthCallback).not.toHaveBeenCalled();
    expect(cancelOAuth).not.toHaveBeenCalled();
  });

  it("forwards client-loopback OAuth callbacks after opening the browser", async () => {
    const port = await getFreePort();
    const openExternal = vi.fn(async () => {
      setImmediate(() => {
        void httpGet(`http://127.0.0.1:${port}/auth/callback?code=code-1&state=state-1`);
      });
    });
    const forwardOAuthCallback = vi.fn(async () => undefined);
    const cancelOAuth = vi.fn(async () => undefined);

    await handleExternalOpenPayload(
      {
        url: "https://auth.example.test/oauth/authorize",
        callerId: "shell:test",
        callerKind: "shell",
        oauthLoopback: {
          transactionId: "tx-1",
          redirectUri: `http://127.0.0.1:${port}/auth/callback`,
          host: "127.0.0.1",
          port,
          callbackPath: "/auth/callback",
          state: "state-1",
          timeoutMs: 5_000,
        },
      },
      {
        openExternal,
        forwardOAuthCallback,
        cancelOAuth,
      }
    );

    expect(openExternal).toHaveBeenCalledWith("https://auth.example.test/oauth/authorize");
    expect(forwardOAuthCallback).toHaveBeenCalledWith({
      transactionId: "tx-1",
      url: `http://127.0.0.1:${port}/auth/callback?code=code-1&state=state-1`,
      state: "state-1",
    });
    expect(cancelOAuth).not.toHaveBeenCalled();
  });

  it("cancels the server transaction when the browser cannot open", async () => {
    const port = await getFreePort();
    const cancelOAuth = vi.fn(async () => undefined);

    await expect(
      handleExternalOpenPayload(oauthPayload(port), {
        openExternal: async () => {
          throw new Error("browser unavailable");
        },
        forwardOAuthCallback: vi.fn(async () => undefined),
        cancelOAuth,
      })
    ).rejects.toThrow("browser unavailable");

    expect(cancelOAuth).toHaveBeenCalledOnce();
    expect(cancelOAuth).toHaveBeenCalledWith("tx-1");
  });

  it("cancels the server transaction when the callback state does not match", async () => {
    const port = await getFreePort();
    const cancelOAuth = vi.fn(async () => undefined);
    let response: Promise<HttpResult> | undefined;

    await expect(
      handleExternalOpenPayload(oauthPayload(port), {
        openExternal: async () => {
          response = httpGetResult(
            `http://127.0.0.1:${port}/auth/callback?code=code-1&state=wrong-state`
          );
        },
        forwardOAuthCallback: vi.fn(async () => undefined),
        cancelOAuth,
      })
    ).rejects.toThrow("OAuth state mismatch");

    await expect(response).resolves.toMatchObject({ status: 400, body: "OAuth state mismatch." });
    expect(cancelOAuth).toHaveBeenCalledWith("tx-1");
  });

  it("cancels the server transaction when the callback times out", async () => {
    const port = await getFreePort();
    const cancelOAuth = vi.fn(async () => undefined);

    await expect(
      handleExternalOpenPayload(
        {
          ...oauthPayload(port),
          oauthLoopback: { ...oauthPayload(port).oauthLoopback!, timeoutMs: 1 },
        },
        {
          openExternal: vi.fn(async () => undefined),
          forwardOAuthCallback: vi.fn(async () => undefined),
          cancelOAuth,
        }
      )
    ).rejects.toThrow("OAuth callback timed out");

    expect(cancelOAuth).toHaveBeenCalledWith("tx-1");
  });

  it("reports a safely escaped browser error and cancels when forwarding fails", async () => {
    const port = await getFreePort();
    const cancelOAuth = vi.fn(async () => {
      throw new Error("secondary cancellation failure");
    });
    let response: Promise<HttpResult> | undefined;

    await expect(
      handleExternalOpenPayload(oauthPayload(port), {
        openExternal: async () => {
          response = httpGetResult(
            `http://127.0.0.1:${port}/auth/callback?code=code-1&state=state-1`
          );
        },
        forwardOAuthCallback: async () => {
          throw new Error("exchange <failed> & retry");
        },
        cancelOAuth,
      })
    ).rejects.toThrow("exchange <failed> & retry");

    const browserResponse = await response;
    expect(browserResponse).toMatchObject({ status: 502 });
    expect(browserResponse?.body).toContain("exchange &lt;failed&gt; &amp; retry");
    expect(browserResponse?.body).not.toContain("exchange <failed>");
    expect(cancelOAuth).toHaveBeenCalledWith("tx-1");
  });
});

function oauthPayload(port: number) {
  return {
    url: "https://auth.example.test/oauth/authorize",
    callerId: "shell:test",
    callerKind: "shell" as const,
    oauthLoopback: {
      transactionId: "tx-1",
      redirectUri: `http://127.0.0.1:${port}/auth/callback`,
      host: "127.0.0.1" as const,
      port,
      callbackPath: "/auth/callback",
      state: "state-1",
      timeoutMs: 5_000,
    },
  };
}

interface HttpResult {
  status: number;
  body: string;
}

function httpGetResult(url: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
      })
      .on("error", reject);
  });
}

async function getFreePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function httpGet(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        res.resume();
        res.on("end", resolve);
      })
      .on("error", reject);
  });
}
