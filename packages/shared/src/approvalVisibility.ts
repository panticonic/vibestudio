import { isAccountUserId } from "@vibestudio/identity/types";
import type { PendingApproval } from "./approvals.js";
import { filterRuntimeApprovals } from "./bootstrapApprovals.js";

export interface ApprovalScopeAccess {
  /** Whether this account is still admitted to the queue's owning scope. */
  isMember(userId: string): boolean;
  /** Whether this account administers the scope, and so answers its decisions. */
  isAdmin(userId: string): boolean;
}

/** Enumerated subject-free installed observers retain the managed bootstrap path. */
export function isHostApprovalObserver(owner: {
  userId?: string;
  callerId: string;
  callerKind: string;
}): boolean {
  return (
    !isAccountUserId(owner.userId) &&
    ((owner.callerKind === "server" && owner.callerId === "server") ||
      (owner.callerKind === "shell" &&
        ["shell", "electron-main", "headless-host"].includes(owner.callerId)))
  );
}

/** One live human audience for queue reads, decisions, notifications and counts. */
export function approvalVisibleToUser(
  approval: PendingApproval,
  userId: string,
  access: ApprovalScopeAccess
): boolean {
  if (!userId || !access.isMember(userId)) return false;
  const audience = approvalAudience(approval);
  return audience?.kind === "user"
    ? audience.userId === userId
    : audience?.kind === "workspace-admin" && access.isAdmin(userId);
}

/**
 * Who answers this approval. A decision an account initiated is private to that
 * account. A decision no account initiated — source admitted into the
 * workspace, a runtime asking to debug a privileged panel, a background worker
 * needing a secret — is a decision about the workspace itself, and the
 * workspace's administrators answer it. Only a self-contradictory request, one
 * whose owner and requester disagree, has no audience.
 */
export function approvalAudience(
  approval: PendingApproval
): { kind: "user"; userId: string } | { kind: "workspace-admin" } | null {
  // Only an account makes a decision private. A request stamped with the
  // synthetic system principal was raised by infrastructure, exactly like one
  // stamped with nobody.
  const requester = accountOrUndefined(approval.requestedByUserId);
  const owner =
    approval.kind === "browser-permission" ? accountOrUndefined(approval.ownerUserId) : undefined;
  if (owner && requester && owner !== requester) return null;
  if (owner || requester) return { kind: "user", userId: (owner ?? requester)! };
  return { kind: "workspace-admin" };
}

function accountOrUndefined(userId: string | undefined): string | undefined {
  return isAccountUserId(userId) ? userId : undefined;
}

/** Progress-only and bootstrap-owned reviews do not demand workspace attention. */
export function actionableRuntimeApprovals(approvals: PendingApproval[]): PendingApproval[] {
  return filterRuntimeApprovals(approvals).filter(
    (approval) => approval.lifecycle?.state !== "preparing"
  );
}

/** Separate owned and administrative counts so the hub applies live role changes. */
export function pendingApprovalCounts(approvals: PendingApproval[]): {
  pendingApprovals: Array<{ userId: string; count: number }>;
  workspaceApprovalCount: number;
} {
  const owners = new Map<string, number>();
  let workspaceApprovalCount = 0;
  for (const approval of actionableRuntimeApprovals(approvals)) {
    const audience = approvalAudience(approval);
    if (audience?.kind === "user")
      owners.set(audience.userId, (owners.get(audience.userId) ?? 0) + 1);
    else if (audience?.kind === "workspace-admin") workspaceApprovalCount += 1;
  }
  return {
    pendingApprovals: [...owners].map(([userId, count]) => ({ userId, count })),
    workspaceApprovalCount,
  };
}
