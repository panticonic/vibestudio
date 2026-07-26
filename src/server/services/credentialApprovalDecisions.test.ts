import { describe, expect, it } from "vitest";
import {
  assertCredentialApprovalDecision,
  credentialApprovalDecisions,
} from "./credentialApprovalDecisions.js";

describe("credentialApprovalDecisions", () => {
  it("offers the exact installed version for code and the stable agent for agent-owned eval", () => {
    expect(
      credentialApprovalDecisions({
        repoPath: "extensions/github",
        effectiveVersion: "ev-github",
      })
    ).toEqual(["once", "session", "version", "deny"]);
    expect(
      credentialApprovalDecisions({
        repoPath: "vibestudio/internal",
        effectiveVersion: "internal",
        agentId: "agent:research",
      })
    ).toEqual(["once", "session", "agent", "deny"]);
  });

  it("keeps destructive credential uses one-shot and rejects unrepresentable scopes", () => {
    const identity = {
      repoPath: "extensions/github",
      effectiveVersion: "ev-github",
    };
    expect(credentialApprovalDecisions(identity, { onceOnly: true })).toEqual(["once", "deny"]);
    expect(() => assertCredentialApprovalDecision(identity, "task")).toThrow(
      "cannot be represented"
    );
    expect(() => assertCredentialApprovalDecision(identity, "version", { onceOnly: true })).toThrow(
      "cannot be represented"
    );
  });
});
