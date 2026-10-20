import type { ApprovalDecisionId } from "@vibestudio/shared/approvalContract";
import {
  readWorkspacePushScope,
  sameWorkspacePushScope,
  type WorkspaceApprovalTarget,
} from "@vibestudio/shared/workspacePushScope";
import { isPushUserInboxDataPayload } from "@vibestudio/shared/userNotifications";
import type { NotificationOpen } from "@vibestudio/rn-client-api/notificationsProtocol";

/**
 * Pure state of the lock-screen decision queue and of the pending open. The
 * stored shapes are what `hostNotifications.ts` persists through its key-value
 * port; nothing here touches a device.
 */

export type BackgroundApprovalDecision = Exclude<ApprovalDecisionId, "dismiss">;
export interface QueuedBackgroundAction extends WorkspaceApprovalTarget {
  decision: BackgroundApprovalDecision;
  queuedAt: number;
}

export function readApprovalTarget(value: unknown): WorkspaceApprovalTarget | null {
  const scope = readWorkspacePushScope(value);
  if (!scope) return null;
  const approvalId = (value as Record<string, unknown>)["approvalId"];
  return typeof approvalId === "string" && approvalId.trim() ? { ...scope, approvalId } : null;
}

export function sameApprovalTarget(
  left: WorkspaceApprovalTarget,
  right: WorkspaceApprovalTarget
): boolean {
  return sameWorkspacePushScope(left, right) && left.approvalId === right.approvalId;
}

export function isBackgroundDecision(value: unknown): value is BackgroundApprovalDecision {
  return value === "once" || value === "session" || value === "version" || value === "deny";
}

/**
 * A queued decision has no expiry: it leaves the queue when the server accepts
 * it, or answers that the approval no longer exists (`hostNotifications.drain`).
 */
export function loadPendingActions(raw: string | null | undefined): QueuedBackgroundAction[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { actions?: unknown };
    if (!Array.isArray(parsed.actions)) return [];
    return parsed.actions.filter(
      (value): value is QueuedBackgroundAction =>
        readApprovalTarget(value) !== null &&
        isBackgroundDecision(value.decision) &&
        Number.isFinite(value.queuedAt)
    );
  } catch {
    return [];
  }
}

export function serializePendingActions(actions: QueuedBackgroundAction[]): string {
  return JSON.stringify({ version: 2, actions });
}

/** A later decision on the same approval replaces the earlier one. */
export function enqueueAction(
  actions: QueuedBackgroundAction[],
  action: QueuedBackgroundAction
): QueuedBackgroundAction[] {
  return [...actions.filter((entry) => !sameApprovalTarget(entry, action)), action];
}

export function sameQueuedAction(
  left: QueuedBackgroundAction,
  right: QueuedBackgroundAction
): boolean {
  return (
    sameApprovalTarget(left, right) &&
    left.decision === right.decision &&
    left.queuedAt === right.queuedAt
  );
}

export function serializeOpen(open: NotificationOpen): string {
  return JSON.stringify(open);
}

export function loadOpen(raw: string | null | undefined): NotificationOpen | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed["kind"] === "approval") {
      const target = readApprovalTarget(parsed["target"]);
      return target ? { kind: "approval", target } : null;
    }
    if (parsed["kind"] === "inbox" && isPushUserInboxDataPayload(parsed["payload"])) {
      return { kind: "inbox", payload: parsed["payload"] };
    }
    return null;
  } catch {
    return null;
  }
}
