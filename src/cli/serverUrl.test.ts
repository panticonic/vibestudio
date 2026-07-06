import { describe, expect, it } from "vitest";
import { normalizeServerBaseUrl, serverUrlsReferToSameBase } from "./serverUrl.js";

describe("server URL normalization", () => {
  it("accepts legacy websocket rpc endpoints as RpcClient base URLs", () => {
    expect(normalizeServerBaseUrl("ws://127.0.0.1:5000/rpc")).toBe("http://127.0.0.1:5000");
    expect(normalizeServerBaseUrl("wss://host.example/_workspace/dev/rpc")).toBe(
      "https://host.example/_workspace/dev"
    );
    expect(normalizeServerBaseUrl("https://host.example/_workspace/rpc")).toBe(
      "https://host.example/_workspace/rpc"
    );
  });

  it("compares legacy marker endpoints without breaking workspaces named rpc", () => {
    expect(serverUrlsReferToSameBase("ws://127.0.0.1:5000/rpc", "http://127.0.0.1:5000")).toBe(
      true
    );
    expect(
      serverUrlsReferToSameBase(
        "https://host.example/_workspace/rpc/rpc",
        "https://host.example/_workspace/rpc"
      )
    ).toBe(true);
  });
});
