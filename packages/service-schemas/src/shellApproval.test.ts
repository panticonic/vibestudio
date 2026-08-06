import { describe, expect, it } from "vitest";
import { authorityRow } from "@vibestudio/shared/authority/authorityRows";
import { shellApprovalMethods, templateInstallResolutionSchema } from "./shellApproval.js";

describe("shellApproval service contract", () => {
  it("exposes semantic workspace creation-review preparation states", () => {
    expect(
      shellApprovalMethods.getWorkspaceCreationReviewState.returns.parse({
        status: "pending",
        approvalId: "approval:creation",
        partCount: 3,
      })
    ).toEqual({
      status: "pending",
      approvalId: "approval:creation",
      partCount: 3,
    });
    expect(
      shellApprovalMethods.getWorkspaceCreationReviewState.returns.safeParse({
        status: "pending",
      }).success
    ).toBe(false);
  });

  it("rejects duplicate install-review part identities at the wire boundary", () => {
    expect(
      templateInstallResolutionSchema.safeParse({
        decision: "install",
        allowNow: [{ identityKey: "panels/news@ev-1" }, { identityKey: "panels/news@ev-1" }],
      }).success
    ).toBe(false);
  });

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

  // A workspace with any capability outside the reviewed registry produces a
  // degraded row, and a schema that rejects it fails the whole listPending call
  // — which takes the shell's entire approval surface down with it.
  it("carries a degraded row for an unreviewed capability across the wire", () => {
    const row = authorityRow({
      capability: "nobody.reviewed.this",
      resource: { kind: "prefix", prefix: "" },
      tier: "gated",
      statement: "declared",
      provenance: { source: "manifest" },
      degradeUnknown: true,
    });
    expect(row.unrecognized).toBe(true);

    const parsed = shellApprovalMethods.listPending.returns.parse([
      {
        approvalId: "approval-1",
        callerId: "extension:shell",
        callerKind: "system",
        repoPath: "meta",
        effectiveVersion: "extension:test",
        requestedAt: 0,
        kind: "unit-install-review",
        mode: "install",
        title: "Add template",
        description: "Adds one part",
        parts: [
          {
            identityKey: "panels/example@v1",
            kind: "panel",
            label: "Panel",
            surfaces: [],
            name: "example",
            title: "Example",
            purpose: "An example panel",
            repoPath: "panels/example",
            effectiveVersion: "v1",
            version: null,
            requiredUnitKeys: [],
            runsInBackground: false,
            origin: {
              url: null,
              originKey: "host",
              registrableDomain: null,
              version: null,
              isHostBuild: true,
              isWorkspaceRoot: true,
              firstEncounter: false,
            },
            notableRows: [
              {
                kind: "permission",
                key: "k1",
                timing: "asks-when-needed",
                notability: "headline",
                selectable: false,
                selectedByDefault: false,
                row,
              },
            ],
            everydayRows: [],
            change: "added",
            section: "template",
          },
        ],
        summary: { panels: 1, agents: 0, services: 0, clientApps: 0, extensions: 0 },
        unchangedPartCount: 0,
      },
    ]);
    expect(parsed).toHaveLength(1);
  });
});
