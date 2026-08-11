import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RPC_CLIENT_LABEL_HEADER,
  requestRpcWebSocketAdmission,
  rpcWebSocketAdmissionUrl,
} from "./rpcWebSocketAdmission.js";

describe("RPC WebSocket admission protocol", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("derives the typed HTTP endpoint from the WebSocket URL", () => {
    expect(rpcWebSocketAdmissionUrl("wss://server.example/_workspace/dev/rpc?old=1")).toBe(
      "https://server.example/_workspace/dev/rpc/ws-admission"
    );
  });

  it("uses an empty body and bounded headers, preserving unicode labels", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.body).toBeUndefined();
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer refresh:device:secret",
        [RPC_CLIENT_LABEL_HEADER]: "M%C3%BCnchen%20phone",
      });
      return new Response(JSON.stringify({ ok: true, grant: "a".repeat(64), expiresAt: 1234 }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      requestRpcWebSocketAdmission("https://server.example/rpc/ws-admission", {
        credential: "refresh:device:secret",
        clientLabel: "München phone",
        clientPlatform: "mobile",
      })
    ).resolves.toEqual({ ok: true, grant: "a".repeat(64), expiresAt: 1234 });
  });

  it("rejects an unknown failure code instead of widening the typed protocol", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: false, code: "mystery", message: "nope" }), {
            status: 401,
          })
      )
    );

    await expect(
      requestRpcWebSocketAdmission("https://server.example/rpc/ws-admission", {
        credential: "bad",
      })
    ).rejects.toThrow("returned malformed HTTP 401");
  });

  it("normalizes an empty optional label to an absent header", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, grant: "grant", expiresAt: 1234 }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await requestRpcWebSocketAdmission("https://server.example/rpc/ws-admission", {
      credential: "token",
      clientLabel: "",
    });

    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty(RPC_CLIENT_LABEL_HEADER);
  });

  it("aborts a hung admission request at its explicit deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError")),
              { once: true }
            );
          })
      )
    );

    const pending = requestRpcWebSocketAdmission(
      "https://server.example/rpc/ws-admission",
      { credential: "token" },
      { timeoutMs: 250 }
    );
    const rejected = expect(pending).rejects.toThrow(
      "RPC WebSocket admission timed out after 250ms"
    );
    await vi.advanceTimersByTimeAsync(250);
    await rejected;
  });
});
