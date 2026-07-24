import { describe, expect, it } from "vitest";
import {
  receiverAuthorityPolicy,
  standingAgentScopeEligible,
} from "./receiverAuthorityPolicy.js";

describe("standing agent-scope eligibility", () => {
  it("requires two exact interactive approvals for sharing, accounts, and network egress", () => {
    for (const capability of [
      "external.open",
      "accounts.connect",
      "workspace.gateway.access",
    ]) {
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
