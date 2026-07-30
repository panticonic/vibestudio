import { describe, expect, it } from "vitest";

import { parseUnitAuthorityManifest } from "./authorityManifest.js";

describe("unit authority manifest", () => {
  it("does not charge runtime-intrinsic extension lifecycle calls to authors", () => {
    const authority = parseUnitAuthorityManifest({ requests: [], provides: [] });
    expect(authority.requests).toEqual([]);
  });

  it("requires the one canonical installed-code request section", () => {
    expect(parseUnitAuthorityManifest({ requests: [], provides: [] })).toEqual({
      requests: [],
      provides: [],
    });
    expect(() => parseUnitAuthorityManifest({})).toThrow(/requests/);
    expect(() => parseUnitAuthorityManifest({ evalCeilings: [] })).toThrow(/unknown field/);
    expect(() =>
      parseUnitAuthorityManifest({ requests: [], provides: [], futureAuthority: [] })
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
        provides: [],
      })
    ).toThrow(/Invalid capability pattern/);

    expect(() =>
      parseUnitAuthorityManifest({
        requests: [],
        provides: [],
        evalCeilings: [{ audience: "eval", capabilities: [] }],
      })
    ).toThrow(/unknown field/);
  });

  it("accepts only provider-bound userland definition families as dynamic requests", () => {
    expect(
      parseUnitAuthorityManifest({
        requests: [
          {
            capability: "userland:extensions/shell/native.shell.execute#*",
            resource: {
              kind: "exact",
              key: "native.shell:extension:@workspace-extensions/shell",
            },
            tier: "gated",
            evidence: "bounded-dynamic",
          },
        ],
        provides: [],
      }).requests
    ).toEqual([
      expect.objectContaining({
        capability: "userland:extensions/shell/native.shell.execute#*",
      }),
    ]);
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
        provides: [],
      })
    ).toThrow(
      'vibestudio.authority.requests[0].tier must be "gated" or "critical"; RPC receiver tier "open" is not a manifest request tier'
    );
  });

  it("seals canonical receiver-owned capability definitions", () => {
    expect(
      parseUnitAuthorityManifest({
        requests: [],
        provides: [
          {
            name: "repository.publish",
            title: "Publish repository",
            action: "publish this repository",
            tier: "gated",
            sensitivity: "write",
            resourceType: "repository",
            presentation: { domain: "sharing", verb: "act" },
            grantScopes: ["version", "once"],
          },
        ],
      }).provides
    ).toEqual([
      expect.objectContaining({
        name: "repository.publish",
        grantScopes: ["once", "version"],
      }),
    ]);
  });

  it("rejects broad standing scopes for critical or destructive definitions", () => {
    expect(() =>
      parseUnitAuthorityManifest({
        requests: [],
        provides: [
          {
            name: "repository.delete",
            title: "Delete repository",
            action: "delete this repository",
            tier: "critical",
            sensitivity: "destructive",
            resourceType: "repository",
            presentation: { domain: "files", verb: "manage" },
            grantScopes: ["once", "session"],
          },
        ],
      })
    ).toThrow(/may offer only once/);
  });
});
