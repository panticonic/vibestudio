import { describe, expect, it } from "vitest";
import { capabilityClearancePolicy, isInstallClearable } from "./capabilityClearance.js";

const workspace = { kind: "exact", key: "workspace" } as const;

describe("capability clearance", () => {
  it("clears an ordinary reviewed gated request at install", () => {
    expect(
      isInstallClearable({
        capability: "workspace.files.read",
        resource: { kind: "prefix", prefix: "" },
        tier: "gated",
        reviewed: true,
      })
    ).toBe(true);
  });

  it("keeps accounts and sign-ins contextual, so the prompt names the account", () => {
    const policy = capabilityClearancePolicy({
      capability: "credential.use",
      resource: workspace,
      tier: "gated",
      reviewed: true,
    });
    expect(policy).toEqual({
      clearance: "contextual",
      reusableScopes: ["task"],
      presentation: "concrete-use",
    });
  });

  it("keeps device access contextual", () => {
    for (const capability of ["clipboard", "devices.pair", "incoming-pair-links"]) {
      expect(
        isInstallClearable({ capability, resource: workspace, tier: "gated", reviewed: true })
      ).toBe(false);
    }
  });

  it("separates a declared origin from reaching any site at all", () => {
    expect(
      isInstallClearable({
        capability: "network.response.read",
        resource: { kind: "domain", domain: "news.example" },
        tier: "gated",
        reviewed: true,
      })
    ).toBe(true);
    expect(
      isInstallClearable({
        capability: "network.response.read",
        resource: { kind: "network", value: "*" },
        tier: "gated",
        reviewed: true,
      })
    ).toBe(false);
  });

  it("never lets a critical request hold a standing decision", () => {
    expect(
      capabilityClearancePolicy({
        capability: "workspace.files.write",
        resource: workspace,
        tier: "critical",
        reviewed: true,
      })
    ).toEqual({ clearance: "contextual", reusableScopes: [], presentation: "concrete-use" });
  });

  it("defaults an unreviewed capability to contextual", () => {
    expect(
      isInstallClearable({
        capability: "workspace-service:news.somethingNew",
        resource: workspace,
        tier: "gated",
        reviewed: false,
      })
    ).toBe(false);
  });

  it("treats a receiver's declared scopes as a ceiling, never a floor", () => {
    expect(
      capabilityClearancePolicy({
        capability: "workspace-service:news.readFeed",
        resource: workspace,
        tier: "gated",
        reviewed: true,
        declaredReusableScopes: ["task"],
      }).reusableScopes
    ).toEqual(["task"]);
  });

  it("keeps a receiver task-only capability contextual at install", () => {
    expect(
      capabilityClearancePolicy({
        capability: "workspace-service:news.readFeed",
        resource: workspace,
        tier: "gated",
        reviewed: true,
        declaredReusableScopes: ["task"],
      }).clearance
    ).toBe("contextual");
  });
});
