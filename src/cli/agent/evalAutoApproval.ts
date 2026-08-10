import type { PendingApproval } from "@vibestudio/shared/approvals";
import { invocationSnapshotDigest } from "@vibestudio/shared/authority/invocationSnapshot";
import { UsageError } from "../output.js";

export type EvalApprovalLevel = 0 | 1 | 2;

interface EvalAuthorityRequest {
  callerId: string;
  snapshotDigest: string;
  capability: string;
  tier: "gated" | "critical";
  taskAuthority?: string;
}

export interface EvalAutoApprover {
  observeAuthorityRequested(payload: unknown): void;
  observeAuthorityDecided(payload: unknown): void;
  observePending(pending: readonly PendingApproval[]): void;
}

type EvalApprovalDecision = "once" | "task";

export function parseEvalApprovalLevel(raw: unknown): EvalApprovalLevel {
  if (raw === undefined) return 0;
  if (raw === "0" || raw === "1" || raw === "2") return Number(raw) as EvalApprovalLevel;
  throw new UsageError("--approval-level must be 0, 1, or 2");
}

function authorityRequest(payload: unknown): EvalAuthorityRequest | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  if (
    typeof value["callerId"] !== "string" ||
    typeof value["snapshotDigest"] !== "string" ||
    typeof value["capability"] !== "string" ||
    (value["tier"] !== "gated" && value["tier"] !== "critical")
  ) {
    return null;
  }
  return {
    callerId: value["callerId"],
    snapshotDigest: value["snapshotDigest"],
    capability: value["capability"],
    tier: value["tier"],
    ...(typeof value["taskAuthority"] === "string"
      ? { taskAuthority: value["taskAuthority"] }
      : {}),
  };
}

function snapshotDigest(approval: PendingApproval): string | null {
  if (approval.kind !== "capability" || !approval.snapshot) return null;
  return invocationSnapshotDigest(approval.snapshot);
}

function admits(level: EvalApprovalLevel, tier: EvalAuthorityRequest["tier"]): boolean {
  return tier === "gated" ? level >= 1 : level >= 2;
}

/**
 * Invocation-local approval presenter for direct CLI eval.
 *
 * It resolves only ordinary capability cards whose host-attested caller and
 * immutable invocation snapshot match an authority-requested event from this
 * exact eval run. Credential/protected-input/review cards never match. Every
 * accepted request is an audited `once` decision for the EvalDO itself, or an
 * audited `task` decision for a descendant carrying the same host-attested
 * task authority. It never grants session- or version-wide authority.
 */
export function createEvalAutoApprover(options: {
  level: EvalApprovalLevel;
  runId: string;
  callerId: string;
  resolve(approvalId: string, decision: EvalApprovalDecision): Promise<void>;
  onApproved?(request: {
    approvalId: string;
    capability: string;
    tier: "gated" | "critical";
    decision: EvalApprovalDecision;
  }): void;
  onError(error: unknown): void;
}): EvalAutoApprover {
  const requests = new Map<string, EvalAuthorityRequest>();
  const activeTaskAuthorities = new Set<string>();
  const resolving = new Set<string>();
  let pending: readonly PendingApproval[] = [];

  const drain = () => {
    for (const request of requests.values()) {
      if (!admits(options.level, request.tier)) continue;
      const approval = pending.find(
        (candidate) =>
          candidate.kind === "capability" &&
          candidate.callerId === request.callerId &&
          candidate.capability === request.capability &&
          candidate.allowedDecisions?.includes("once") === true &&
          snapshotDigest(candidate) === request.snapshotDigest
      );
      if (!approval || resolving.has(approval.approvalId)) continue;
      resolving.add(approval.approvalId);
      void options.resolve(approval.approvalId, "once").then(
        () => {
          resolving.delete(approval.approvalId);
          requests.delete(request.snapshotDigest);
          if (approval.kind === "capability" && approval.snapshot?.taskAuthority) {
            activeTaskAuthorities.add(approval.snapshot.taskAuthority);
          }
          options.onApproved?.({
            approvalId: approval.approvalId,
            capability: request.capability,
            tier: request.tier,
            decision: "once",
          });
        },
        (error) => {
          resolving.delete(approval.approvalId);
          if (requests.has(request.snapshotDigest)) options.onError(error);
        }
      );
    }
    for (const approval of pending) {
      if (
        approval.kind !== "capability" ||
        resolving.has(approval.approvalId) ||
        (approval.snapshot?.taskRef?.endsWith(`:${options.runId}`) !== true &&
          approval.callerId !== options.callerId &&
          (approval.snapshot?.taskAuthority === undefined ||
            !activeTaskAuthorities.has(approval.snapshot.taskAuthority)))
      ) {
        continue;
      }
      const tier =
        approval.cardType === "permission.gated"
          ? "gated"
          : approval.cardType === "confirm.critical" || approval.cardType === "permission.outside"
            ? "critical"
            : approval.severity === "standard"
              ? "gated"
              : approval.severity === "severe"
                ? "critical"
                : null;
      if (!tier || !admits(options.level, tier)) continue;
      const belongsToActiveTask =
        approval.snapshot?.taskAuthority !== undefined &&
        activeTaskAuthorities.has(approval.snapshot.taskAuthority);
      const decision =
        belongsToActiveTask && approval.callerId !== options.callerId
          ? approval.allowedDecisions?.includes("task") === true
            ? "task"
            : null
          : approval.allowedDecisions?.includes("once") === true
            ? "once"
            : null;
      if (!decision) continue;
      resolving.add(approval.approvalId);
      void options.resolve(approval.approvalId, decision).then(
        () => {
          resolving.delete(approval.approvalId);
          if (approval.snapshot?.taskAuthority) {
            activeTaskAuthorities.add(approval.snapshot.taskAuthority);
          }
          options.onApproved?.({
            approvalId: approval.approvalId,
            capability: approval.capability,
            tier,
            decision,
          });
        },
        (error) => {
          resolving.delete(approval.approvalId);
          options.onError(error);
        }
      );
    }
  };

  return {
    observeAuthorityRequested(payload) {
      const request = authorityRequest(payload);
      if (!request) return;
      if (request.taskAuthority) activeTaskAuthorities.add(request.taskAuthority);
      requests.set(request.snapshotDigest, request);
      drain();
    },
    observeAuthorityDecided(payload) {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
      const digest = (payload as Record<string, unknown>)["snapshotDigest"];
      if (typeof digest === "string") requests.delete(digest);
    },
    observePending(next) {
      pending = next;
      drain();
    },
  };
}
