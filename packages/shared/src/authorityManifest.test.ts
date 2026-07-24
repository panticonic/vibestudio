import { describe, expect, it } from "vitest";

import { parseUnitAuthorityManifest } from "./authorityManifest.js";

describe("unit authority manifest", () => {
  it("does not charge runtime-intrinsic extension lifecycle calls to authors", () => {
    const authority = parseUnitAuthorityManifest({ requests: [] });
    expect(authority.requests).toEqual([]);
  });

  it("requires the one canonical installed-code request section", () => {
    expect(parseUnitAuthorityManifest({ requests: [] })).toEqual({
      requests: [],
    });
    expect(() => parseUnitAuthorityManifest({})).toThrow(/requests/);
    expect(() => parseUnitAuthorityManifest({ evalCeilings: [] })).toThrow(/unknown field/);
    expect(() =>
      parseUnitAuthorityManifest({ requests: [], futureAuthority: [] })
    ).toThrow(/unknown field.*futureAuthority/);
  });

  it("requires exact installed-code requests and rejects dynamic wildcard authority", () => {
    expect(() =>
      parseUnitAuthorityManifest({
        requests: [
          {
            capability: "workspace-service:*",
            resource: { kind: "prefix", prefix: "" },
            tier: "gated",
            evidence: "intentional-broad",
          },
        ],
      })
    ).toThrow(/Invalid capability pattern/);

    expect(() =>
      parseUnitAuthorityManifest({
        requests: [],
        evalCeilings: [{ audience: "eval", capabilities: [] }],
      })
    ).toThrow(/unknown field/);
  });

  it("reports the exact malformed manifest field", () => {
    expect(() =>
      parseUnitAuthorityManifest({
        requests: [
          {
            capability: "workspace-service:notes",
            resource: { kind: "prefix", prefix: "" },
            tier: "open",
            evidence: "bounded-dynamic",
          },
        ],
      })
    ).toThrow(
      'vibestudio.authority.requests[0].tier must be "gated" or "critical"; RPC receiver tier "open" is not a manifest request tier'
    );
  });
});
