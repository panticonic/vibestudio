import { describe, expect, it } from "vitest";
import { remoteGatewayServerUrl } from "./serverSession.js";

describe("remoteGatewayServerUrl", () => {
  it("preserves the canonical remote origin without adding default ports", () => {
    expect(remoteGatewayServerUrl(new URL("https://host.tailnet.ts.net"))).toBe(
      "https://host.tailnet.ts.net"
    );
    expect(remoteGatewayServerUrl(new URL("https://host.tailnet.ts.net:443"))).toBe(
      "https://host.tailnet.ts.net"
    );
    expect(remoteGatewayServerUrl(new URL("http://100.73.236.5:3030"))).toBe(
      "http://100.73.236.5:3030"
    );
  });
});
