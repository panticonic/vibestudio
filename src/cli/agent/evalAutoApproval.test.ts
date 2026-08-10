import { describe, expect, it, vi } from "vitest";
import type { PendingApproval } from "@vibestudio/shared/approvals";
import {
  createInvocationSnapshot,
  invocationSnapshotDigest,
} from "@vibestudio/shared/authority/invocationSnapshot";
import { createEvalAutoApprover, parseEvalApprovalLevel } from "./evalAutoApproval.js";

function capabilityApproval(input: {
  approvalId?: string;
  callerId?: string;
  capability?: string;
  irreversible?: boolean;
  taskRef?: string;
  taskAuthority?: `task:${string}`;
  cardType?: "permission.gated" | "permission.outside" | "confirm.critical";
  initiatorChain?: string[];
}): Extract<PendingApproval, { kind: "capability" }> {
  const capability = input.capability ?? "runtime.inspect";
  return {
    approvalId: input.approvalId ?? "approval-1",
    callerId: input.callerId ?? "do:vibestudio/internal:EvalDO:eval-1",
    callerKind: "do",
    repoPath: "vibestudio/internal",
    effectiveVersion: "ev-1",
    requestedAt: 1,
    kind: "capability",
    capability,
    title: "Inspect runtimes",
    allowedDecisions: ["once", "deny"],
    ...(input.cardType ? { cardType: input.cardType } : {}),
    snapshot: createInvocationSnapshot({
      service: "workerdInspector",
      method: "getEndpoint",
      capability,
      capabilityDefinitionDigest: "definition-1",
      resourceType: "host",
      provider: "-",
      providerExecutionDigest: "-",
      resourceKey: "runtime.inspect",
      args: ["agent-worker"],
      preparedStateDigest: "prepared-1",
      callerPrincipal: "code:eval@ev-1",
      sessionId: "authority-session-1",
      reviewedClosureSubject: "-",
      snippetDigest: "snippet-1",
      codeLineage: { class: "internal", chain: [] },
      contextLineage: { class: "internal", latchEpoch: 1, externalKeys: [] },
      initiatorChain: input.initiatorChain ?? ["user:u1"],
      ...(input.taskRef ? { taskRef: input.taskRef } : {}),
      ...(input.taskAuthority ? { taskAuthority: input.taskAuthority } : {}),
      ...(input.irreversible ? { irreversible: true } : {}),
      at: 1,
    }),
  };
}

function requestFor(
  approval: Extract<PendingApproval, { kind: "capability" }>,
  tier: "gated" | "critical"
) {
  return {
    callerId: approval.callerId,
    snapshotDigest: invocationSnapshotDigest(approval.snapshot!),
    capability: approval.capability,
    tier,
    ...(approval.snapshot?.taskAuthority ? { taskAuthority: approval.snapshot.taskAuthority } : {}),
  };
}

describe("direct eval auto approval", () => {
  it("parses the explicit three-level policy", () => {
    expect(parseEvalApprovalLevel(undefined)).toBe(0);
    expect(parseEvalApprovalLevel("1")).toBe(1);
    expect(parseEvalApprovalLevel("2")).toBe(2);
    expect(() => parseEvalApprovalLevel("full")).toThrow(/0, 1, or 2/);
  });

  it("resolves an exact gated capability once at level 1", async () => {
    const approval = capabilityApproval({});
    const resolve = vi.fn(async () => undefined);
    const approver = createEvalAutoApprover({
      level: 1,
      runId: "run-1",
      callerId: "do:vibestudio/internal:EvalDO:eval-1",
      resolve,
      onError: vi.fn(),
    });

    approver.observePending([approval]);
    approver.observeAuthorityRequested(requestFor(approval, "gated"));

    await vi.waitFor(() => expect(resolve).toHaveBeenCalledWith("approval-1", "once"));
  });

  it("requires level 2 for critical capability cards", async () => {
    const approval = capabilityApproval({ irreversible: true });
    const levelOneResolve = vi.fn(async () => undefined);
    const levelTwoResolve = vi.fn(async () => undefined);
    const levelOne = createEvalAutoApprover({
      level: 1,
      runId: "run-1",
      callerId: "do:vibestudio/internal:EvalDO:eval-1",
      resolve: levelOneResolve,
      onError: vi.fn(),
    });
    const levelTwo = createEvalAutoApprover({
      level: 2,
      runId: "run-1",
      callerId: "do:vibestudio/internal:EvalDO:eval-1",
      resolve: levelTwoResolve,
      onError: vi.fn(),
    });

    levelOne.observeAuthorityRequested(requestFor(approval, "critical"));
    levelOne.observePending([approval]);
    levelTwo.observeAuthorityRequested(requestFor(approval, "critical"));
    levelTwo.observePending([approval]);

    await vi.waitFor(() => expect(levelTwoResolve).toHaveBeenCalledWith("approval-1", "once"));
    expect(levelOneResolve).not.toHaveBeenCalled();
  });

  it("does not resolve a card from another eval or a protected-input card", async () => {
    const approval = capabilityApproval({});
    const resolve = vi.fn(async () => undefined);
    const approver = createEvalAutoApprover({
      level: 2,
      runId: "run-1",
      callerId: "do:vibestudio/internal:EvalDO:eval-1",
      resolve,
      onError: vi.fn(),
    });
    approver.observeAuthorityRequested(requestFor(approval, "gated"));
    approver.observePending([
      { ...approval, callerId: "do:vibestudio/internal:EvalDO:other" },
      {
        approvalId: "secret-1",
        callerId: approval.callerId,
        callerKind: "do",
        repoPath: "vibestudio/internal",
        effectiveVersion: "ev-1",
        requestedAt: 1,
        kind: "secret-input",
        title: "Secret",
        fields: [],
      },
    ]);

    await Promise.resolve();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("resolves a coalesced card attested to the current eval run", async () => {
    const approval = capabilityApproval({
      taskRef: "eval:session:perf:run-1",
      cardType: "permission.gated",
    });
    const resolve = vi.fn(async () => undefined);
    const approver = createEvalAutoApprover({
      level: 1,
      runId: "run-1",
      callerId: "do:vibestudio/internal:EvalDO:eval-1",
      resolve,
      onError: vi.fn(),
    });

    approver.observePending([approval]);

    await vi.waitFor(() => expect(resolve).toHaveBeenCalledWith("approval-1", "once"));
  });

  it("resolves later cards attested to the current eval run", async () => {
    const first = capabilityApproval({
      approvalId: "approval-1",
      cardType: "permission.gated",
    });
    const second = capabilityApproval({
      approvalId: "approval-2",
      cardType: "permission.gated",
      capability: "workspace-service:channel",
      taskRef: "eval:session:perf:run-1",
    });
    const resolve = vi.fn(async () => undefined);
    const approver = createEvalAutoApprover({
      level: 1,
      runId: "run-1",
      callerId: "do:vibestudio/internal:EvalDO:eval-1",
      resolve,
      onError: vi.fn(),
    });

    approver.observeAuthorityRequested(requestFor(first, "gated"));
    approver.observePending([first]);
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledWith("approval-1", "once"));
    approver.observePending([second]);

    await vi.waitFor(() => expect(resolve).toHaveBeenCalledWith("approval-2", "once"));
  });

  it("resolves critical cards carrying the current eval task authority", async () => {
    const evalCallerId = "do:vibestudio/internal:EvalDO:eval-1";
    const evalApproval = capabilityApproval({
      taskAuthority: "task:eval-1",
      cardType: "permission.gated",
    });
    const descendantApproval = capabilityApproval({
      approvalId: "approval-2",
      callerId: "do:workers/pubsub-channel:channel-1",
      capability: "workspace-service:gad.workspace",
      cardType: "permission.outside",
      taskAuthority: "task:eval-1",
    });
    descendantApproval.allowedDecisions = ["task", "version", "deny"];
    const levelOneResolve = vi.fn(async () => undefined);
    const levelTwoResolve = vi.fn(async () => undefined);
    const levelOne = createEvalAutoApprover({
      level: 1,
      runId: "run-1",
      callerId: evalCallerId,
      resolve: levelOneResolve,
      onError: vi.fn(),
    });
    const levelTwo = createEvalAutoApprover({
      level: 2,
      runId: "run-1",
      callerId: evalCallerId,
      resolve: levelTwoResolve,
      onError: vi.fn(),
    });

    levelOne.observeAuthorityRequested(requestFor(evalApproval, "gated"));
    levelTwo.observeAuthorityRequested(requestFor(evalApproval, "gated"));
    levelOne.observePending([descendantApproval]);
    levelTwo.observePending([descendantApproval]);

    await vi.waitFor(() => expect(levelTwoResolve).toHaveBeenCalledWith("approval-2", "task"));
    expect(levelOneResolve).not.toHaveBeenCalledWith("approval-2", "task");
  });
});
