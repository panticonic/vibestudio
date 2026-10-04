import { AUTHORITY_FAILURE_REASON_CODES, AUTHORITY_REMEDIATION_KINDS } from "@vibestudio/rpc";
import { describe, expect, it } from "vitest";
import { AUTHORITY_ACQUISITION_DECISIONS } from "@vibestudio/shared/approvalContract";
import { authorityMethods } from "./authority.js";

describe("authority service schema", () => {
  it("transports every canonical refusal and remediation without replacing its cause", () => {
    for (const reasonCode of AUTHORITY_FAILURE_REASON_CODES) {
      for (const kind of AUTHORITY_REMEDIATION_KINDS) {
        expect(
          authorityMethods.preflight.returns.parse({
            decision: "denied",
            leaves: [
              {
                capability: "permissions.read",
                resourceKey: "permissions.read",
                status: "denied",
                tier: "gated",
                failure: {
                  reasonCode,
                  reason: "Original refusal",
                  remediation: {
                    kind,
                    message: "Resolve the original cause",
                    review: { approvalId: "review:1", title: "Harness" },
                  },
                },
              },
            ],
          }).leaves[0]?.failure?.reasonCode
        ).toBe(reasonCode);
      }
    }
  });

  it("accepts every decision the acquisition coordinator can return", () => {
    for (const decision of AUTHORITY_ACQUISITION_DECISIONS) {
      expect(
        authorityMethods.awaitDecision.returns.safeParse({ state: "decided", decision }).success
      ).toBe(true);
    }
  });

  it("rejects queue-only terminal decisions", () => {
    for (const decision of ["dismiss", "block"]) {
      expect(
        authorityMethods.awaitDecision.returns.safeParse({ state: "decided", decision }).success
      ).toBe(false);
    }
  });
});
