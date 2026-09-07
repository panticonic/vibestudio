import { SERVER_ID_PATTERN } from "./deviceCredentials.js";

/** Host-stamped destination; a notification never follows the focused workspace. */
export interface WorkspacePushScope {
  serverId: string;
  userId: string;
  workspaceId: string;
}

export interface WorkspaceApprovalTarget extends WorkspacePushScope {
  approvalId: string;
}

export function readWorkspacePushScope(value: unknown): WorkspacePushScope | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (typeof data["serverId"] !== "string" || !SERVER_ID_PATTERN.test(data["serverId"]))
    return null;
  if (typeof data["workspaceId"] !== "string" || !data["workspaceId"].trim()) return null;
  if (typeof data["userId"] !== "string" || !data["userId"].trim()) return null;
  return { serverId: data["serverId"], workspaceId: data["workspaceId"], userId: data["userId"] };
}

export function sameWorkspacePushScope(
  left: WorkspacePushScope,
  right: WorkspacePushScope
): boolean {
  return (
    left.serverId === right.serverId &&
    left.userId === right.userId &&
    left.workspaceId === right.workspaceId
  );
}

export function workspaceNotificationKey(scope: WorkspacePushScope, id: string): string {
  return [scope.serverId, scope.userId, scope.workspaceId, id].map(encodeURIComponent).join(":");
}
