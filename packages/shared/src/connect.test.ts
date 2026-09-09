import { describe, expect, it } from "vitest";
import {
  appendServerPath,
  connectPairingFromLink,
  createConnectDeepLink,
  createConnectPairUrl,
  isLoopbackHost,
  parseConnectLink,
  selectedWorkspaceNameFromUrl,
  selectedWorkspaceUrl,
  serverCdpHostWsUrl,
  serverRpcHttpUrl,
  serverRpcWsUrl,
  type ConnectPairing,
} from "./connect.js";

const pairing: ConnectPairing = {
  endpointId: "ab".repeat(32),
  code: "A".repeat(22),
  relays: ["https://relay-a.example/", "https://relay-b.example/"],
  v: 5,
};

describe("Iroh connect links", () => {
  it("round-trips the exact endpoint, ordered relay set, and code", () => {
    const scheme = parseConnectLink(createConnectDeepLink(pairing));
    const https = parseConnectLink(createConnectPairUrl(pairing));
    expect(scheme).toEqual({ kind: "ok", ...pairing });
    expect(https).toEqual(scheme);
    if (scheme.kind !== "ok") throw new Error(scheme.reason);
    expect(connectPairingFromLink(scheme)).toEqual(pairing);
  });

  it("rejects malformed, noncanonical, and credential-bearing reaches", () => {
    expect(parseConnectLink("vibestudio://connect/not-base64!")).toMatchObject({
      kind: "error",
    });
    expect(() => createConnectDeepLink({ ...pairing, endpointId: "AB".repeat(32) })).toThrow(
      /endpointId/
    );
    expect(() =>
      createConnectDeepLink({ ...pairing, relays: ["https://token@example.test/"] })
    ).toThrow(/credential-free/);
    expect(() => createConnectDeepLink({ ...pairing, relays: [] })).toThrow(/1-8/);
  });

  it("keeps the generated dependency-free parser byte-compatible", async () => {
    // @ts-expect-error Generated raw-Node artifact deliberately has no declaration sidecar.
    const generated = await import("../../../scripts/cli/lib/connect-grammar.generated.mjs");
    const link = createConnectDeepLink(pairing);
    expect(generated.createConnectDeepLink(pairing)).toBe(link);
    expect(generated.parseConnectLink(link)).toEqual({ kind: "ok", ...pairing });
  });
});

describe("server route helpers", () => {
  it("preserves selected-workspace paths across loopback HTTP and WebSocket routes", () => {
    const selected = selectedWorkspaceUrl("http://127.0.0.1:4010", "hello world");
    expect(selectedWorkspaceNameFromUrl(selected)).toBe("hello world");
    expect(serverRpcHttpUrl(selected).toString()).toBe(
      "http://127.0.0.1:4010/_workspace/hello%20world/rpc"
    );
    expect(serverRpcWsUrl(selected)).toBe("ws://127.0.0.1:4010/_workspace/hello%20world/rpc");
    expect(serverCdpHostWsUrl(selected, "host-1")).toBe(
      "ws://127.0.0.1:4010/_workspace/hello%20world/api/cdp-host?hostConnectionId=host-1"
    );
  });

  it("recognizes only actual loopback hosts", () => {
    for (const host of ["localhost", "127.0.0.1", "127.4.5.6", "::1", "10.0.2.2"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ["192.168.1.2", "host.local", "127.example.com", "tailscale-host"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
    expect(appendServerPath("https://example.test/base?old=1#x", "/next").toString()).toBe(
      "https://example.test/base/next"
    );
  });
});
