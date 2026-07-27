import { describe, expect, it } from "vitest";
import { parseWebSocketAuthProtocol, webSocketAuthProtocol } from "./webSocketAuthProtocol.js";

describe("WebSocket upgrade authentication protocol", () => {
  it("round-trips opaque credentials without illegal protocol characters", () => {
    const protocol = webSocketAuthProtocol("rpc", "refresh:opaque/credential+✓");

    expect(protocol).toMatch(/^vibestudio\.auth\.rpc\.[A-Za-z0-9_-]+$/);
    expect(parseWebSocketAuthProtocol(protocol, "rpc")).toBe("refresh:opaque/credential+✓");
  });

  it("binds credentials to one lane and one protocol value", () => {
    const protocol = webSocketAuthProtocol("inspection", "grant");

    expect(parseWebSocketAuthProtocol(protocol, "rpc")).toBeNull();
    expect(parseWebSocketAuthProtocol(`${protocol}, other`, "inspection")).toBeNull();
    expect(parseWebSocketAuthProtocol("not a legal encoded credential", "inspection")).toBeNull();
  });

  it("rejects credentials too large for a bounded upgrade header", () => {
    expect(() => webSocketAuthProtocol("rpc", "x".repeat(4097))).toThrow(
      "credential must be 1-4096 bytes"
    );
  });
});
