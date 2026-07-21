import { describe, expect, it } from "vitest";

import {
  EXTENSION_RUNTIME_BASE_CAPABILITIES,
  parseUnitAuthorityManifest,
  withExtensionRuntimeAuthority,
} from "./authorityManifest.js";

describe("extension runtime authority", () => {
  it("seals runtime-owned lifecycle calls into an otherwise empty extension envelope", () => {
    const authority = withExtensionRuntimeAuthority(
      parseUnitAuthorityManifest({ requests: [], delegations: [] })
    );

    expect(authority.requests.map((request) => request.capability)).toEqual(
      EXTENSION_RUNTIME_BASE_CAPABILITIES
    );
    expect(authority.requests.every((request) => request.resource.kind === "prefix")).toBe(true);
  });

  it("preserves declared authority without duplicating an explicit lifecycle request", () => {
    const authority = withExtensionRuntimeAuthority(
      parseUnitAuthorityManifest({
        requests: [
          {
            capability: "service:extensions.ready",
            resource: { kind: "prefix", prefix: "" },
          },
          { capability: "service:fs.read", resource: { kind: "prefix", prefix: "projects/" } },
        ],
        delegations: [],
      })
    );

    expect(
      authority.requests.filter((request) => request.capability === "service:extensions.ready")
    ).toHaveLength(1);
    expect(authority.requests.map((request) => request.capability)).toEqual([
      "service:extensions.health",
      "service:extensions.ready",
      "service:fs.read",
    ]);
  });
});
