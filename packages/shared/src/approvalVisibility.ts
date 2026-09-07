import type { PendingApproval } from "./approvals.js";
import { filterRuntimeApprovals } from "./bootstrapApprovals.js";

export interface ApprovalWorkspaceAccess {
  isMember(userId: string): boolean;
  isAdmin(userId: string): boolean;
}

/** Enumerated subject-free installed observers retain the managed bootstrap path. */
export function isHostApprovalObserver(owner: {
  userId?: string;
  callerId: string;
  callerKind: string;
}): boolean {
  return (
    (!owner.userId || owner.userId === "system") &&
    ((owner.callerKind === "server" && owner.callerId === "server") ||
      (owner.callerKind === "shell" &&
        ["shell", "electron-main", "headless-host"].includes(owner.callerId)))
  );
}

/** One live human audience for queue reads, decisions, notifications and counts. */
export function approvalVisibleToUser(
  approval: PendingApproval,
  userId: string,
  access: ApprovalWorkspaceAccess
): boolean {
  if (!userId || !access.isMember(userId)) return false;
  const audience = approvalAudience(approval);
  return audience?.kind === "user"
    ? audience.userId === userId
    : audience?.kind === "workspace-admin" && access.isAdmin(userId);
}

export function approvalAudience(
  approval: PendingApproval
): { kind: "user"; userId: string } | { kind: "workspace-admin" } | null {
  const requester = approval.requestedByUserId;
  const owner = approval.kind === "browser-permission" ? approval.ownerUserId : undefined;
  if (owner && requester && owner !== requester) return null;
  if (owner || requester) return { kind: "user", userId: (owner ?? requester)! };
  // Unowned source admission is a workspace decision. An unowned credential,
  // capability or protected input never becomes an administrator's private grant.
  return approval.kind === "unit-install-review" ? { kind: "workspace-admin" } : null;
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
