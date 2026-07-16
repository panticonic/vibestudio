import type { PendingApproval } from "@vibestudio/shared/approvals";
import { filterRuntimeApprovals } from "@vibestudio/shared/bootstrapApprovals";

export const SHELL_APPROVAL_PENDING_CHANGED_EVENT = "shell-approval:pending-changed" as const;

export type ApprovalPendingChangedPayload = { pending: PendingApproval[] };
export type ApprovalStateSource = "event" | "refresh";
export type ApprovalStateRefreshReason = "initial" | "manual" | "event-fallback";
export type ApprovalStateErrorPhase =
  | "subscribe"
  | "unsubscribe"
  | `refresh:${ApprovalStateRefreshReason}`;

export function pendingApprovalsFromEventPayload(payload: unknown): PendingApproval[] | null {
  if (!payload || typeof payload !== "object") return null;
  const pending = (payload as { pending?: unknown }).pending;
  return Array.isArray(pending) ? (pending as PendingApproval[]) : null;
}

export function runtimePendingApprovalsFromEventPayload(
  payload: unknown
): PendingApproval[] | null {
  const pending = pendingApprovalsFromEventPayload(payload);
  return pending ? filterRuntimeApprovals(pending) : null;
}

export function pendingApprovalSignature(pending: readonly PendingApproval[]): string {
  return pending.map((approval) => `${approval.kind}:${approval.approvalId}`).join("|");
}

export interface ApprovalStateControllerDeps {
  listPending(): Promise<PendingApproval[]>;
  subscribePendingChanged(): Promise<void>;
  unsubscribePendingChanged?(): Promise<void>;
  onPendingChanged(listener: (payload: unknown) => void): () => void;
  onChange(pending: PendingApproval[], source: ApprovalStateSource): void;
  filter?(pending: PendingApproval[]): PendingApproval[];
  onError?(error: unknown, phase: ApprovalStateErrorPhase): void;
}

export interface ApprovalStateController {
  start(): void;
  stop(): void;
  refresh(reason?: ApprovalStateRefreshReason): Promise<PendingApproval[]>;
}

export function createApprovalStateController(
  deps: ApprovalStateControllerDeps
): ApprovalStateController {
  let disposed = false;
  let refreshSeq = 0;
  let unsubscribe: (() => void) | null = null;
  const filter = deps.filter ?? ((pending: PendingApproval[]) => pending);

  const apply = (pending: PendingApproval[], source: ApprovalStateSource): PendingApproval[] => {
    const filtered = filter(pending);
    deps.onChange(filtered, source);
    return filtered;
  };

  const refresh = async (
    reason: ApprovalStateRefreshReason = "manual"
  ): Promise<PendingApproval[]> => {
    const seq = ++refreshSeq;
    try {
      const pending = await deps.listPending();
      if (!disposed && seq === refreshSeq) {
        return apply(pending, "refresh");
      }
      return filter(pending);
    } catch (error) {
      deps.onError?.(error, `refresh:${reason}`);
      return [];
    }
  };

  return {
    start() {
      if (unsubscribe || disposed) return;
      unsubscribe = deps.onPendingChanged((payload) => {
        const pending = pendingApprovalsFromEventPayload(payload);
        if (pending) {
          refreshSeq++;
          apply(pending, "event");
          return;
        }
        void refresh("event-fallback");
      });
      void deps
        .subscribePendingChanged()
        .catch((error) => deps.onError?.(error, "subscribe"))
        .finally(() => {
          if (!disposed) void refresh("initial");
        });
    },
    stop() {
      disposed = true;
      refreshSeq++;
      unsubscribe?.();
      unsubscribe = null;
      void deps
        .unsubscribePendingChanged?.()
        .catch((error) => deps.onError?.(error, "unsubscribe"));
    },
    refresh,
  };
}
