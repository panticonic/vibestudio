import type { ApprovalDecisionId } from "@natstack/shared/approvalContract";

export const BACKGROUND_ACTION_QUEUE_TTL_MS = 24 * 60 * 60 * 1000;

// Background notification actions only queue built-in inline decisions.
// Userland choices open the app so the foreground approval sheet can render arbitrary options.
export type BackgroundApprovalDecision = Exclude<ApprovalDecisionId, "dismiss">;

export interface QueuedBackgroundAction {
  approvalId: string;
  decision: BackgroundApprovalDecision;
  queuedAt: number;
}

interface QueueEnvelope {
  version: 1;
  actions: QueuedBackgroundAction[];
}

export function loadPendingActions(raw: string | null | undefined, now = Date.now()): QueuedBackgroundAction[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as Partial<QueueEnvelope> | QueuedBackgroundAction[];
    const actions = Array.isArray(parsed) ? parsed : parsed.actions;
    if (!Array.isArray(actions)) return [];
    return pruneStaleActions(actions.filter(isQueuedBackgroundAction), now);
  } catch {
    return [];
  }
}

export function serializePendingActions(actions: QueuedBackgroundAction[]): string {
  const envelope: QueueEnvelope = {
    version: 1,
    actions,
  };
  return JSON.stringify(envelope);
}

export function enqueueAction(
  actions: QueuedBackgroundAction[],
  action: QueuedBackgroundAction,
  now = Date.now(),
): QueuedBackgroundAction[] {
  const pending = pruneStaleActions(actions, now).filter((entry) => entry.approvalId !== action.approvalId);
  return [...pending, action];
}

export function clearAction(
  actions: QueuedBackgroundAction[],
  approvalId: string,
): QueuedBackgroundAction[] {
  return actions.filter((entry) => entry.approvalId !== approvalId);
}

export function pruneStaleActions(
  actions: QueuedBackgroundAction[],
  now = Date.now(),
): QueuedBackgroundAction[] {
  return actions.filter((entry) => now - entry.queuedAt <= BACKGROUND_ACTION_QUEUE_TTL_MS);
}

export function enqueueDeepLink(_currentApprovalId: string | null, approvalId: string): string {
  return approvalId;
}

export function loadDeepLink(raw: string | null | undefined): string | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as { approvalId?: unknown };
    return typeof parsed.approvalId === "string" && parsed.approvalId.length > 0
      ? parsed.approvalId
      : null;
  } catch {
    return null;
  }
}

export function serializeDeepLink(approvalId: string): string {
  return JSON.stringify({ approvalId });
}

function isQueuedBackgroundAction(value: unknown): value is QueuedBackgroundAction {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<QueuedBackgroundAction>;
  return typeof candidate.approvalId === "string" &&
    isBackgroundDecision(candidate.decision) &&
    typeof candidate.queuedAt === "number";
}

export function isBackgroundDecision(value: unknown): value is BackgroundApprovalDecision {
  return value === "once" ||
    value === "session" ||
    value === "version" ||
    value === "repo" ||
    value === "deny";
}
