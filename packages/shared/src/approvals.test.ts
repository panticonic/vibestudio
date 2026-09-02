import { describe, expect, it } from "vitest";
import { operationSubstanceForAuthority } from "./approvals.js";

describe("operationSubstanceForAuthority", () => {
  it("keeps provider meaning without adding enforcement prose to the user summary", () => {
    expect(
      operationSubstanceForAuthority({
        provided: {
          kind: "custom",
          summary: "Import the archived cards",
          detail: "Replaces the retained board snapshot.",
          facts: [{ label: "Cards", value: "12" }],
        },
        fallbackAction: "manage Task Board",
        fallbackTarget: "Task Board",
        digest: "prepared-digest",
      })
    ).toEqual({
      kind: "custom",
      summary: "Import the archived cards",
      detail: "Replaces the retained board snapshot.",
      facts: [{ label: "Cards", value: "12" }],
      digest: "prepared-digest",
    });
  });

  it("does not repeat a target already named by the action", () => {
    expect(
      operationSubstanceForAuthority({
        fallbackAction: "change persistent browser data",
        fallbackTarget: "Browser data",
        digest: "prepared-digest",
      })
    ).toEqual({
      kind: "custom",
      summary: "Change persistent browser data",
      digest: "prepared-digest",
    });
  });
});
