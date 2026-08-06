import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface AuthorityRequest {
  capability: string;
  resource: { kind: string; key?: string; prefix?: string };
  tier: string;
  evidence?: string;
}

describe("agent-worker authority manifest", () => {
  it("declares the complete phone onboarding workflow with exact resources", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("./package.json", import.meta.url), "utf8")
    ) as {
      vibestudio: { authority: { requests: AuthorityRequest[] } };
    };
    const requests = manifest.vibestudio.authority.requests;

    for (const capability of ["mobile.devices.read", "mobile.provision"]) {
      expect(requests).toContainEqual({
        capability,
        resource: { kind: "exact", key: capability },
        tier: "gated",
        evidence: "exact",
      });
    }
  });

  it("declares the internal workspace-state transport used by public panel helpers", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("./package.json", import.meta.url), "utf8")
    ) as {
      vibestudio: { authority: { requests: AuthorityRequest[] } };
    };
    expect(manifest.vibestudio.authority.requests).toContainEqual({
      capability: "workspace-service:workspace.state",
      resource: { kind: "prefix", prefix: "" },
      tier: "gated",
      evidence: "intentional-broad",
    });
  });
});
