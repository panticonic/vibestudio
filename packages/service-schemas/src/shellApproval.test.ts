import { describe, expect, it } from "vitest";
import { shellApprovalMethods } from "./shellApproval.js";

describe("shellApproval service contract", () => {
  it("accepts tree-formatted approval details exposed by host approvals", () => {
    expect(
      shellApprovalMethods.listPending.returns.parse([
        {
          approvalId: "approval-1",
          callerId: "extension:shell",
          callerKind: "system",
          repoPath: "meta",
          effectiveVersion: "extension:test",
          requestedAt: 0,
          kind: "secret-input",
          title: "Enter protected input",
          details: [{ label: "Affected parts", value: "projects/example", format: "tree" }],
          fields: [{ name: "secret", label: "Secret", type: "secret", required: true }],
        },
      ])
    ).toHaveLength(1);
  });
});
