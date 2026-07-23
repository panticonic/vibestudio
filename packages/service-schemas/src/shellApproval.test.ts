import { describe, expect, it } from "vitest";

import { pendingUnitBatchApprovalSchema } from "./shellApproval.js";

describe("shellApproval wire schema", () => {
  it("round-trips reviewed unit authority metadata", () => {
    const parsed = pendingUnitBatchApprovalSchema.parse({
      approvalId: "approval-1",
      callerId: "system:workspace",
      callerKind: "system",
      repoPath: "workers/example",
      effectiveVersion: "ev-1",
      requestedAt: 1,
      kind: "unit-batch",
      trigger: "startup",
      title: "Review workspace code",
      description: "One unit needs approval.",
      units: [
        {
          unitKind: "worker",
          unitName: "@workspace-workers/example",
          displayName: "Example",
          source: { kind: "workspace-repo", repo: "workers/example", ref: "main" },
          capabilities: [],
          authority: {
            requests: [
              {
                capability: "workspace-service:example",
                resource: { kind: "exact", key: "service:example" },
                tier: "gated",
                evidence: "exact",
              },
            ],
            evalCeilings: [],
            groups: [],
            removedCount: 0,
            eval: [],
          },
        },
      ],
    });

    expect(parsed.units[0]?.authority?.requests[0]).toMatchObject({
      tier: "gated",
      evidence: "exact",
    });
  });
});
