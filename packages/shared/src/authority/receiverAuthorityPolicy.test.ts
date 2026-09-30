import { describe, expect, it } from "vitest";
import { receiverAuthorityPolicy, standingAgentScopeEligible } from "./receiverAuthorityPolicy.js";

describe("standing agent-scope eligibility", () => {
  it("reviews internal workspace publication as a change set in the files domain", () => {
    expect(receiverAuthorityPolicy("workspace.publish")).toMatchObject({
      agentScope: "offer",
      irreversible: false,
      requiresSubstance: true,
      substanceKind: "change-set",
    });
    expect(
      standingAgentScopeEligible({
        capability: "workspace.publish",
        tier: "gated",
        policy: receiverAuthorityPolicy("workspace.publish"),
        priorInteractiveApprovals: 0,
      })
    ).toBe(true);
    expect(
      standingAgentScopeEligible({
        capability: "git.publish",
        tier: "gated",
        policy: receiverAuthorityPolicy("git.publish"),
        priorInteractiveApprovals: 0,
      })
    ).toBe(false);
  });
  it("requires two exact interactive approvals for sharing, accounts, and network egress", () => {
    for (const capability of ["external.open", "accounts.connect", "workspace.gateway.access"]) {
      const policy = receiverAuthorityPolicy(capability);
      expect(
        standingAgentScopeEligible({
          capability,
          tier: "gated",
          policy,
          priorInteractiveApprovals: 1,
        })
      ).toBe(false);
      expect(
        standingAgentScopeEligible({
          capability,
          tier: "gated",
          policy,
          priorInteractiveApprovals: 2,
        })
      ).toBe(true);
    }
  });

  it("keeps TCP CONNECT outside standing agent scope like raw response egress", () => {
    expect(receiverAuthorityPolicy("network.connect")).toEqual(
      receiverAuthorityPolicy("network.response.read")
    );
  });

  it("offers ordinary reversible gated authority immediately", () => {
    const capability = "panel.inspect";
    expect(
      standingAgentScopeEligible({
        capability,
        tier: "gated",
        policy: receiverAuthorityPolicy(capability),
        priorInteractiveApprovals: 0,
      })
    ).toBe(true);
  });
});
