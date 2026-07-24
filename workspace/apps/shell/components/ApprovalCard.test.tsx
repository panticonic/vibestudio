// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { describe, expect, it, vi } from "vitest";
import type {
  PendingCapabilityApproval,
  PendingClientConfigApproval,
  PendingUnitBatchApproval,
  PendingUserlandApproval,
} from "@vibestudio/shared/approvals";
import { authorityRow } from "@vibestudio/shared/authority/authorityRows";
import { ApprovalCard } from "./ApprovalCard";
import { resolveCallerInfo, type ApprovalCardIntent } from "./approvalCardModel";
import { ApprovalCardSurface } from "../overlay/ApprovalCardSurface";

function userlandApproval(
  partial: Partial<PendingUserlandApproval> & { approvalId: string; title: string }
): PendingUserlandApproval {
  return {
    kind: "userland",
    callerId: partial.callerId ?? `panel:${partial.approvalId}`,
    callerKind: partial.callerKind ?? "panel",
    repoPath: partial.repoPath ?? "panels/test",
    effectiveVersion: partial.effectiveVersion ?? "ev",
    requestedAt: partial.requestedAt ?? Date.now(),
    callerTitle: partial.callerTitle,
    subject: partial.subject ?? { id: "sub-1", label: "Subject" },
    title: partial.title,
    summary: partial.summary,
    promptOptions: partial.promptOptions ?? "choices",
    options: partial.options ?? [{ value: "ok", label: "OK", tone: "primary" }],
    approvalId: partial.approvalId,
  };
}

function capabilityApproval(
  partial: Partial<PendingCapabilityApproval> & { approvalId: string; title: string }
): PendingCapabilityApproval {
  return {
    kind: "capability",
    callerId: partial.callerId ?? `panel:${partial.approvalId}`,
    callerKind: partial.callerKind ?? "panel",
    repoPath: partial.repoPath ?? "panels/test",
    effectiveVersion: partial.effectiveVersion ?? "ev",
    requestedAt: partial.requestedAt ?? Date.now(),
    capability: partial.capability ?? "context.boundary",
    severity: partial.severity,
    title: partial.title,
    description: partial.description,
    resource: partial.resource ?? { type: "panel", label: "Panel", value: "Shell" },
    grantResourceKey: partial.grantResourceKey,
    details: partial.details,
    operation: partial.operation,
    snapshot: partial.snapshot,
    cardType: partial.cardType,
    allowedDecisions: partial.allowedDecisions,
    authorityRow: partial.authorityRow,
    operationSubstance: partial.operationSubstance,
    approvalId: partial.approvalId,
  };
}

function unitBatchApproval(
  partial: Partial<PendingUnitBatchApproval> & { approvalId: string }
): PendingUnitBatchApproval {
  return {
    kind: "unit-batch",
    trigger: partial.trigger ?? "source-change",
    callerId: partial.callerId ?? "system:units",
    callerKind: partial.callerKind ?? "system",
    repoPath: partial.repoPath ?? "meta",
    effectiveVersion: partial.effectiveVersion ?? "ev",
    requestedAt: partial.requestedAt ?? Date.now(),
    title: partial.title ?? "Approve workspace extensions",
    description: partial.description ?? "This workspace declares extensions.",
    approvalId: partial.approvalId,
    units:
      partial.units ??
      Array.from({ length: 2 }, (_, index) => ({
        unitKind: "extension" as const,
        unitName: `@workspace-extensions/ext-${index + 1}`,
        displayName: `Extension ${index + 1}`,
        version: "0.1.0",
        source: {
          kind: "workspace-repo" as const,
          repo: `extensions/ext-${index + 1}`,
          ref: "main",
        },
        ev: `ev-${index + 1}`,
        capabilities: ["node:fs", "node:process"],
      })),
  };
}

function clientConfigApproval(
  partial: Partial<PendingClientConfigApproval> & { approvalId: string; configId: string }
): PendingClientConfigApproval {
  return {
    kind: "client-config",
    callerId: partial.callerId ?? `panel:${partial.approvalId}`,
    callerKind: partial.callerKind ?? "panel",
    repoPath: partial.repoPath ?? "panels/test",
    effectiveVersion: partial.effectiveVersion ?? "ev",
    requestedAt: partial.requestedAt ?? Date.now(),
    approvalId: partial.approvalId,
    configId: partial.configId,
    authorizeUrl: partial.authorizeUrl ?? "https://accounts.example.test/oauth/authorize",
    tokenUrl: partial.tokenUrl ?? "https://accounts.example.test/oauth/token",
    title: partial.title ?? partial.configId,
    description: partial.description,
    fields: partial.fields ?? [
      { name: "clientSecret", label: "Client Secret", type: "secret", required: true },
    ],
  };
}

function renderCard(
  approval: Parameters<typeof resolveCallerInfo>[0],
  opts: { queue?: Parameters<typeof ApprovalCard>[0]["queue"]; decisionError?: string | null } = {}
) {
  const emit = vi.fn<(intent: ApprovalCardIntent) => void>();
  render(
    <Theme>
      <ApprovalCard
        approval={approval}
        caller={resolveCallerInfo(approval)}
        queue={opts.queue ?? null}
        decisionError={opts.decisionError ?? null}
        emit={emit}
      />
    </Theme>
  );
  return { emit };
}

describe("ApprovalCard", () => {
  it("exposes a labelled, described dialog and assertive decision errors with long copy", () => {
    const title =
      "Autoriser la publication de cette très longue synthèse dans l’espace de travail partagé";
    const description =
      "Cette action partage le compte rendu complet avec toutes les personnes actuellement présentes.";
    renderCard(
      capabilityApproval({
        approvalId: "localized-long-copy",
        title,
        description,
      }),
      { decisionError: "La décision n’a pas pu être enregistrée." }
    );

    const dialog = screen.getByRole("dialog", { name: title });
    expect(dialog.getAttribute("aria-describedby")).toBe("approval-summary-localized-long-copy");
    expect(screen.getByText(description)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "La décision n’a pas pu être enregistrée."
    );
  });

  it("renders a severe capability with a danger tone and emits a version decision", () => {
    const { emit } = renderCard(
      capabilityApproval({
        approvalId: "cap-severe",
        title: "Act on Shell's context",
        severity: "severe",
      })
    );
    const card = screen
      .getByText("Act on Shell's context")
      .closest(".approval-card") as HTMLElement;
    expect(card.getAttribute("data-approval-tone")).toBe("red");

    const trustButton = screen.getByText("Trust this version").closest("button");
    expect(trustButton?.getAttribute("data-accent-color")).toBe("red");
    expect(
      screen.getByText("Allow once").closest("button")?.getAttribute("data-accent-color")
    ).toBe("");
    fireEvent.click(trustButton as HTMLButtonElement);
    expect(emit).toHaveBeenCalledWith({
      type: "decide",
      decision: "version",
      approvalId: "cap-severe",
    });
  });

  it("shows the exact prepared effect and the eligible task and agent scope ladder", () => {
    const row = authorityRow({
      capability: "push.send",
      resource: { kind: "exact", key: "channel:briefings" },
      resourcePhrase: "Briefings",
      tier: "gated",
      statement: "prospective",
      provenance: { source: "receiver" },
    });
    const { emit } = renderCard(
      capabilityApproval({
        approvalId: "cap-substance",
        title: "Send the nightly briefing",
        callerTitle: "News",
        snapshot: {
          v: 1,
          service: "push",
          method: "send",
          capability: "push.send",
          resourceKey: "channel:briefings",
          argsDigest: "args:briefing-1",
          preparedStateDigest: "prepared:briefing-1",
          callerPrincipal: "code:news",
          sessionId: "session:news",
          taskRef: "task:nightly-briefing",
          agentBindingId: "binding:news",
          agentName: "News",
          agentScopeEligible: true,
          mission: "-",
          snippetDigest: "snippet:news",
          codeLineage: { class: "internal", chain: ["code:news"] },
          contextLineage: null,
          initiatorChain: ["user:alice"],
          at: 1,
        },
        authorityRow: row,
        allowedDecisions: ["once", "task", "agent", "deny", "lock"],
        operationSubstance: {
          kind: "send",
          summary: "Send 1 briefing to Briefings",
          detail: "Subject: Overnight workspace summary",
          digest: "prepared:briefing-1",
        },
      })
    );

    expect(screen.getByText("Publishing & sending")).toBeTruthy();
    expect(screen.getByText("What exactly")).toBeTruthy();
    expect(screen.getByText("Send 1 briefing to Briefings")).toBeTruthy();
    expect(screen.getByText("Subject: Overnight workspace summary")).toBeTruthy();
    fireEvent.click(screen.getByText("Allow for this task"));
    expect(emit).toHaveBeenCalledWith({
      type: "decide",
      decision: "task",
      approvalId: "cap-substance",
    });
    expect(screen.getByText("Always for News")).toBeTruthy();
  });

  it("recommends the durable version grant and uses it for keyboard confirmation", () => {
    const credential = {
      ...capabilityApproval({ approvalId: "credential", title: "Use model credential" }),
      kind: "credential" as const,
      credentialId: "openai-codex",
      credentialLabel: "ChatGPT Codex model credential",
      audience: [{ match: "path-prefix" as const, url: "https://chatgpt.com/backend-api" }],
      injection: {
        type: "header" as const,
        name: "Authorization",
        valueTemplate: "Bearer {{token}}",
      },
      accountIdentity: { providerUserId: "account" },
      scopes: [],
      credentialUse: "fetch" as const,
    };
    const { emit } = renderCard(credential);

    expect(
      screen.getByText("Trust this version").closest("button")?.getAttribute("data-accent-color")
    ).toBe("sky");
    expect(screen.getByText("Use once").closest("button")?.getAttribute("data-accent-color")).toBe(
      ""
    );

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    expect(emit).toHaveBeenCalledWith({
      type: "decide",
      decision: "version",
      approvalId: "credential",
    });
  });

  it("shows the queue navigator and emits browse intents", () => {
    const { emit } = renderCard(userlandApproval({ approvalId: "a1", title: "First approval" }), {
      queue: { index: 0, total: 3, canPrev: false, canNext: true },
    });
    expect(screen.getByText("1 / 3")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Next approval"));
    expect(emit).toHaveBeenCalledWith({ type: "browse", dir: "next", approvalId: "a1" });
  });

  it("omits the navigator for a single approval", () => {
    renderCard(userlandApproval({ approvalId: "solo", title: "Lonely approval" }), { queue: null });
    expect(screen.queryByLabelText("Next approval")).toBeNull();
  });

  it("surfaces a decision error", () => {
    renderCard(userlandApproval({ approvalId: "err", title: "Boom" }), {
      decisionError: "resolve blocked",
    });
    expect(screen.getByText("Approval action failed: resolve blocked")).toBeTruthy();
  });

  it("emits decide intents for a unit-batch and keeps its entries collapsed", () => {
    const { emit } = renderCard(
      unitBatchApproval({ approvalId: "extensions", title: "Approve workspace extensions" })
    );
    const firstUnit = screen
      .getByText("Extension 1 · v0.1.0")
      .closest("details") as HTMLDetailsElement;
    expect(firstUnit.open).toBe(false);

    fireEvent.click(screen.getByText("Approve update"));
    expect(emit).toHaveBeenCalledWith({
      type: "decide",
      decision: "once",
      approvalId: "extensions",
    });
    fireEvent.click(screen.getByText("Deny"));
    expect(emit).toHaveBeenCalledWith({
      type: "decide",
      decision: "deny",
      approvalId: "extensions",
    });
  });

  it("puts added permissions on the unit summary and hides unchanged permissions", () => {
    const approval = unitBatchApproval({ approvalId: "permission-diff" });
    const notificationsRow = authorityRow({
      capability: "push.send",
      resource: { kind: "prefix", prefix: "" },
      tier: "gated",
      statement: "declared",
      provenance: { source: "manifest" },
    });
    const profileRow = authorityRow({
      capability: "account.profile.read",
      resource: { kind: "prefix", prefix: "" },
      tier: "gated",
      statement: "declared",
      provenance: { source: "manifest" },
    });
    approval.units[0]!.authority = {
      requests: [
        {
          capability: "push.send",
          resource: { kind: "prefix", prefix: "" },
          tier: "gated",
          evidence: "intentional-broad",
        },
        {
          capability: "account.profile.read",
          resource: { kind: "prefix", prefix: "" },
          tier: "gated",
          evidence: "intentional-broad",
        },
      ],
      rows: [notificationsRow, profileRow],
      diff: {
        added: [{ ...notificationsRow, flags: { newInDiff: true } }],
        removed: [],
        unchanged: [profileRow],
        retiered: [],
      },
    };

    renderCard(approval);
    expect(screen.getByText("+ Publishing & sending")).toBeTruthy();
    const unchangedItem = screen.getByText(/view your account profile/);
    const unchangedDetails = unchangedItem.closest("details") as HTMLDetailsElement;
    expect(unchangedDetails.open).toBe(false);

    fireEvent.click(screen.getByText("Extension 1 · v0.1.0"));
    expect(screen.getByText(/^\+ send notifications/)).toBeTruthy();
    expect(unchangedDetails.open).toBe(false);
    fireEvent.click(screen.getByText("Unchanged permissions"));
    expect(unchangedDetails.open).toBe(true);
  });

  it("emits a minimize intent from the header control", () => {
    const { emit } = renderCard(userlandApproval({ approvalId: "m", title: "Minimizable" }));
    fireEvent.click(screen.getByLabelText("Minimize approval"));
    expect(emit).toHaveBeenCalledWith({ type: "minimize", approvalId: "m" });
  });

  it("remounts the overlay card when the approval changes so secret inputs reset", () => {
    const first = clientConfigApproval({ approvalId: "setup-a", configId: "service-a" });
    const second = clientConfigApproval({ approvalId: "setup-b", configId: "service-b" });
    const emitIntent = vi.fn<(intent: unknown) => void>();
    const { rerender } = render(
      <Theme>
        <ApprovalCardSurface
          props={{ approval: first, queue: null, decisionError: null }}
          emitIntent={emitIntent}
        />
      </Theme>
    );

    const firstInput = screen.getByPlaceholderText("Client Secret") as HTMLInputElement;
    fireEvent.change(firstInput, { target: { value: "first-secret" } });
    expect(firstInput.value).toBe("first-secret");

    rerender(
      <Theme>
        <ApprovalCardSurface
          props={{ approval: second, queue: null, decisionError: null }}
          emitIntent={emitIntent}
        />
      </Theme>
    );

    expect((screen.getByPlaceholderText("Client Secret") as HTMLInputElement).value).toBe("");
  });
});
