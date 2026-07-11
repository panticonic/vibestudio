import { describe, expect, it } from "vitest";
import {
  type ConnectPairing,
  createConnectDeepLink,
  createConnectPairUrl,
  DEFAULT_SIGNAL_URL,
  isLoopbackHost,
  isSelectedWorkspaceUrl,
  normalizeFingerprint,
  parseConnectLink,
  parseSignalingEndpoint,
  resolveSignalingUrl,
  selectedWorkspaceNameFromUrl,
  selectedWorkspaceUrl,
  serverCdpHostWsUrl,
  serverRpcHttpUrl,
  serverRpcStreamHttpUrl,
  serverRpcWsUrl,
} from "./connect";

const FP = "AA".repeat(32); // 64 hex chars = a SHA-256
const PAIR: ConnectPairing = {
  room: "11111111-2222-3333-4444-555555555555",
  fp: FP,
  code: "A".repeat(32),
  sig: "wss://signal.example/",
  v: 2,
  ice: "all",
};

function replaceConnectParam(link: string, key: string, value: string): string {
  return link.replace(new RegExp(`([?&#])${key}=[^&]*`), `$1${key}=${encodeURIComponent(value)}`);
}

describe("connect deep links (WebRTC pairing grammar)", () => {
  it("round-trips a pairing link", () => {
    const link = createConnectDeepLink(PAIR);
    expect(parseConnectLink(link)).toEqual({
      kind: "ok",
      room: PAIR.room,
      fp: PAIR.fp,
      code: PAIR.code,
      sig: "wss://signal.example/",
      v: 2,
      ice: "all",
      srv: undefined,
    });
  });

  it("round-trips the https pair carrier with identical payload semantics", () => {
    const link = createConnectPairUrl({ ...PAIR, srv: "remote box" });
    expect(link).toMatch(/^https:\/\/vibestudio\.app\/pair#/);
    expect(parseConnectLink(link)).toEqual({
      kind: "ok",
      room: PAIR.room,
      fp: PAIR.fp,
      code: PAIR.code,
      sig: "wss://signal.example/",
      v: 2,
      ice: "all",
      srv: "remote box",
    });
  });

  it("requires the exact current protocol version", () => {
    const canonical = createConnectDeepLink(PAIR);
    for (const stale of [
      replaceConnectParam(canonical, "v", "1"),
      replaceConnectParam(canonical, "v", "3"),
      canonical.replace("&v=2", ""),
    ]) {
      const parsed = parseConnectLink(stale);
      expect(parsed.kind).toBe("error");
      if (parsed.kind === "error") {
        expect(parsed.reason).toMatch(/unsupported pairing protocol version/i);
      }
    }
  });

  it("carries the optional srv label and relay policy", () => {
    const link = createConnectDeepLink({ ...PAIR, srv: "home", ice: "relay" });
    const parsed = parseConnectLink(link);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") {
      expect(parsed.srv).toBe("home");
      expect(parsed.ice).toBe("relay");
    }
  });

  it("does not rely on URL support for the vibestudio custom scheme (RN/Hermes)", () => {
    // The parser must NOT call new URL() on a vibestudio: link. Simulate a runtime
    // where URL throws for the custom scheme; parsing must still succeed (it only
    // URL-parses the real `sig` endpoint, never the vibestudio: link itself).
    const RealURL = URL;
    function StubURL(this: unknown, input: string | URL, base?: string | URL): URL {
      if (String(input).startsWith("vibestudio:")) throw new Error("URL protocol not implemented");
      return base === undefined ? new RealURL(input) : new RealURL(input, base);
    }
    const original = globalThis.URL;
    globalThis.URL = StubURL as unknown as typeof URL;
    try {
      expect(parseConnectLink(createConnectDeepLink(PAIR)).kind).toBe("ok");
    } finally {
      globalThis.URL = original;
    }
  });

  it("rejects a link missing required params", () => {
    expect(parseConnectLink("vibestudio://connect?room=abcdefgh&fp=" + FP).kind).toBe("error");
    expect(parseConnectLink("vibestudio://connect?room=abcdefgh").kind).toBe("error");
    expect(parseConnectLink(createConnectDeepLink(PAIR).replace("&ice=all", "")).kind).toBe(
      "error"
    );
  });

  it("rejects unknown, duplicate, empty, and non-canonical carrier material", () => {
    const canonical = createConnectDeepLink(PAIR);
    expect(parseConnectLink(`${canonical}&url=https%3A%2F%2Fold.example`).kind).toBe("error");
    expect(parseConnectLink(`${canonical}&room=another-room`).kind).toBe("error");
    expect(parseConnectLink(`${canonical}&`).kind).toBe("error");
    expect(
      parseConnectLink(canonical.replace("vibestudio://connect?", "vibestudio://connect-old?"))
    ).toEqual({
      kind: "error",
      reason: "Not a vibestudio://connect link or Vibestudio pair URL",
    });
  });

  it("rejects a fingerprint that is not a SHA-256", () => {
    const bad = parseConnectLink(
      replaceConnectParam(createConnectDeepLink(PAIR), "fp", "DE:AD:BE:EF")
    );
    expect(bad).toEqual({
      kind: "error",
      reason: "DTLS fingerprint must be a SHA-256 (64 hex chars)",
    });
  });

  it("accepts a colon-delimited fingerprint and normalizes for comparison", () => {
    const colons = FP.match(/.{2}/g)!.join(":");
    const parsed = parseConnectLink(createConnectDeepLink({ ...PAIR, fp: colons }));
    expect(parsed.kind).toBe("ok");
    expect(normalizeFingerprint(colons)).toBe(FP.toUpperCase());
  });

  it("rejects malformed pairing codes", () => {
    const canonical = createConnectDeepLink(PAIR);
    expect(parseConnectLink(replaceConnectParam(canonical, "code", "short"))).toEqual({
      kind: "error",
      reason: "Pairing code has an unexpected format",
    });
    expect(parseConnectLink(replaceConnectParam(canonical, "code", "A".repeat(31))).kind).toBe(
      "error"
    );
    expect(parseConnectLink(replaceConnectParam(canonical, "code", "A".repeat(33))).kind).toBe(
      "error"
    );
  });

  it("rejects a cleartext signaling endpoint on a public host", () => {
    expect(
      parseConnectLink(
        replaceConnectParam(createConnectDeepLink(PAIR), "sig", "ws://signal.example/")
      ).kind
    ).toBe("error");
  });

  it("refuses to mint non-canonical pairing links", () => {
    expect(() => createConnectDeepLink({ ...PAIR, fp: "DE:AD:BE:EF" })).toThrow(
      /fingerprint must be SHA-256/
    );
    expect(() => createConnectDeepLink({ ...PAIR, code: "short" })).toThrow(
      /code has an unexpected format/
    );
    expect(() => createConnectDeepLink({ ...PAIR, sig: "ws://signal.example/" })).toThrow(
      /Cleartext signaling/
    );
    expect(() => createConnectDeepLink({ ...PAIR, v: 1 } as never)).toThrow(/expected v=2/);
  });

  it("allows a loopback cleartext signaling endpoint for dev", () => {
    expect(
      parseConnectLink(createConnectDeepLink({ ...PAIR, sig: "ws://127.0.0.1:8787/" })).kind
    ).toBe("ok");
  });

  it("validates the signaling endpoint scheme directly", () => {
    expect(parseSignalingEndpoint("wss://x/").kind).toBe("ok");
    expect(parseSignalingEndpoint("ftp://x/").kind).toBe("error");
    expect(parseSignalingEndpoint("ws://example.com/").kind).toBe("error");
  });

  it("resolves signaling URL by flag > env > hosted default", () => {
    expect(resolveSignalingUrl({ env: {} })).toEqual({
      url: DEFAULT_SIGNAL_URL,
      source: "default",
    });
    expect(
      resolveSignalingUrl({
        env: { VIBESTUDIO_WEBRTC_SIGNAL_URL: "wss://env.example" },
      })
    ).toEqual({ url: "wss://env.example/", source: "env" });
    expect(
      resolveSignalingUrl({
        flag: "wss://flag.example",
        env: { VIBESTUDIO_WEBRTC_SIGNAL_URL: "wss://env.example" },
      })
    ).toEqual({ url: "wss://flag.example/", source: "flag" });
  });

  describe("isLoopbackHost (replaces isTrustedCleartextHost — loopback only)", () => {
    it("trusts loopback and the Android emulator alias", () => {
      for (const h of ["localhost", "127.0.0.1", "127.1.2.3", "10.0.2.2", "::1"]) {
        expect(isLoopbackHost(h), h).toBe(true);
      }
    });
    it("does NOT trust LAN, Tailscale, .local, single-label, or spoofed-loopback hosts", () => {
      for (const h of [
        "192.168.1.20", // private LAN — no longer trusted (data plane is WebRTC)
        "100.64.1.20", // Tailscale CGNAT — decommissioned
        "box.local",
        "single-label-host",
        "127.evil.com", // sub-label spoof
        "127.0.0.1.evil.com",
        "example.com",
      ]) {
        expect(isLoopbackHost(h), h).toBe(false);
      }
    });
  });

  // The CLI ships a dependency-free Node mirror of this grammar in
  // scripts/cli/lib/connect-utils.mjs (raw `node`, no workspace deps). It MUST
  // stay byte-identical in behavior to connect.ts; these tests pin the lockstep.
  // The mirror is plain JS with no .d.ts, so import it via a runtime URL + cast
  // (a static specifier would trip TS7016 / implicit-any).
  type ConnectUtilsMirror = {
    createConnectDeepLink: (pairing: ConnectPairing) => string;
    createConnectPairUrl: (pairing: ConnectPairing) => string;
    parseConnectLink: (raw: string) => unknown;
    parseSignalingEndpoint: (raw: string) => unknown;
    normalizeFingerprint: (fp: string) => string;
    isLoopbackHost: (host: string) => boolean;
    resolveSignalingUrl: (options: {
      flag?: string | null;
      env?: Record<string, string | undefined>;
      envKeys?: readonly string[];
      defaultUrl?: string;
    }) => unknown;
  };
  const loadMirror = async (): Promise<ConnectUtilsMirror> => {
    const scriptUrl = new URL("../../../scripts/cli/lib/connect-utils.mjs", import.meta.url);
    return (await import(scriptUrl.href)) as ConnectUtilsMirror;
  };

  describe("scripts/cli/lib/connect-utils.mjs parity (new WebRTC grammar)", () => {
    it("mints and round-trips an identical deep link", async () => {
      const mirror = await loadMirror();
      const link = createConnectDeepLink(PAIR);
      expect(mirror.createConnectDeepLink(PAIR)).toBe(link);
      expect(mirror.parseConnectLink(link)).toEqual(parseConnectLink(link));
      const pairUrl = createConnectPairUrl(PAIR);
      expect(mirror.createConnectPairUrl(PAIR)).toBe(pairUrl);
      expect(mirror.parseConnectLink(pairUrl)).toEqual(parseConnectLink(pairUrl));
      const withSrv = createConnectDeepLink({ ...PAIR, srv: "home", ice: "relay" });
      expect(mirror.createConnectDeepLink({ ...PAIR, srv: "home", ice: "relay" })).toBe(withSrv);
      expect(mirror.parseConnectLink(withSrv)).toEqual(parseConnectLink(withSrv));
    });

    it("rejects the same malformed links the shared parser rejects", async () => {
      const mirror = await loadMirror();
      const canonical = createConnectDeepLink(PAIR);
      for (const bad of [
        "vibestudio://connect?room=abcdefgh&fp=" + FP,
        replaceConnectParam(canonical, "fp", "DE:AD:BE:EF"),
        replaceConnectParam(canonical, "code", "short"),
        replaceConnectParam(canonical, "sig", "ws://signal.example/"),
        replaceConnectParam(canonical, "v", "1"),
        `${canonical}&url=https%3A%2F%2Fold.example`,
        `${canonical}&room=duplicate-room`,
        "https://vibestudio.app/pair",
        "https://example.com/pair#v=2",
      ]) {
        expect(mirror.parseConnectLink(bad)).toEqual(parseConnectLink(bad));
      }
    });

    it("normalizes fingerprints and validates signaling endpoints identically", async () => {
      const mirror = await loadMirror();
      const colons = FP.match(/.{2}/g)!.join(":");
      expect(mirror.normalizeFingerprint(colons)).toBe(normalizeFingerprint(colons));
      for (const sig of ["wss://x/", "ftp://x/", "ws://example.com/", "ws://127.0.0.1:8787/"]) {
        expect(mirror.parseSignalingEndpoint(sig)).toEqual(parseSignalingEndpoint(sig));
      }
    });

    it("recognizes loopback hosts identically", async () => {
      const mirror = await loadMirror();
      for (const host of [
        "localhost",
        "127.0.0.1",
        "10.0.2.2",
        "::1",
        "192.168.1.20",
        "box.local",
        "127.evil.com",
      ]) {
        expect(mirror.isLoopbackHost(host)).toBe(isLoopbackHost(host));
      }
    });

    it("resolves signaling endpoints identically", async () => {
      const mirror = await loadMirror();
      const options = {
        flag: "wss://flag.example",
        env: { VIBESTUDIO_WEBRTC_SIGNAL_URL: "wss://env.example" },
      };
      expect(mirror.resolveSignalingUrl(options)).toEqual(resolveSignalingUrl(options));
      expect(mirror.resolveSignalingUrl({ env: {} })).toEqual(resolveSignalingUrl({ env: {} }));
    });
  });
});

describe("server route helpers (unchanged — survive the rewrite)", () => {
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
    expect(serverRpcWsUrl("https://server.example/_workspace/rpc")).toBe(
      "wss://server.example/_workspace/rpc/rpc"
    );
  });

  it("builds CDP host URLs while preserving selected workspace paths", () => {
    expect(serverCdpHostWsUrl("https://server.example", "host-a")).toBe(
      "wss://server.example/api/cdp-host?hostConnectionId=host-a"
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
  });
});
