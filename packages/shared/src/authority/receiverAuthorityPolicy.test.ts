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
  });

  it.each([
    "external.open",
    "accounts.connect",
    "credential.use",
    "workspace.gateway.access",
    "git.publish",
    "workspace.publish",
    "panel.inspect",
  ])("offers reusable %s authority on the first explicit decision", (capability) => {
    expect(
      standingAgentScopeEligible({
        tier: "gated",
        policy: receiverAuthorityPolicy(capability),
      })
    ).toBe(true);
  });

  it("keeps TCP CONNECT outside standing agent scope like raw response egress", () => {
    expect(receiverAuthorityPolicy("network.connect")).toEqual(
      receiverAuthorityPolicy("network.response.read")
    );
  });

  it.each(["open", "critical"] as const)("does not offer standing scope for %s effects", (tier) => {
    expect(
      standingAgentScopeEligible({ tier, policy: receiverAuthorityPolicy("panel.inspect") })
    ).toBe(false);
  });

  it.each(["workspace.storage.delete", "workspace.members.remove", "network.connect"])(
    "keeps %s outside the standing-authority offer",
    (capability) => {
      expect(
        standingAgentScopeEligible({ tier: "gated", policy: receiverAuthorityPolicy(capability) })
      ).toBe(false);
    }
  );

  it("never offers standing authority for an irreversible effect even if the policy offers it", () => {
    expect(
      standingAgentScopeEligible({
        tier: "gated",
        policy: { ...receiverAuthorityPolicy("panel.inspect"), irreversible: true },
      })
    ).toBe(false);
  });
});
