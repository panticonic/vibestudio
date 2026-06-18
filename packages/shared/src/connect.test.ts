import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createConnectDeepLink,
  isSelectedWorkspaceUrl,
  isTrustedCleartextHost,
  parseConnectLink,
  parseConnectServerUrl,
  selectedWorkspaceNameFromUrl,
  selectedWorkspaceUrl,
  serverCdpHostWsUrl,
  serverRpcHttpUrl,
  serverRpcStreamHttpUrl,
  serverRpcWsUrl,
} from "./connect";

function ipv4(address: string): os.NetworkInterfaceInfo {
  return {
    family: "IPv4",
    address,
    internal: false,
    netmask: "255.255.255.0",
    mac: "00:00:00:00:00:00",
    cidr: `${address}/24`,
  };
}

describe("connect deep links", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("round-trips a pairing link", () => {
    const link = createConnectDeepLink("https://host.tailnet.ts.net", "A".repeat(24));
    expect(parseConnectLink(link)).toEqual({
      kind: "ok",
      url: "https://host.tailnet.ts.net",
      code: "A".repeat(24),
    });
  });

  it("does not rely on URL support for the natstack custom scheme", () => {
    const RealURL = URL;
    const urlSpy = vi.fn((input: string | URL, base?: string | URL) => {
      if (String(input).startsWith("natstack:")) {
        throw new Error("URL protocol is not implemented");
      }
      return base === undefined ? new RealURL(input) : new RealURL(input, base);
    });
    vi.stubGlobal("URL", urlSpy);

    const link = createConnectDeepLink("https://host.tailnet.ts.net", "A".repeat(24));
    expect(parseConnectLink(link)).toEqual({
      kind: "ok",
      url: "https://host.tailnet.ts.net",
      code: "A".repeat(24),
    });
  });

  it("rejects public cleartext HTTP", () => {
    expect(parseConnectLink(createConnectDeepLink("http://example.com", "A".repeat(24)))).toEqual({
      kind: "error",
      reason:
        "Cleartext HTTP is only allowed for loopback, private LAN, Tailscale, or local hostnames. Use https:// for example.com.",
    });
  });

  it("rejects server URLs that are not plain origins", () => {
    expect(
      parseConnectLink(createConnectDeepLink("https://host.tailnet.ts.net/base", "A".repeat(24)))
    ).toEqual({
      kind: "error",
      reason: "Server URL must be an origin without a path, query, or fragment",
    });
    expect(
      parseConnectLink(createConnectDeepLink("https://user@host.tailnet.ts.net", "A".repeat(24)))
    ).toEqual({
      kind: "error",
      reason: "Server URL must be an origin without a path, query, or fragment",
    });
  });

  it("accepts local cleartext hosts", () => {
    expect(isTrustedCleartextHost("localhost")).toBe(true);
    expect(isTrustedCleartextHost("192.168.1.20")).toBe(true);
    expect(isTrustedCleartextHost("100.64.1.20")).toBe(true);
    expect(isTrustedCleartextHost("box.local")).toBe(true);
  });

  it("rejects malformed codes", () => {
    expect(parseConnectLink(createConnectDeepLink("https://host.tailnet.ts.net", "short"))).toEqual(
      {
        kind: "error",
        reason: "Pairing code has an unexpected format",
      }
    );
  });

  it("stays in parity with the plain Node script helpers", async () => {
    const scriptUrl = new URL("../../../scripts/cli/lib/connect-utils.mjs", import.meta.url);
    const script = (await import(scriptUrl.href)) as {
      createConnectDeepLink: (url: string, code: string) => string;
      createStartRemotePairCommand: (url: string, code: string) => string;
      parseConnectLink: (raw: string) => unknown;
    };
    const fixtures = [
      createConnectDeepLink("https://host.tailnet.ts.net", "A".repeat(24)),
      createConnectDeepLink("http://127.0.0.1:3030", "B".repeat(24)),
      createConnectDeepLink("http://example.com", "C".repeat(24)),
      createConnectDeepLink("https://host.tailnet.ts.net/base", "D".repeat(24)),
      "not-a-link",
      createConnectDeepLink("https://host.tailnet.ts.net", "short"),
    ];

    expect(script.createConnectDeepLink("https://host.tailnet.ts.net", "A".repeat(24))).toBe(
      createConnectDeepLink("https://host.tailnet.ts.net", "A".repeat(24))
    );
    expect(script.createStartRemotePairCommand("https://host.tailnet.ts.net", "A".repeat(24))).toBe(
      `natstack remote pair '${createConnectDeepLink(
        "https://host.tailnet.ts.net",
        "A".repeat(24)
      )}'`
    );
    for (const fixture of fixtures) {
      expect(script.parseConnectLink(fixture)).toEqual(parseConnectLink(fixture));
    }
  });

  it("keeps the trusted-cleartext-host boundary identical to the script mirror", async () => {
    const scriptUrl = new URL("../../../scripts/cli/lib/connect-utils.mjs", import.meta.url);
    const script = (await import(scriptUrl.href)) as {
      isTrustedCleartextHost: (host: string) => boolean;
      parseConnectServerUrl: (raw: string) => unknown;
    };
    // Includes the over-permissive-loopback attack vectors that previously diverged: a non-loopback
    // hostname or sub-label that merely starts with "127." must NOT be trusted.
    const hosts = [
      "localhost",
      "10.0.2.2",
      "127.0.0.1",
      "127.1.2.3",
      "127.evil.com",
      "127.0.0.1.evil.com",
      "1270.0.0.1",
      "10.0.0.1",
      "172.15.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "172.32.0.1",
      "192.168.1.20",
      "192.169.1.20",
      "100.63.0.1",
      "100.64.1.20",
      "100.127.0.1",
      "100.128.0.1",
      "host.tailnet.ts.net",
      "ts.net",
      "evil-ts.net.attacker.com",
      "box.local",
      "single-label-host",
      "example.com",
      "sub.example.com",
    ];
    for (const host of hosts) {
      expect(script.isTrustedCleartextHost(host), host).toBe(isTrustedCleartextHost(host));
    }

    const serverUrls = [
      "http://127.0.0.1:3030",
      "http://127.evil.com:3030",
      "http://192.168.1.20",
      "http://example.com",
      "https://example.com",
      "http://host.tailnet.ts.net/base",
    ];
    for (const url of serverUrls) {
      expect(script.parseConnectServerUrl(url)).toEqual(parseConnectServerUrl(url));
    }
  });

  it("requires an actual Tailscale interface when the script selector is tailscale", async () => {
    const scriptUrl = new URL("../../../scripts/cli/lib/connect-utils.mjs", import.meta.url);
    const script = (await import(scriptUrl.href)) as {
      pickMobileHost: (
        preference: string,
        options?: { includeTunnel?: boolean }
      ) => {
        address: string;
      };
    };
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      eth0: [ipv4("192.168.1.20")],
    });

    expect(() => script.pickMobileHost("tailscale", { includeTunnel: true })).toThrow(
      "Could not detect a Tailscale IPv4 interface"
    );
    expect(script.pickMobileHost("vpn", { includeTunnel: true }).address).toBe("192.168.1.20");
  });

  it("selects a Tailscale address for the script tailscale selector", async () => {
    const scriptUrl = new URL("../../../scripts/cli/lib/connect-utils.mjs", import.meta.url);
    const script = (await import(scriptUrl.href)) as {
      pickMobileHost: (
        preference: string,
        options?: { includeTunnel?: boolean }
      ) => {
        address: string;
      };
    };
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      eth0: [ipv4("192.168.1.20")],
      tailscale0: [ipv4("100.75.165.121")],
    });

    expect(script.pickMobileHost("tailscale", { includeTunnel: true }).address).toBe(
      "100.75.165.121"
    );
  });
});

describe("server route helpers", () => {
  it("builds RPC URLs while preserving selected workspace paths", () => {
    expect(serverRpcHttpUrl("https://server.example").toString()).toBe(
      "https://server.example/rpc"
    );
    expect(serverRpcWsUrl("https://server.example/_workspace/dev")).toBe(
      "wss://server.example/_workspace/dev/rpc"
    );
    expect(serverRpcStreamHttpUrl("http://127.0.0.1:3030/_workspace/dev").toString()).toBe(
      "http://127.0.0.1:3030/_workspace/dev/rpc/stream"
    );
    // A workspace literally named "rpc" must still get the RPC path appended — the helpers append
    // unconditionally and never treat a trailing "/rpc" workspace segment as an existing endpoint.
    expect(serverRpcWsUrl("https://server.example/_workspace/rpc")).toBe(
      "wss://server.example/_workspace/rpc/rpc"
    );
    expect(serverRpcStreamHttpUrl("https://server.example/_workspace/rpc").toString()).toBe(
      "https://server.example/_workspace/rpc/rpc/stream"
    );
  });

  it("builds CDP host URLs while preserving selected workspace paths", () => {
    expect(serverCdpHostWsUrl("https://server.example", "host-a")).toBe(
      "wss://server.example/api/cdp-host?hostConnectionId=host-a"
    );
    expect(serverCdpHostWsUrl("https://server.example/_workspace/dev", "host-a")).toBe(
      "wss://server.example/_workspace/dev/api/cdp-host?hostConnectionId=host-a"
    );
    expect(serverCdpHostWsUrl("http://127.0.0.1:3030/_workspace/dev/", "host a")).toBe(
      "ws://127.0.0.1:3030/_workspace/dev/api/cdp-host?hostConnectionId=host+a"
    );
  });

  it("builds and parses selected workspace URLs through one shared contract", () => {
    const url = selectedWorkspaceUrl("https://server.example", "dev workspace");
    expect(url.toString()).toBe("https://server.example/_workspace/dev%20workspace");
    expect(selectedWorkspaceNameFromUrl(url)).toBe("dev workspace");
    expect(isSelectedWorkspaceUrl(url)).toBe(true);
    expect(isSelectedWorkspaceUrl("https://server.example/_workspace/dev/rpc")).toBe(false);
    expect(selectedWorkspaceNameFromUrl("not a url")).toBeNull();
  });
});
