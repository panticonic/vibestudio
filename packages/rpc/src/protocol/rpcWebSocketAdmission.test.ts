import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RPC_CLIENT_LABEL_HEADER,
  requestRpcWebSocketAdmission,
  rpcWebSocketAdmissionUrl,
} from "./rpcWebSocketAdmission.js";

describe("RPC WebSocket admission protocol", () => {
  afterEach(() => vi.unstubAllGlobals());

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
});
