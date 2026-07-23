import { describe, expect, it } from "vitest";

import { parseUnitAuthorityManifest } from "./authorityManifest.js";

describe("unit authority manifest", () => {
  it("does not charge runtime-intrinsic extension lifecycle calls to authors", () => {
    const authority = parseUnitAuthorityManifest({ requests: [], evalCeilings: [] });
    expect(authority.requests).toEqual([]);
  });

  it("defaults omitted orthogonal sections to an empty, fail-closed envelope", () => {
    expect(parseUnitAuthorityManifest({ requests: [] })).toEqual({
      requests: [],
      evalCeilings: [],
    });
    expect(parseUnitAuthorityManifest({ evalCeilings: [] })).toEqual({
      requests: [],
      evalCeilings: [],
    });
    expect(() => parseUnitAuthorityManifest({})).toThrow(/requests or evalCeilings/);
    expect(() =>
      parseUnitAuthorityManifest({ requests: [], futureAuthority: [] })
    ).toThrow(/unknown field.*futureAuthority/);
  });

  it("allows dynamic wildcard ceilings but requires exact installed requests", () => {
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
        evalCeilings: [],
      })
    ).toThrow(/Invalid capability pattern/);

    expect(
      parseUnitAuthorityManifest({
        requests: [],
        evalCeilings: [
          {
            audience: "eval",
            purpose: "agentic-code-execution",
            capabilities: [
              {
                capability: "workspace-service:*",
                resource: { kind: "prefix", prefix: "" },
                tier: "gated",
                evidence: "intentional-broad",
              },
            ],
          },
        ],
      }).evalCeilings[0]?.capabilities[0]?.capability
    ).toBe("workspace-service:*");
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
        evalCeilings: [],
      })
    ).toThrow(
      'vibestudio.authority.requests[0].tier must be "gated" or "critical"; RPC receiver tier "open" is not a manifest request tier'
    );
  });
});
