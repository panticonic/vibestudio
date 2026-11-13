import { describe, expect, it } from "vitest";
import {
  assertCredentialApprovalDecision,
  credentialApprovalDeniedError,
  credentialApprovalDecisions,
} from "./credentialApprovalDecisions.js";

describe("credentialApprovalDecisions", () => {
  it("preserves explicit user denial as a structured terminal authority decision", () => {
    expect(credentialApprovalDeniedError("credential-1")).toMatchObject({
      message: "Credential approval denied",
      code: "EACCES",
      errorKind: "access",
      errorData: {
        denied: true,
        authorityFailure: {
          reasonCode: "user-denied",
          resourceKey: "credential:credential-1",
        },
      },
    });
  });

  it("offers the exact version for everyone, the default for agents too; an agent may also be trusted as this one agent", () => {
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
    ).toEqual(["once", "session", "agent", "deny"]); // the eval harness has no program version of its own
    expect(
      credentialApprovalDecisions({
        repoPath: "workers/agent-worker",
        effectiveVersion: "ev-agent",
        agentId: "agent:research",
      })
    ).toEqual(["once", "session", "agent", "version", "deny"]);
    expect(() =>
      assertCredentialApprovalDecision(
        { repoPath: "vibestudio/internal", effectiveVersion: "internal", agentId: "agent:x" },
        "version"
      )
    ).toThrow("cannot be represented");
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

  it("does not offer allow-once when connection approval also preapproves later use", () => {
    expect(
      credentialApprovalDecisions(
        {
          repoPath: "workers/agent-worker",
          effectiveVersion: "ev-agent",
          agentId: "agent:research",
        },
        { preapprovesUse: true }
      )
    ).toEqual(["session", "agent", "version", "deny"]);
  });
});
