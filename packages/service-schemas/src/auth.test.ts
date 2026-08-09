import { describe, expect, it } from "vitest";
import { authMethods } from "./auth.js";

describe("auth service authority", () => {
  it("authorizes agent login issuance as the reviewed subagent launch", () => {
    expect(authMethods.mintAgentCredential).toMatchObject({
      capability: "subagents.create",
      tier: { tier: "gated", session: "codeOnly" },
      authority: { principals: ["code", "host"] },
    });
  });

  it("keeps exact credential retirement as non-prompting lifecycle cleanup", () => {
    expect(authMethods.revokeAgentCredential).toMatchObject({
      tier: { tier: "open", session: "family" },
      authority: { principals: ["code", "host"] },
    });
    expect(authMethods.revokeAgentCredential).not.toHaveProperty("capability");
    expect(authMethods.revokeAgentCredential).not.toHaveProperty("presentation");
  });
});
