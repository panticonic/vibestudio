import { describe, expect, it } from "vitest";
import { authorityRow } from "@vibestudio/shared/authority/authorityRows";
import { AUTHORITY_PROMPT_CARD_TYPES } from "@vibestudio/shared/authority/promptRegistry";
import { createInvocationSnapshot } from "@vibestudio/shared/authority/invocationSnapshot";
import { shellApprovalMethods, templateInstallResolutionSchema } from "./shellApproval.js";

describe("shellApproval service contract", () => {
  it("preserves website identity and document-bound consent across the approval wire", () => {
    const binding = { subject: "website:site-1" as const, generation: 2, documentId: "doc-1" };
    const approval = {
      approvalId: "approval-website",
      callerId: "browser:doc-1",
      callerKind: "panel" as const,
      repoPath: "",
      effectiveVersion: "",
      requestedAt: 1,
      kind: "capability" as const,
      capability: "credential.use",
      title: "Use account",
      allowedDecisions: ["once", "session", "always", "deny"],
      authoritySubject: {
        principal: binding.subject,
        website: {
          origin: "https://example.com",
          workspaceId: "project",
          documentId: binding.documentId,
        },
      },
      snapshot: createInvocationSnapshot({
        service: "credentials",
        method: "fetch",
        capability: "credential.use",
        capabilityDefinitionDigest: "-",
        resourceType: "account",
        provider: "-",
        providerExecutionDigest: "-",
        resourceKey: "account:1",
        args: [],
        preparedStateDigest: "-",
        callerPrincipal: binding.subject,
        subjectBinding: binding,
        initiatingWebsite: {
          subject: binding.subject,
          userId: "user:viewer",
          workspaceId: "project",
          origin: "https://example.com",
          connected: true,
          binding,
        },
        sessionId: "session:doc-1",
        missionSubject: "-",
        snippetDigest: "-",
        codeLineage: { class: "unknown", chain: [] },
        contextLineage: { class: "external", latchEpoch: 1, externalKeys: ["https://example.com"] },
        initiatorChain: [binding.subject],
        at: 1,
      }),
    };
    expect(shellApprovalMethods.listPending.returns.parse([approval])).toEqual([approval]);
    expect(
      shellApprovalMethods.listPending.returns.safeParse([
        {
          ...approval,
          snapshot: { ...approval.snapshot, subjectBinding: { ...binding, generation: -1 } },
        },
      ]).success
    ).toBe(false);
  });

  it("carries popup permission approvals across listPending", () => {
    const approval = {
      approvalId: "approval-popup",
      callerId: "panel:browser",
      callerKind: "panel" as const,
      repoPath: "panels/browser",
      effectiveVersion: "browser:test",
      requestedAt: 0,
      kind: "browser-permission" as const,
      ownerUserId: "user-1",
      workspaceId: "workspace-1",
      environmentKey: "browser-default",
      panelId: "panel:browser",
      origin: "https://claude.ai",
      topLevelUrl: "https://claude.ai/login",
      capabilities: ["popups" as const],
      deviceLabel: "Desktop",
    };

    expect(shellApprovalMethods.listPending.returns.parse([approval])).toEqual([approval]);
  });

  it("carries the server execution platform on pending capability approvals", () => {
    const approval = {
      approvalId: "approval-platform",
      callerId: "do:worker:one",
      callerKind: "do" as const,
      repoPath: "workers/one",
      effectiveVersion: "ev-one",
      requestedAt: 0,
      executionPlatform: "macos" as const,
      kind: "capability" as const,
      capability: "runtime.code-execution.manage",
      title: "Run code",
    };

    expect(shellApprovalMethods.listPending.returns.parse([approval])).toEqual([approval]);
    expect(
      shellApprovalMethods.listPending.returns.safeParse([
        { ...approval, executionPlatform: "aix" },
      ]).success
    ).toBe(false);
  });

  it("carries every registered authority prompt card across listPending", () => {
    const approvals = AUTHORITY_PROMPT_CARD_TYPES.map((cardType, index) => ({
      approvalId: `approval-${index}`,
      callerId: "extension:template-composer",
      callerKind: "extension" as const,
      repoPath: "extensions/template-composer",
      effectiveVersion: "extension:test",
      requestedAt: index,
      kind: "capability" as const,
      capability: `template-operation-${index}`,
      title: `Template operation ${index}`,
      cardType,
    }));

    expect(shellApprovalMethods.listPending.returns.parse(approvals)).toEqual(approvals);
  });

  it("carries a host-resolved panel target across listPending", () => {
    const inspection = authorityRow({
      capability: "panel.inspect",
      resource: { kind: "exact", key: "panel.inspect" },
      tier: "gated",
      statement: "prospective",
      provenance: { source: "receiver" },
    });
    const approval = {
      approvalId: "approval-cdp",
      callerId: "do:workers/agent:AgentDO:session",
      callerKind: "do" as const,
      repoPath: "workers/agent",
      effectiveVersion: "ev-agent",
      requestedAt: 0,
      kind: "capability" as const,
      capability: "panel.inspect",
      title: "Inspect a panel",
      authorityRow: inspection,
      authorityFacets: [
        {
          selectionKey: "panel.inspect:flowboard",
          capability: "panel.inspect",
          title: "Inspect a panel with developer tools",
          resource: { type: "panel", label: "Panel", value: "Rich Flowboard Store" },
          row: inspection,
        },
      ],
      target: {
        id: "panel:flowboard",
        kind: "panel" as const,
        title: "Rich Flowboard Store",
        sourcePath: "panels/flowboard",
        entityId: "panel:nav-flowboard",
      },
    };

    expect(shellApprovalMethods.listPending.returns.parse([approval])).toEqual([approval]);
  });

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
                binding: {
                  protocol: "example.notes.v1",
                  availability: "required",
                  serviceName: "notes",
                  providerUnit: "@workspace-workers/notes",
                  catalogDigest: "catalog:v1",
                },
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
    const review = parsed[0];
    // `listPending` returns the union of every approval kind; only the install
    // review carries parts, so narrow before reading them.
    expect(review?.kind).toBe("unit-install-review");
    if (review?.kind !== "unit-install-review") throw new Error("expected an install review");
    expect(review.parts[0]?.notableRows[0]).toMatchObject({
      binding: { protocol: "example.notes.v1", serviceName: "notes" },
    });
  });
});
