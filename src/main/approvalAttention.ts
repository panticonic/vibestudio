import { app, Notification } from "electron";
import type { BaseWindow } from "electron";
import type { PendingApproval } from "@vibestudio/shared/approvals";
import { getApprovalAttribution, getApprovalCopy } from "@vibestudio/shared/approvalCopy";
import { actionableRuntimeApprovals } from "@vibestudio/shared/approvalVisibility";
import { approvalPresentationKey } from "@vibestudio/shared/approvalPresentation";

export interface WorkspaceApprovalSnapshot {
  workspaceId: string;
  workspaceLabel: string;
  pending: PendingApproval[];
}

export interface ApprovalAttention {
  /** Apply the latest pending list: badge count, frame flash, OS notification. */
  handlePendingChanged(snapshot: WorkspaceApprovalSnapshot): void;
  removeWorkspace(workspaceId: string): void;
  /** Stop frame flashing once the user has brought the window forward. */
  handleWindowFocus(): void;
  /** Stop attention updates before the server connection is torn down. */
  dispose(): void;
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
 * is only visible when the Vibestudio window is; this module covers the rest:
 * dock/launcher badge count, taskbar frame flash (dock bounce on macOS), and
 * a native notification that focuses the shell on click.
 */
export function createApprovalAttention(deps: {
  getWindow(): BaseWindow | null;
  listPending(): Promise<WorkspaceApprovalSnapshot[] | null>;
  log?: Pick<Console, "warn">;
}): ApprovalAttention {
  const log = deps.log ?? console;
  const knownIds = new Set<string>();
  // Null retires an owner and fences any refresh begun before its removal.
  const workspaces = new Map<string, WorkspaceApprovalSnapshot | null>();
  let flashing = false;
  let activeNotification: { notification: Notification; key: string } | null = null;
  let disposed = false;

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
    activeNotification?.notification.close();
    activeNotification = null;
  };

  const notify = (
    fresh: PendingApproval,
    workspaceLabel: string,
    key: string,
    totalPending: number
  ) => {
    if (!Notification.isSupported()) return;
    const copy = getApprovalCopy(fresh);
    const attribution = getApprovalAttribution(fresh);
    const requester = fresh.callerTitle?.trim() || fresh.callerKind;
    const others = totalPending - 1;
    const body =
      [workspaceLabel, requester, attribution.target].filter(Boolean).join(" · ") +
      (others > 0 ? ` (+${others} more pending)` : "");
    closeNotification();
    const notification = new Notification({
      title: copy.title,
      body,
      urgency: "critical",
      timeoutType: "never",
    });
    notification.on("click", () => {
      if (activeNotification?.notification !== notification) return;
      focusShell();
      closeNotification();
    });
    activeNotification = { notification, key };
    notification.show();
  };

  const apply = (quiet: boolean) => {
    const runtimePending = [...workspaces.values()].flatMap((snapshot) =>
      snapshot
        ? actionableRuntimeApprovals(snapshot.pending).map((approval) => ({
            approval,
            workspaceId: snapshot.workspaceId,
            workspaceLabel: snapshot.workspaceLabel,
          }))
        : []
    );
    const key = (entry: (typeof runtimePending)[number]) =>
      approvalPresentationKey({
        workspaceId: entry.workspaceId,
        approvalId: entry.approval.approvalId,
      });
    const fresh = runtimePending.filter((entry) => !knownIds.has(key(entry)));
    knownIds.clear();
    for (const entry of runtimePending) knownIds.add(key(entry));
    if (activeNotification && !knownIds.has(activeNotification.key)) closeNotification();

    setBadge(runtimePending.length);
    if (runtimePending.length === 0) {
      flash(false);
      closeNotification();
      return;
    }
    const firstFresh = fresh.find(({ approval }) => approval.attention !== "queue");
    if (quiet || !firstFresh) return;

    const win = liveWindow();
    const userIsLooking = win !== null && win.isFocused() && win.isVisible();
    if (userIsLooking) return;

    flash(true);
    if (process.platform === "darwin") {
      app.dock?.bounce("critical");
    }
    notify(firstFresh.approval, firstFresh.workspaceLabel, key(firstFresh), runtimePending.length);
  };

  return {
    handlePendingChanged(snapshot) {
      if (disposed) return;
      workspaces.set(snapshot.workspaceId, snapshot);
      apply(false);
    },
    removeWorkspace(workspaceId) {
      if (disposed) return;
      workspaces.set(workspaceId, null);
      apply(true);
    },
    handleWindowFocus() {
      if (disposed) return;
      flash(false);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      workspaces.clear();
      knownIds.clear();
      closeNotification();
      flash(false);
    },
    async refresh(opts = {}) {
      if (disposed) return;
      const before = new Map(workspaces);
      try {
        const pending = await deps.listPending();
        if (disposed) return;
        if (Array.isArray(pending)) {
          const present = new Set(pending.map((snapshot) => snapshot.workspaceId));
          for (const [workspaceId, snapshot] of before) {
            if (!present.has(workspaceId) && workspaces.get(workspaceId) === snapshot)
              workspaces.set(workspaceId, null);
          }
          for (const snapshot of pending) {
            if (workspaces.get(snapshot.workspaceId) === before.get(snapshot.workspaceId))
              workspaces.set(snapshot.workspaceId, snapshot);
          }
          apply(opts.quiet === true);
        }
      } catch (err) {
        if (disposed) return;
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`[approvalAttention] listPending refresh failed: ${msg}`);
      }
    },
  };
}
