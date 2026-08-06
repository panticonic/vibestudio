import { describe, expect, it } from "vitest";
import { AUTHORITY_ACQUISITION_DECISIONS } from "@vibestudio/shared/approvalContract";
import { authorityMethods } from "./authority.js";

describe("authority service schema", () => {
  it("accepts every decision the acquisition coordinator can return", () => {
    for (const decision of AUTHORITY_ACQUISITION_DECISIONS) {
      expect(
        authorityMethods.awaitDecision.returns.safeParse({ state: "decided", decision }).success
      ).toBe(true);
    }
  });

  it("rejects queue-only terminal decisions", () => {
    for (const decision of ["dismiss", "always", "block"]) {
      expect(
        authorityMethods.awaitDecision.returns.safeParse({ state: "decided", decision }).success
      ).toBe(false);
    }
  });
});
