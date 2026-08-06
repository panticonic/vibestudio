import React from "react";
import { Box, Text, useApp, useStdin } from "ink";
import type { ApprovalDecisionId } from "@vibestudio/shared/approvalContract";
import type { PendingApproval } from "@vibestudio/shared/approvals";
import { SessionManager, type SessionSourceSpec } from "./SessionManager.js";
import { classifyChord, parseNavKey } from "./inputRouter.js";
import {
  applyInstallReviewNav,
  focusedRowKeyOf,
  INITIAL_INSTALL_REVIEW_NAV,
  routeApprovalDigit,
  shouldHandleInstallReviewNav,
  type InstallReviewNavState,
} from "./installReviewNav.js";
import type { ApprovalsClient } from "../approvals/approvalsClient.js";
import { StatusBar } from "../ui/StatusBar.js";
import { Viewport } from "../ui/Viewport.js";
import { SessionSwitcher } from "../ui/SessionSwitcher.js";
import { ApprovalsOverlay } from "../ui/ApprovalsOverlay.js";
import { LogsView, type LogLine } from "../ui/LogsView.js";

type Overlay = "none" | "switcher" | "approvals" | "logs";

const DECISION_BY_DIGIT: Record<number, ApprovalDecisionId> = {
  1: "once",
  2: "session",
  3: "version",
  4: "deny",
};

// The default session app (M3). Opening is on-demand; failure is shown inline.
const DEFAULT_SESSION: SessionSourceSpec = {
  source: "workers/terminal-chat",
  className: "TerminalChatWorker",
  title: "Terminal Chat",
};

export interface TerminalBrowserProps {
  sessions: SessionManager;
  approvals: ApprovalsClient;
  workspaceId: string;
  /** Push a runner/host log line (also fed from app log events). */
  logs: LogLine[];
  /** Shared with HostService so worker raw-mode requests respect overlays. */
  hostState: { overlayOpen: boolean };
}

export function TerminalBrowser(props: TerminalBrowserProps): React.ReactElement {
  const { sessions, approvals } = props;
  const { exit } = useApp();
  const { stdin, setRawMode } = useStdin();

  const [, setTick] = React.useState(0);
  const rerender = React.useCallback(() => setTick((t) => t + 1), []);
  const [overlay, setOverlay] = React.useState<Overlay>("none");
  const [selected, setSelected] = React.useState(0);
  const [pending, setPending] = React.useState<PendingApproval[]>([]);
  // Part/permission focus and selection for the approval currently on
  // screen, if it's a `unit-install-review` (docs §7.2/§8, U5). Reset
  // whenever the focused approval changes so a stale selection can never
  // leak onto a different review.
  const [installNav, setInstallNav] = React.useState<InstallReviewNavState>(
    INITIAL_INSTALL_REVIEW_NAV
  );

  // Refs so the raw stdin handler reads current state without re-subscribing.
  const overlayRef = React.useRef(overlay);
  const selectedRef = React.useRef(selected);
  const pendingRef = React.useRef(pending);
  const installNavRef = React.useRef(installNav);
  overlayRef.current = overlay;
  selectedRef.current = selected;
  pendingRef.current = pending;
  installNavRef.current = installNav;

  const focusedApprovalId = pending[selected]?.approvalId;
  React.useEffect(() => {
    setInstallNav(INITIAL_INSTALL_REVIEW_NAV);
  }, [focusedApprovalId]);

  // Re-render whenever session state changes (a frame arrived, focus moved, …).
  React.useEffect(() => sessions.subscribe(rerender), [sessions, rerender]);

  // Mirror overlay state so HostService can deny worker raw-mode while an
  // overlay owns the screen.
  React.useEffect(() => {
    props.hostState.overlayOpen = overlay !== "none";
  }, [overlay, props.hostState]);

  // Track the global approval queue.
  const refreshPending = React.useCallback(() => {
    void approvals
      .list()
      .then(setPending)
      .catch((error) => console.warn("[terminal-browser] Approval list refresh failed:", error));
  }, [approvals]);
  React.useEffect(() => {
    refreshPending();
    return approvals.onChange(refreshPending);
  }, [approvals, refreshPending]);

  const openApprovals = React.useCallback(() => {
    setSelected(0);
    setOverlay("approvals");
    refreshPending();
  }, [refreshPending]);

  // Single raw-stdin controller: host chords first, then session pass-through.
  React.useEffect(() => {
    setRawMode?.(true);
    const onData = (chunk: Buffer): void => {
      const bytes = new Uint8Array(chunk);
      const mode = overlayRef.current;

      if (mode === "none") {
        const chord = classifyChord(bytes);
        if (chord === "switcher") {
          const idx = sessions.list().findIndex((s) => s.focused);
          setSelected(Math.max(0, idx));
          setOverlay("switcher");
        } else if (chord === "approvals") {
          openApprovals();
        } else if (chord === "logs") {
          setOverlay("logs");
        } else if (chord === "new") {
          void sessions.open(DEFAULT_SESSION);
        } else if (chord === "quit") {
          void sessions.closeAll("host quit").finally(() => exit());
        } else {
          // Not a chord — forward raw bytes to the focused session.
          void sessions.sendInput(bytes);
        }
        return;
      }

      // Overlay open → navigation; session input is suspended.
      const nav = parseNavKey(bytes);
      if (nav === "escape") {
        setOverlay("none");
        return;
      }
      if (mode === "switcher") {
        const list = sessions.list();
        if (nav === "up") setSelected((i) => Math.max(0, i - 1));
        else if (nav === "down") setSelected((i) => Math.min(list.length - 1, i + 1));
        else if (nav === "enter") {
          const target = list[selectedRef.current];
          if (target) sessions.focus(target.sessionId);
          setOverlay("none");
        } else if (typeof nav === "object" && nav && "char" in nav) {
          if (nav.char === "n") void sessions.open(DEFAULT_SESSION);
          else if (nav.char === "x") {
            const target = list[selectedRef.current];
            if (target) void sessions.close(target.sessionId);
          }
        }
        return;
      }
      if (mode === "approvals") {
        const list = pendingRef.current;
        const target = list[selectedRef.current];
        if (nav === "up") setSelected((i) => Math.max(0, i - 1));
        else if (nav === "down") setSelected((i) => Math.min(list.length - 1, i + 1));
        else if (shouldHandleInstallReviewNav(target, nav)) {
          // Part focus, permission-row expansion, and their toggles (§7.2, §8,
          // U5) — everything ↑/↓/1/4 don't already own. Inert for every other
          // approval kind, so it can never shadow the generic digit decisions.
          const parts = target.parts;
          setInstallNav((prevState) => applyInstallReviewNav(prevState, nav, parts));
        } else if (typeof nav === "object" && nav && "digit" in nav) {
          // The only valid resolution for a `unit-install-review` (§8) is
          // `resolveInstallReview` with the selection built so far — never
          // the generic once/session/version/deny path used everywhere else.
          const route = routeApprovalDigit(
            target,
            nav.digit,
            installNavRef.current.selection,
            DECISION_BY_DIGIT
          );
          if (route.via === "resolveInstallReview") {
            void approvals
              .resolveInstallReview(route.approvalId, route.resolution)
              .then(refreshPending)
              .catch((error) =>
                console.warn("[terminal-browser] Install review decision failed:", error)
              );
          } else if (route.via === "resolve") {
            void approvals
              .resolve(route.approvalId, route.decision)
              .then(refreshPending)
              .catch((error) => console.warn("[terminal-browser] Approval decision failed:", error));
          }
        }
        return;
      }
      // logs: only Esc handled (above)
    };

    stdin?.on("data", onData);
    return () => {
      stdin?.off("data", onData);
    };
  }, [stdin, setRawMode, sessions, approvals, exit, openApprovals, refreshPending]);

  const focused = sessions.focused();
  const status = focused?.status ?? "none";

  let body: React.ReactElement;
  if (overlay === "switcher") {
    body = <SessionSwitcher sessions={sessions.list()} selectedIndex={selected} />;
  } else if (overlay === "approvals") {
    const focusedApproval = pending[selected];
    const isInstallReview = focusedApproval?.kind === "unit-install-review";
    body = (
      <ApprovalsOverlay
        pending={pending}
        selectedIndex={selected}
        partIndex={isInstallReview ? installNav.partIndex : undefined}
        installSelection={isInstallReview ? installNav.selection : undefined}
        focusedRowKey={
          isInstallReview ? focusedRowKeyOf(installNav, focusedApproval.parts) : undefined
        }
      />
    );
  } else if (overlay === "logs") {
    body = <LogsView lines={props.logs} />;
  } else {
    body = (
      <Viewport
        rows={focused ? focused.vt.styledGrid() : []}
        placeholder={
          focused?.status === "errored"
            ? `Session error: ${focused.error ?? "unknown"} — Ctrl+N to retry`
            : undefined
        }
      />
    );
  }

  return (
    <Box flexDirection="column">
      <StatusBar
        workspace={props.workspaceId}
        sessionTitle={focused?.title ?? "—"}
        status={status}
        pendingApprovals={pending.length}
      />
      {body}
      <Text dimColor>{"^P sessions  ^A approvals  ^L logs  ^N new  ^Q quit"}</Text>
    </Box>
  );
}
