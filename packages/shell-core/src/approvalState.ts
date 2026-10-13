import type { PendingApproval } from "@vibestudio/shared/approvals";

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
  /** Installs observation, admits the remote subscription, and reads the first authoritative snapshot. */
  start(): Promise<PendingApproval[]>;
  /** Retires local observation, the remote subscription, and every owned read. */
  stop(): Promise<void>;
  refresh(reason?: ApprovalStateRefreshReason): Promise<PendingApproval[]>;
}

export function createApprovalStateController(
  deps: ApprovalStateControllerDeps
): ApprovalStateController {
  let disposed = false;
  let refreshSeq = 0;
  let unsubscribe: (() => void) | null = null;
  let admitted = false;
  let admission: Promise<void> | null = null;
  let starting: Promise<PendingApproval[]> | null = null;
  let stopping: Promise<void> | null = null;
  let current: PendingApproval[] = [];
  const reads = new Set<Promise<PendingApproval[]>>();
  const filter = deps.filter ?? ((pending: PendingApproval[]) => pending);

  const apply = (pending: PendingApproval[], source: ApprovalStateSource): PendingApproval[] => {
    const filtered = filter(pending);
    current = filtered;
    deps.onChange(filtered, source);
    return filtered;
  };

  const refresh = (reason: ApprovalStateRefreshReason = "manual"): Promise<PendingApproval[]> => {
    if (disposed) return Promise.reject(new Error("Approval state controller is stopped"));
    const seq = ++refreshSeq;
    let read!: Promise<PendingApproval[]>;
    read = (async () => {
      try {
        const pending = await deps.listPending();
        if (disposed) throw new Error("Approval state controller is stopped");
        if (!disposed && seq === refreshSeq) {
          return apply(pending, "refresh");
        }
        return current;
      } catch (error) {
        if (!disposed && seq === refreshSeq) deps.onError?.(error, `refresh:${reason}`);
        if (!disposed && seq !== refreshSeq) return current;
        throw error;
      } finally {
        reads.delete(read);
      }
    })();
    reads.add(read);
    return read;
  };

  const controller: ApprovalStateController = {
    start() {
      if (disposed) return Promise.reject(new Error("Approval state controller is stopped"));
      if (starting) return starting;
      unsubscribe = deps.onPendingChanged((payload) => {
        const pending = pendingApprovalsFromEventPayload(payload);
        if (pending) {
          refreshSeq++;
          apply(pending, "event");
          return;
        }
        void refresh("event-fallback").catch(() => undefined);
      });
      admission = deps.subscribePendingChanged().then(
        () => {
          admitted = true;
        },
        (error: unknown) => {
          if (!disposed) deps.onError?.(error, "subscribe");
          throw error;
        }
      );
      starting = admission.then(() => refresh("initial"));
      // Startup remains controller-owned while a caller is initiating stop or
      // otherwise has not attached its readiness observer yet. The returned
      // promise still rejects with the original failure.
      void starting.catch(() => undefined);
      return starting;
    },
    stop() {
      if (stopping) return stopping;
      disposed = true;
      refreshSeq++;
      unsubscribe?.();
      unsubscribe = null;
      stopping = (async () => {
        await admission?.catch(() => undefined);
        let unsubscribeFailure: unknown;
        if (admitted && deps.unsubscribePendingChanged) {
          try {
            await deps.unsubscribePendingChanged();
          } catch (error) {
            unsubscribeFailure = error;
            deps.onError?.(error, "unsubscribe");
          }
        }
        await Promise.allSettled([...reads]);
        if (unsubscribeFailure !== undefined) throw unsubscribeFailure;
      })();
      return stopping;
    },
    refresh,
  };
  return controller;
}
