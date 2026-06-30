import {
  APPROVAL_CATEGORY_DECIDE,
  APPROVAL_CATEGORY_INPUT_REQUIRED,
  NOTIFICATION_ACTION_IDS_INPUT_REQUIRED,
  NOTIFICATION_ACTION_IDS_STANDARD,
  type PushApprovalDataPayload,
} from "@vibez1/shared/approvalContract";
import { getApprovalCopy } from "@vibez1/shared/approvalCopy";
import type { PendingApproval } from "@vibez1/shared/approvals";
import type { ApprovalQueueWithListeners } from "./approvalQueue.js";
import type { PushServiceInternal } from "./pushService.js";
import type { ShellPresenceInternal } from "./shellPresenceService.js";

interface ApprovalPushBridgeDeps {
  approvalQueue: Pick<ApprovalQueueWithListeners, "listPending" | "onPendingChanged">;
  push: PushServiceInternal;
  shellPresence: ShellPresenceInternal;
  delayMs?: number;
  presenceMaxAgeMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface ApprovalPushBridge {
  stop(): void;
}

interface TrackedApproval {
  approval: PendingApproval;
  timers: ReturnType<typeof setTimeout>[];
  sent: boolean;
}

function categoryFor(approval: PendingApproval): string {
  return approval.kind === "credential" ||
    approval.kind === "capability" ||
    approval.kind === "unit-batch"
    ? APPROVAL_CATEGORY_DECIDE
    : APPROVAL_CATEGORY_INPUT_REQUIRED;
}

function actionsFor(approval: PendingApproval): readonly string[] {
  if (approval.kind === "unit-batch") {
    // Source/config change approvals offer a dev-session grant; startup/management do not.
    return approval.trigger === "meta-change" || approval.trigger === "source-change"
      ? ["once", "session", "deny", "open"]
      : ["once", "deny", "open"];
  }
  return approval.kind === "credential" || approval.kind === "capability"
    ? NOTIFICATION_ACTION_IDS_STANDARD
    : NOTIFICATION_ACTION_IDS_INPUT_REQUIRED;
}

const ACTION_TITLES: Record<string, string> = {
  once: "Once",
  session: "Session",
  deny: "Deny",
  open: "Open",
  version: "Trust Version",
};

function actionPayloadFor(approval: PendingApproval): Array<{ id: string; title: string }> {
  return actionsFor(approval).map((id) => ({
    id,
    title:
      id === "once" && approval.kind === "unit-batch"
        ? approval.trigger === "source-change"
          ? "Approve change"
          : approval.trigger === "management"
            ? "Approve"
            : "Approve all"
        : (ACTION_TITLES[id] ?? id),
  }));
}

function callerLabel(approval: PendingApproval): string {
  if (approval.callerKind === "app") return "App";
  if (approval.callerKind === "worker") return "Worker";
  if (approval.callerKind === "do") return "DO";
  if (approval.callerKind === "system") return "Workspace";
  return "Panel";
}

function payloadFor(
  approval: PendingApproval,
  title: string,
  body: string,
  category: string
): PushApprovalDataPayload {
  return {
    kind: "approval-prompt",
    approvalId: approval.approvalId,
    approvalKind: approval.kind,
    title,
    body,
    category,
    cancelKey: approval.approvalId,
    actionsJson: JSON.stringify(actionPayloadFor(approval)),
  };
}

function shouldPushApproval(approval: PendingApproval): boolean {
  return !(approval.kind === "unit-batch" && approval.trigger === "startup");
}

export function createApprovalPushBridge(deps: ApprovalPushBridgeDeps): ApprovalPushBridge {
  const delayMs = deps.delayMs ?? 10_000;
  const presenceMaxAgeMs = deps.presenceMaxAgeMs ?? 6_000;
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  const tracked = new Map<string, TrackedApproval>();

  function clearTrackedTimers(trackedApproval: TrackedApproval): void {
    for (const timer of trackedApproval.timers) {
      clearTimeoutFn(timer);
    }
    trackedApproval.timers = [];
  }

  async function sendApproval(approval: PendingApproval): Promise<boolean> {
    const category = categoryFor(approval);
    const copy = getApprovalCopy(approval);
    const description = copy.warning ? `${copy.summary} ${copy.warning}` : copy.summary;
    // Prefer the server-resolved caller title over the bare kind word so the
    // notification names who's asking semantically, never a raw id.
    const requester = approval.callerTitle?.trim() || callerLabel(approval);
    const body = `${requester} · ${description}`;
    const results = await deps.push.sendBatch({
      title: copy.title,
      body,
      category,
      data: payloadFor(approval, copy.title, body, category),
    });
    return results.some((result) => result.sent);
  }

  async function attemptSend(
    trackedApproval: TrackedApproval,
    logContext: "immediate" | "delayed" | "registration"
  ): Promise<void> {
    try {
      const sent = await sendApproval(trackedApproval.approval);
      trackedApproval.sent = sent;
    } catch (error) {
      console.warn(`[ApprovalPushBridge] ${logContext} push send failed:`, error);
    }
  }

  function trackNewApproval(approval: PendingApproval): void {
    if (!shouldPushApproval(approval)) return;
    const trackedApproval: TrackedApproval = {
      approval,
      timers: [],
      sent: false,
    };
    tracked.set(approval.approvalId, trackedApproval);

    const sendIfPending = (reason: "presence-stale" | "deadline") => {
      if (!tracked.has(approval.approvalId) || trackedApproval.sent) return;
      if (reason === "presence-stale" && deps.shellPresence.isAnyShellActive(presenceMaxAgeMs)) {
        return;
      }
      clearTrackedTimers(trackedApproval);
      void attemptSend(trackedApproval, "delayed");
    };

    if (deps.shellPresence.isAnyShellActive()) {
      trackedApproval.timers.push(
        setTimeoutFn(() => sendIfPending("presence-stale"), presenceMaxAgeMs)
      );
      trackedApproval.timers.push(setTimeoutFn(() => sendIfPending("deadline"), delayMs));
      return;
    }

    void attemptSend(trackedApproval, "immediate");
  }

  function cancelTracked(approvalId: string): void {
    const existing = tracked.get(approvalId);
    if (!existing) return;
    clearTrackedTimers(existing);
    tracked.delete(approvalId);
    if (!existing.sent) return;
    void deps.push.cancel(approvalId).catch((error) => {
      console.warn("[ApprovalPushBridge] push cancel failed:", error);
    });
  }

  function onPendingChanged(pending: PendingApproval[]): void {
    const pendingIds = new Set(pending.map((approval) => approval.approvalId));
    for (const approvalId of tracked.keys()) {
      if (!pendingIds.has(approvalId)) {
        cancelTracked(approvalId);
      }
    }
    for (const approval of pending) {
      if (!tracked.has(approval.approvalId)) {
        trackNewApproval(approval);
      }
    }
  }

  const unsubscribe = deps.approvalQueue.onPendingChanged(onPendingChanged);
  const unsubscribePushRegistrations = deps.push.onRegistrationsChanged(() => {
    for (const trackedApproval of tracked.values()) {
      if (trackedApproval.sent) continue;
      clearTrackedTimers(trackedApproval);
      void attemptSend(trackedApproval, "registration");
    }
  });
  onPendingChanged(deps.approvalQueue.listPending());

  return {
    stop() {
      unsubscribe();
      unsubscribePushRegistrations();
      for (const approvalId of [...tracked.keys()]) {
        cancelTracked(approvalId);
      }
    },
  };
}
