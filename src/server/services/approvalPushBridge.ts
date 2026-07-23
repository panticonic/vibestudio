import {
  APPROVAL_CATEGORY_DECIDE,
  APPROVAL_CATEGORY_INPUT_REQUIRED,
  APPROVAL_CATEGORY_BROWSER_PERMISSION,
  NOTIFICATION_ACTION_IDS_BROWSER_PERMISSION,
  NOTIFICATION_ACTION_IDS_INPUT_REQUIRED,
  NOTIFICATION_ACTION_IDS_STANDARD,
  type PushApprovalDataPayload,
} from "@vibestudio/shared/approvalContract";
import { getApprovalCopy } from "@vibestudio/shared/approvalCopy";
import { HOST_APPROVAL_COPY } from "@vibestudio/shared/hostApprovalCopy";
import type { PendingApproval } from "@vibestudio/shared/approvals";
import type { ApprovalQueueWithListeners } from "./approvalQueue.js";
import type { PushDeliveryTarget, PushServiceInternal } from "./pushService.js";
import type { ShellPresenceInternal } from "./shellPresenceService.js";

interface ApprovalPushBridgeDeps {
  approvalQueue: Pick<ApprovalQueueWithListeners, "listPending" | "onPendingChanged">;
  push: PushServiceInternal;
  shellPresence: ShellPresenceInternal;
  /**
   * This child's workspace member userIds (WP4 §4.4, WP2-backed). A child process
   * IS one workspace, so its members are exactly the push audience for that
   * child's approvals — every member may approve (plan §6.1), so every member's
   * devices may be notified and no non-member device is. Read live (not cached)
   * from the shared identity DB by `index.ts`.
   */
  workspaceMemberUserIds: () => readonly string[];
  delayMs?: number;
  presenceMaxAgeMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  retryMs?: number;
}

export interface ApprovalPushBridge {
  stop(): void;
}

interface TrackedApproval {
  approval: PendingApproval;
  timers: ReturnType<typeof setTimeout>[];
  deliveredTargets: PushDeliveryTarget[];
  sending: boolean;
}

function categoryFor(approval: PendingApproval): string {
  if (approval.kind === "browser-permission") return APPROVAL_CATEGORY_BROWSER_PERMISSION;
  return approval.kind === "credential" ||
    approval.kind === "capability" ||
    approval.kind === "unit-batch"
    ? APPROVAL_CATEGORY_DECIDE
    : APPROVAL_CATEGORY_INPUT_REQUIRED;
}

function actionsFor(approval: PendingApproval): readonly string[] {
  if (approval.kind === "browser-permission") {
    return NOTIFICATION_ACTION_IDS_BROWSER_PERMISSION;
  }
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
  once: HOST_APPROVAL_COPY.pushActions.once,
  session: HOST_APPROVAL_COPY.pushActions.session,
  deny: HOST_APPROVAL_COPY.pushActions.deny,
  open: HOST_APPROVAL_COPY.pushActions.open,
  version: HOST_APPROVAL_COPY.pushActions.version,
  always: "Always allow",
  block: "Always block",
};

function actionPayloadFor(approval: PendingApproval): Array<{ id: string; title: string }> {
  return actionsFor(approval).map((id) => ({
    id,
    title:
      id === "once" && approval.kind === "unit-batch"
        ? approval.trigger === "source-change"
          ? HOST_APPROVAL_COPY.pushActions.approveChange
          : approval.trigger === "management"
            ? HOST_APPROVAL_COPY.pushActions.approve
            : HOST_APPROVAL_COPY.pushActions.approveAll
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
  const retryMs = deps.retryMs ?? 15_000;
  const tracked = new Map<string, TrackedApproval>();

  function clearTrackedTimers(trackedApproval: TrackedApproval): void {
    for (const timer of trackedApproval.timers) {
      clearTimeoutFn(timer);
    }
    trackedApproval.timers = [];
  }

  async function sendApproval(trackedApproval: TrackedApproval): Promise<PushDeliveryTarget[]> {
    const approval = trackedApproval.approval;
    const category = categoryFor(approval);
    const copy = getApprovalCopy(approval);
    const description = copy.warning ? `${copy.summary} ${copy.warning}` : copy.summary;
    // Prefer the server-resolved caller title over the bare kind word so the
    // notification names who's asking semantically, never a raw id.
    const requester = approval.callerTitle?.trim() || callerLabel(approval);
    const body = `${requester} · ${description}`;
    const members = new Set(deps.workspaceMemberUserIds());
    const delivered = new Set(
      trackedApproval.deliveredTargets.map((target) => `${target.userId}\0${target.clientId}`)
    );
    const targets = deps.push
      .listRegistrations()
      .filter((registration) => members.has(registration.userId))
      .map((registration) => ({ userId: registration.userId, clientId: registration.clientId }))
      .filter((target) => !delivered.has(`${target.userId}\0${target.clientId}`));
    if (targets.length === 0) return [];
    const results = await deps.push.sendToTargets(targets, {
      title: copy.title,
      body,
      category,
      data: payloadFor(approval, copy.title, body, category),
    });
    return results
      .filter((result) => result.sent)
      .map((result) => ({ userId: result.userId, clientId: result.clientId }));
  }

  async function attemptSend(
    trackedApproval: TrackedApproval,
    logContext: "immediate" | "delayed" | "registration" | "retry"
  ): Promise<void> {
    if (trackedApproval.sending) return;
    trackedApproval.sending = true;
    clearTrackedTimers(trackedApproval);
    try {
      const delivered = await sendApproval(trackedApproval);
      if (tracked.get(trackedApproval.approval.approvalId) !== trackedApproval) {
        if (delivered.length > 0) {
          await deps.push.cancel(delivered, trackedApproval.approval.approvalId);
        }
        return;
      }
      const targets = new Map(
        trackedApproval.deliveredTargets.map((target) => [
          `${target.userId}\0${target.clientId}`,
          target,
        ])
      );
      for (const target of delivered) {
        targets.set(`${target.userId}\0${target.clientId}`, target);
      }
      trackedApproval.deliveredTargets = [...targets.values()];
    } catch (error) {
      console.warn(`[ApprovalPushBridge] ${logContext} push send failed:`, error);
    } finally {
      trackedApproval.sending = false;
      if (tracked.get(trackedApproval.approval.approvalId) === trackedApproval) {
        trackedApproval.timers.push(
          setTimeoutFn(() => void attemptSend(trackedApproval, "retry"), retryMs)
        );
      }
    }
  }

  function trackNewApproval(approval: PendingApproval): void {
    if (!shouldPushApproval(approval)) return;
    const trackedApproval: TrackedApproval = {
      approval,
      timers: [],
      deliveredTargets: [],
      sending: false,
    };
    tracked.set(approval.approvalId, trackedApproval);

    const sendIfPending = (reason: "presence-stale" | "deadline") => {
      if (!tracked.has(approval.approvalId)) return;
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
    if (existing.deliveredTargets.length === 0) return;
    // Cancel the exact successful delivery targets. Membership and registration
    // changes after the prompt must not alter its cancellation audience.
    void deps.push.cancel(existing.deliveredTargets, approvalId).catch((error) => {
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
