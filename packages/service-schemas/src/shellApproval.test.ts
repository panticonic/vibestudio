import { describe, expect, it } from "vitest";
import { shellApprovalMethods } from "./shellApproval.js";

describe("shellApproval service contract", () => {
  it("accepts tree-formatted approval details exposed by host approvals", () => {
    expect(
      shellApprovalMethods.listPending.returns.parse([
        {
          approvalId: "approval-1",
          callerId: "system:templates",
          callerKind: "system",
          repoPath: "meta",
          effectiveVersion: "template:test",
          requestedAt: 0,
          kind: "userland",
          subject: { id: "template:test" },
          title: "Review template",
          details: [{ label: "Affected parts", value: "projects/example", format: "tree" }],
          promptOptions: "choices",
          options: [{ value: "allow", label: "Allow" }],
        },
      ])
    ).toHaveLength(1);
  });
});
