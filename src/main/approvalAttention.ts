import { app, Notification } from "electron";
import type { BaseWindow } from "electron";
import type { PendingApproval } from "@vibez1/shared/approvals";
import { getApprovalAttribution, getApprovalCopy } from "@vibez1/shared/approvalCopy";
import { filterRuntimeApprovals } from "@vibez1/shared/bootstrapApprovals";

export interface ApprovalAttention {
  /** Apply the latest pending list: badge count, frame flash, OS notification. */
  handlePendingChanged(pending: PendingApproval[]): void;
  /** Stop frame flashing once the user has brought the window forward. */
  handleWindowFocus(): void;
  /**
   * Pull the current pending list from the server. `quiet` seeds the
   * seen-set and badge without alerting — used at startup so approvals
   * that were already pending before launch don't fire a notification
   * while the window is still coming up.
   */
  refresh(opts?: { quiet?: boolean }): Promise<void>;
}

/**
 * OS-level attention for pending approvals. The in-shell ConsentApprovalBar
 * is only visible when the Vibez1 window is; this module covers the rest:
 * dock/launcher badge count, taskbar frame flash (dock bounce on macOS), and
 * a native notification that focuses the shell on click.
 */
export function createApprovalAttention(deps: {
  getWindow(): BaseWindow | null;
  listPending(): Promise<PendingApproval[] | null>;
  log?: Pick<Console, "warn">;
}): ApprovalAttention {
  const log = deps.log ?? console;
  const knownIds = new Set<string>();
  let flashing = false;
  let activeNotification: Notification | null = null;

  const liveWindow = (): BaseWindow | null => {
    const win = deps.getWindow();
    return win && !win.isDestroyed() ? win : null;
  };

  const focusShell = () => {
    const win = liveWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };

  const setBadge = (count: number) => {
    // macOS dock and Linux launcher badge. Windows has no count badge —
    // the frame flash below covers it there.
    try {
      app.setBadgeCount(count);
    } catch {
      // Badge unsupported on this platform/desktop environment.
    }
  };

  const flash = (on: boolean) => {
    if (on === flashing) return;
    flashing = on;
    try {
      liveWindow()?.flashFrame(on);
    } catch {
      // Frame flash unsupported; badge/notification still apply.
    }
  };

  const closeNotification = () => {
    activeNotification?.close();
    activeNotification = null;
  };

  const notify = (fresh: PendingApproval, totalPending: number) => {
    if (!Notification.isSupported()) return;
    const copy = getApprovalCopy(fresh);
    const attribution = getApprovalAttribution(fresh);
    const requester = fresh.callerTitle?.trim() || fresh.callerKind;
    const others = totalPending - 1;
    const body =
      [requester, attribution.target].filter(Boolean).join(" · ") +
      (others > 0 ? ` (+${others} more pending)` : "");
    closeNotification();
    const notification = new Notification({
      title: copy.title,
      body,
      urgency: "critical",
      timeoutType: "never",
    });
    notification.on("click", () => {
      focusShell();
      closeNotification();
    });
    activeNotification = notification;
    notification.show();
  };

  const apply = (pending: PendingApproval[], quiet: boolean) => {
    const runtimePending = filterRuntimeApprovals(pending);
    const fresh = runtimePending.filter((approval) => !knownIds.has(approval.approvalId));
    knownIds.clear();
    for (const approval of runtimePending) knownIds.add(approval.approvalId);

    setBadge(runtimePending.length);
    if (runtimePending.length === 0) {
      flash(false);
      closeNotification();
      return;
    }
    const firstFresh = fresh[0];
    if (quiet || !firstFresh) return;

    const win = liveWindow();
    const userIsLooking = win !== null && win.isFocused() && win.isVisible();
    if (userIsLooking) return;

    flash(true);
    if (process.platform === "darwin") {
      app.dock?.bounce("critical");
    }
    notify(firstFresh, runtimePending.length);
  };

  return {
    handlePendingChanged(pending) {
      apply(pending, false);
    },
    handleWindowFocus() {
      flash(false);
    },
    async refresh(opts = {}) {
      try {
        const pending = await deps.listPending();
        if (Array.isArray(pending)) {
          apply(pending, opts.quiet === true);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`[approvalAttention] listPending refresh failed: ${msg}`);
      }
    },
  };
}
