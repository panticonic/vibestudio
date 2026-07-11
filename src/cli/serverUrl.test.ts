import { describe, expect, it } from "vitest";
import { normalizeServerBaseUrl, serverUrlsReferToSameBase } from "./serverUrl.js";

describe("server URL normalization", () => {
  it("accepts only canonical server base URL protocols", () => {
    expect(normalizeServerBaseUrl("http://127.0.0.1:5000/")).toBe("http://127.0.0.1:5000");
    expect(normalizeServerBaseUrl("https://host.example/_workspace/rpc")).toBe(
      "https://host.example/_workspace/rpc"
    );
    expect(normalizeServerBaseUrl("webrtc://room/_workspace/dev")).toBe(
      "webrtc://room/_workspace/dev"
    );
    expect(() => normalizeServerBaseUrl("ws://127.0.0.1:5000/rpc")).toThrow(
      /Unsupported server URL protocol/
    );
  });

  it("compares canonical bases exactly without folding concrete rpc endpoints", () => {
    expect(serverUrlsReferToSameBase("http://127.0.0.1:5000/", "http://127.0.0.1:5000")).toBe(true);
    expect(
      serverUrlsReferToSameBase(
        "https://host.example/_workspace/rpc/rpc",
        "https://host.example/_workspace/rpc"
      )
    ).toBe(false);
    expect(serverUrlsReferToSameBase("ws://host/rpc", "http://host")).toBe(false);
  });
});
