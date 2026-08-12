/**
 * ConsentApprovalBar — the approval coordinator. It owns the approval state
 * (subscription, queue, minimized) and the RPC handlers, and renders the
 * minimized **pill** in the notifications strip. The expanded **card** is hosted
 * by the reusable content overlay (a native surface floating above the panels),
 * driven here via `useShellContentOverlay`: this component pushes the current
 * approval as props and runs the matching `shellApproval.*` call when the card
 * emits an intent. The presentational card lives in `./ApprovalCard`.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { Badge, Flex, Text } from "@radix-ui/themes";
import { ChevronRightIcon } from "@radix-ui/react-icons";
import type { ApprovalDecision, PendingApproval } from "@vibestudio/shared/approvals";
import { getApprovalCopy } from "@vibestudio/shared/approvalCopy";
import type { TemplateInstallResolution } from "@vibestudio/shared/authority/unitInstallReview";
import type { InstallReviewResolution } from "@vibestudio/service-schemas/shellApproval";
import { filterRuntimeApprovals } from "@vibestudio/shared/bootstrapApprovals";
import {
  createApprovalStateController,
  SHELL_APPROVAL_PENDING_CHANGED_EVENT,
} from "@vibestudio/shell-core/approvalState";
import { account, blobstore, events, panel, shellApproval, shellPresence } from "../shell/client";
import { useShellContentOverlay, type ContentOverlayBounds } from "../shell/useShellContentOverlay";
import { useShellEvent } from "../shell/useShellEvent";
import { effectiveThemeAtom, themeConfigAtom } from "../state/themeAtoms";
import { useNavigationActions } from "./NavigationContext";
import { ApprovalKindIcon } from "./ApprovalCard";
import { ApprovalFullSurface } from "./ApprovalFullSurface";
import { InstallReviewOutcomeNotice } from "./InstallReview";
import {
  approvalOpensFullSurface,
  diffReviewPayloadHashes,
  getDiffReviewPayload,
  highestPendingTone,
  resolveCallerInfo,
  type ApprovalCardIntent,
  type ApprovalTone,
  type BlobResult,
  type CallerInfo,
  type WorkspaceHistoryTarget,
} from "./approvalCardModel";
import type { OverlayThemeInfo } from "../overlay/types";

/**
 * Id of the panel-region wrapper (rendered by PanelApp) whose rect anchors the
 * floating approval card overlay to the top-right of the panel viewport.
 */
export const APPROVAL_OVERLAY_HOST_ID = "app-approval-host";
/**
 * Approval events are a prompt, not the source of truth. A workspace server
 * can create an approval while the desktop event watch is being replaced or
 * recovering, so periodically reconcile the small pending set as well. This
 * keeps a user from being stranded behind an invisible approval without
 * turning every render into an RPC call.
 */
const APPROVAL_RECONCILE_INTERVAL_MS = 5_000;

/** Workspace source path of Workspace History (the file-inspection surface
 *  the diff-review escape hatch deep-links into). */
const WORKSPACE_HISTORY_SOURCE = "about/workspace-history";

export function ConsentApprovalBar() {
  const [pendingAccess, setPendingAccess] = useState<PendingApproval[]>([]);
  const [decisionError, setDecisionError] = useState<{
    approvalId: string;
    message: string;
  } | null>(null);
  /**
   * Decisions are in flight per approval, not globally.
   *
   * An install review leaves the pending queue as soon as its decision is
   * accepted, while the RPC can remain open until the resulting publication
   * lands. The next review is therefore allowed to appear before the previous
   * receipt returns. A single global lock made that next review look enabled
   * while silently discarding its action. Keep the exact in-flight identities
   * instead: duplicate answers to one review are blocked, independent reviews
   * remain answerable.
   */
  const submittingApprovalIdsRef = useRef<Set<string>>(new Set());
  const [submittingApprovalIds, setSubmittingApprovalIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  /**
   * What came of the last install review (§7.2, "Result").
   *
   * It has to be held here rather than in the review, because the review is
   * gone by the time there is anything to say: accepting removes the approval
   * from the queue and unmounts the card that asked. This state is what lets
   * `News added` / `Open News →` exist at all, and it is deliberately outside
   * the queue — it never delays, hides, or replaces the next approval.
   */
  const [installResult, setInstallResult] = useState<InstallReviewResolution | null>(null);
  const transientWorkspaceReady =
    installResult?.mode === "adopt-root" &&
    installResult.decision === "accepted" &&
    installResult.landing !== undefined &&
    installResult.landing.failed.length === 0;
  const installResultHasFailure = (installResult?.landing?.failed.length ?? 0) > 0;
  const installResultAutoDismissMs = installResultHasFailure
    ? null
    : transientWorkspaceReady
      ? 5_000
      : 8_000;
  const [minimized, setMinimized] = useState(false);
  const [browseIndex, setBrowseIndex] = useState(0);
  const [attentionSeq, setAttentionSeq] = useState(0);
  const currentApprovalIdRef = useRef<string | null>(null);
  const [keyboardFocusRequest, setKeyboardFocusRequest] = useState<{
    approvalId: string;
    sequence: number;
  } | null>(null);
  // Diff-review (P3.5): host-served blob cache, keyed by content hash, fetched
  // lazily on the overlay surface's behalf (the surface has no RPC).
  const [blobResults, setBlobResults] = useState<Record<string, BlobResult>>({});
  const blobResultsRef = useRef(blobResults);
  blobResultsRef.current = blobResults;
  const inFlightBlobsRef = useRef<Set<string>>(new Set());
  const seenApprovalIdsRef = useRef<Set<string>>(new Set());
  const reviewingQueuedRef = useRef(false);
  // A review can drain the pending queue before the protected operation resumes
  // and asks for its next approval. Remember the requester across that empty
  // edge so the continuation stays on the surface the user is already using.
  // A queued request from anyone else still arrives quietly in the pill.
  const reviewContinuationCallerIdRef = useRef<string | null>(null);
  const { navigateToId } = useNavigationActions();
  const effectiveTheme = useAtomValue(effectiveThemeAtom);
  const themeConfig = useAtomValue(themeConfigAtom);

  // Results are transient confirmations. Failures are the exception: they name
  // work that needs attention and remain until explicitly dismissed.
  useEffect(() => {
    if (!installResult || installResultAutoDismissMs === null) return;
    const timer = window.setTimeout(() => {
      setInstallResult((current) => (current === installResult ? null : current));
    }, installResultAutoDismissMs);
    return () => window.clearTimeout(timer);
  }, [installResult, installResultAutoDismissMs]);

  useEffect(() => {
    const heartbeat = () => {
      void shellPresence
        .heartbeat()
        .catch((err: unknown) => console.warn("[ConsentApprovalBar] heartbeat failed:", err));
    };
    heartbeat();
    const intervalId = window.setInterval(heartbeat, 5_000);
    return () => window.clearInterval(intervalId);
  }, []);

  useShellEvent(
    "focus-approval-card",
    useCallback(() => {
      reviewingQueuedRef.current = true;
      setMinimized(false);
      const approvalId = currentApprovalIdRef.current;
      if (approvalId) {
        setKeyboardFocusRequest((previous) => ({
          approvalId,
          sequence: (previous?.sequence ?? 0) + 1,
        }));
      }
    }, [])
  );

  useEffect(() => {
    const controller = createApprovalStateController({
      listPending: () => shellApproval.listPending(),
      subscribePendingChanged: () => events.subscribe(SHELL_APPROVAL_PENDING_CHANGED_EVENT),
      unsubscribePendingChanged: () => events.unsubscribe(SHELL_APPROVAL_PENDING_CHANGED_EVENT),
      onPendingChanged: (listener) =>
        events.on(SHELL_APPROVAL_PENDING_CHANGED_EVENT, (payload) => listener(payload)),
      filter: filterRuntimeApprovals,
      onChange: (pending) => setPendingAccess(pending),
      onError: (err, phase) => {
        console.warn(`[ConsentApprovalBar] approval state ${phase} failed:`, err);
      },
    });
    controller.start();
    const reconcileId = window.setInterval(() => {
      void controller.refresh("manual");
    }, APPROVAL_RECONCILE_INTERVAL_MS);
    return () => {
      window.clearInterval(reconcileId);
      controller.stop();
    };
  }, []);

  // Replay the attention pulse whenever a not-yet-seen approval enters the queue.
  useEffect(() => {
    const ids = new Set(pendingAccess.map((approval) => approval.approvalId));
    const hasNew = pendingAccess.some(
      (approval) => !seenApprovalIdsRef.current.has(approval.approvalId)
    );
    seenApprovalIdsRef.current = ids;
    if (hasNew) setAttentionSeq((seq) => seq + 1);
  }, [pendingAccess]);

  // Browsable index — stays put when later items resolve, clamps when the
  // visible item disappears.
  useEffect(() => {
    setBrowseIndex((idx) => {
      if (pendingAccess.length === 0) return 0;
      if (idx >= pendingAccess.length) return pendingAccess.length - 1;
      return idx;
    });
  }, [pendingAccess.length]);

  const orderedPending = useMemo(
    () =>
      pendingAccess
        .map((approval, index) => ({ approval, index }))
        .sort((left, right) => {
          const priority = (approval: PendingApproval) => (approval.attention === "queue" ? 1 : 0);
          return priority(left.approval) - priority(right.approval) || left.index - right.index;
        })
        .map(({ approval }) => approval),
    [pendingAccess]
  );
  const current = orderedPending[browseIndex] ?? orderedPending[0] ?? null;
  currentApprovalIdRef.current = current?.approvalId ?? null;
  const queueLength = orderedPending.length;
  const canPrev = queueLength > 1 && browseIndex > 0;
  const canNext = queueLength > 1 && browseIndex < queueLength - 1;
  const currentCaller = current ? resolveCallerInfo(current) : null;
  const diffReview = current ? getDiffReviewPayload(current) : null;
  const diffHashes = diffReview ? diffReviewPayloadHashes(diffReview) : new Set<string>();
  const payloadHashes = diffHashes;

  useLayoutEffect(() => {
    if (!current) {
      reviewingQueuedRef.current = false;
      setMinimized(false);
      return;
    }
    if (current.attention === "queue") {
      const continuesResolvedReview = reviewContinuationCallerIdRef.current === current.callerId;
      if (!reviewingQueuedRef.current && !continuesResolvedReview) {
        reviewContinuationCallerIdRef.current = null;
        setMinimized(true);
        return;
      }
      reviewingQueuedRef.current = true;
      setMinimized(false);
      return;
    }
    reviewingQueuedRef.current = false;
    reviewContinuationCallerIdRef.current = null;
    setMinimized(false);
  }, [current?.approvalId, current?.attention, current?.callerId]);

  useEffect(() => {
    setDecisionError((error) => (error && error.approvalId !== current?.approvalId ? null : error));
    // A new approval starts with an empty blob cache — payload hashes are
    // per-approval, and nothing should carry over between them.
    setBlobResults({});
    inFlightBlobsRef.current.clear();
  }, [current?.approvalId]);

  // Fetch one payload blob on the surface's behalf. Only hashes named in the
  // current approval's payload are fetchable; any other hash is ignored.
  const fetchBlob = (hash: string, refresh = false) => {
    if (!current || !payloadHashes.has(hash)) return;
    const existing = blobResultsRef.current[hash];
    // Immutable successful content remains cached. A refresh is meaningful
    // only for a prior missing/error result and never duplicates in-flight IO.
    if ((existing && (!refresh || "text" in existing)) || inFlightBlobsRef.current.has(hash)) {
      return;
    }
    if (refresh) {
      setBlobResults((previous) => {
        if (!(hash in previous)) return previous;
        const next = { ...previous };
        delete next[hash];
        return next;
      });
    }
    inFlightBlobsRef.current.add(hash);
    void blobstore
      .getText(hash)
      .then((text) =>
        setBlobResults((prev) => ({ ...prev, [hash]: text == null ? { missing: true } : { text } }))
      )
      .catch((err: unknown) =>
        setBlobResults((prev) => ({
          ...prev,
          [hash]: { error: err instanceof Error ? err.message : "Blob fetch failed" },
        }))
      )
      .finally(() => inFlightBlobsRef.current.delete(hash));
  };

  // Drained queue → reset to expanded so the next approval greets as a card.
  useEffect(() => {
    if (queueLength === 0 && minimized) setMinimized(false);
  }, [queueLength, minimized]);

  // Measure the panel-region rect (the overlay anchor). Re-measure on resize.
  const [anchorBounds, setAnchorBounds] = useState<ContentOverlayBounds | null>(null);
  useEffect(() => {
    const measure = () => {
      const host = document.getElementById(APPROVAL_OVERLAY_HOST_ID);
      const rect = host?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        setAnchorBounds(null);
        return;
      }
      const next = {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
      setAnchorBounds((prev) =>
        prev &&
        prev.x === next.x &&
        prev.y === next.y &&
        prev.width === next.width &&
        prev.height === next.height
          ? prev
          : next
      );
    };
    measure();
    const host = document.getElementById(APPROVAL_OVERLAY_HOST_ID);
    const observer =
      host && typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(host as Element);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  // --- RPC handlers (recreated each render so they close over the latest
  // `current`; the overlay hook always calls the freshest intent handler). ---
  const decide = (decision: ApprovalDecision) => {
    const approval = current;
    if (!approval) return;
    setDecisionError(null);
    setPendingAccess((items) => items.filter((item) => item.approvalId !== approval.approvalId));
    void shellApproval.resolve(approval.approvalId, decision).catch((err: unknown) => {
      console.error("[ConsentApprovalBar] resolve failed:", err);
      const message = err instanceof Error ? err.message : String(err);
      setPendingAccess((items) =>
        items.some((item) => item.approvalId === approval.approvalId) ? items : [approval, ...items]
      );
      setDecisionError({
        approvalId: approval.approvalId,
        message: message || "Approval decision failed.",
      });
    });
  };
  const submitClientConfig = (values: Record<string, string>) => {
    if (current?.kind !== "client-config") return;
    runApprovalAction(current, () => shellApproval.submitClientConfig(current.approvalId, values));
  };
  const submitCredentialInput = (values: Record<string, string>) => {
    if (current?.kind !== "credential-input") return;
    runApprovalAction(current, () =>
      shellApproval.submitCredentialInput(current.approvalId, values)
    );
  };
  const submitSecretInput = (values: Record<string, string>) => {
    if (current?.kind !== "secret-input") return;
    runApprovalAction(current, () => shellApproval.submitSecretInput(current.approvalId, values));
  };
  const resolveMissionReview = (
    resolution: { decision: "approve"; selectedAuthorityKeys: string[] } | { decision: "dismiss" }
  ) => {
    if (current?.kind !== "mission-review") return;
    runApprovalAction(current, () =>
      shellApproval.resolveMissionReview(current.approvalId, resolution)
    );
  };
  /**
   * Answer a review and keep what the server says came of it.
   *
   * The call returns a typed resolution — heading, parts, entry point, landing —
   * and dropping it on the floor is what used to make success unshowable. A
   * throw is a different outcome from a resolution that reports failed parts:
   * the first leaves the review pending (the card says so inline, from
   * `decisionError`), the second means the decision was taken and the notice
   * below has to name what did not survive it.
   */
  const resolveInstallReview = (resolution: TemplateInstallResolution) => {
    if (current?.kind !== "unit-install-review") return;
    const approval = current;
    setInstallResult(null);
    // Answering is the end of the review, not the beginning of a loading
    // screen. The server deliberately keeps this RPC open after recording the
    // decision so it can return the later landing receipt; leaving the decided
    // approval in local state for that whole interval made startup reconciliation
    // look like a very slow save. Retire it immediately, exactly as the standard
    // approval path does, and restore the same snapshot only if the decision
    // itself fails.
    setPendingAccess((items) => items.filter((item) => item.approvalId !== approval.approvalId));
    runApprovalAction(
      approval,
      async () => {
        const outcome = await shellApproval.resolveInstallReview(approval.approvalId, resolution);
        setInstallResult(outcome);
      },
      () => {
        setPendingAccess((items) =>
          items.some((item) => item.approvalId === approval.approvalId)
            ? items
            : [approval, ...items]
        );
      }
    );
  };
  const runApprovalAction = (
    approval: PendingApproval,
    action: () => Promise<unknown>,
    onError?: () => void
  ) => {
    if (submittingApprovalIdsRef.current.has(approval.approvalId)) return;
    submittingApprovalIdsRef.current.add(approval.approvalId);
    setDecisionError(null);
    setSubmittingApprovalIds(new Set(submittingApprovalIdsRef.current));
    void action()
      .catch((err: unknown) => {
        console.error("[ConsentApprovalBar] approval action failed:", err);
        onError?.();
        setDecisionError({
          approvalId: approval.approvalId,
          message: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        submittingApprovalIdsRef.current.delete(approval.approvalId);
        setSubmittingApprovalIds(new Set(submittingApprovalIdsRef.current));
      });
  };
  // Diff-review escape hatch: reuse Workspace History if one exists
  // (navigate it to the new target + focus), otherwise create one. The target
  // rides along as launch state-args the panel consumes on mount/param-change.
  const openInWorkspaceHistory = (target: WorkspaceHistoryTarget) => {
    const stateArgs = { diffTarget: target };
    void (async () => {
      try {
        const profile = await account.getProfile().catch(() => null);
        // Reusing a colleague's panel changes their live navigation state. Only
        // reuse within the acting account's owner group; if identity is
        // temporarily unavailable, creating a fresh panel is the safe action.
        let existingId: string | null = null;
        let cursor: string | undefined;
        while (profile && !existingId) {
          const page = await panel.getTreePage({
            group: { kind: "roots", ownerUserId: profile.userId },
            ...(cursor ? { cursor } : {}),
            limit: 100,
          });
          for (const node of page.nodes) {
            const observation = await panel.observe(node.slotId);
            if (observation.source === WORKSPACE_HISTORY_SOURCE) {
              existingId = node.slotId;
              break;
            }
          }
          cursor = page.nextCursor ?? undefined;
          if (!cursor) break;
        }
        if (existingId) {
          await panel.navigate(existingId, WORKSPACE_HISTORY_SOURCE, { stateArgs });
          navigateToId(existingId);
        } else {
          await panel.createPanel(WORKSPACE_HISTORY_SOURCE, { stateArgs });
        }
      } catch (err: unknown) {
        console.error("[ConsentApprovalBar] open-in-workspace-history failed:", err);
      }
    })();
  };

  /**
   * `Open News →` (§7.2).
   *
   * Not a new mechanism: a part's `repoPath` is the very thing this shell opens
   * panels by. `PanelStack`, the notification bar's `openPanel` instruction and
   * the diff-review escape hatch above all call `panel.createPanel(source)`, so
   * the entry point inherits placement, focus and the panel tree instead of
   * growing a second way to put something on screen.
   *
   * Panels only, and that is a fact about client apps rather than caution. An
   * `app` part is host chrome: it is bound to a host target in `meta`, built
   * without a panel loader, and mounted by the app orchestrator as the window's
   * own view — one per host. `createPanel("apps/news")` would build the wrong
   * artifact into a panel slot with the wrong preload. There is no "open this
   * app" action in this shell to reuse, so the result reports the app landed
   * and offers no link, rather than offering one that cannot work.
   *
   * The notice clears once the thing it points at is open: it exists to hand the
   * user to what was just added, and it has done that. If the open fails the
   * notice stays, because dismissing it would take the only remaining link with
   * it.
   */
  const openEntryPoint = (entryPoint: NonNullable<InstallReviewResolution["entryPoint"]>) => {
    void panel
      .createPanel(entryPoint.repoPath, { title: entryPoint.title })
      .then(() => setInstallResult(null))
      .catch((err: unknown) => {
        console.error("[ConsentApprovalBar] open entry point failed:", err);
      });
  };

  const minimizeReview = () => {
    reviewingQueuedRef.current = false;
    reviewContinuationCallerIdRef.current = null;
    setMinimized(true);
  };

  const handleIntent = (payload: unknown) => {
    if (typeof payload !== "object" || payload === null) return;
    const candidate = payload as { type?: unknown; approvalId?: unknown };
    if (typeof candidate.type !== "string" || typeof candidate.approvalId !== "string") return;
    const intent = payload as ApprovalCardIntent;
    if (!current || intent.approvalId !== current.approvalId) return;
    const continueReviewSession = () => {
      // A requester may replace one review with its own queued follow-up while
      // the decision is being recorded. Keep that continuation on the surface,
      // including across a briefly empty queue. Do not turn an interrupt into
      // a general queue-review session: unrelated background work must remain
      // in the notification pill. An explicitly opened queued review already
      // has `reviewingQueuedRef` set and therefore continues normally.
      reviewContinuationCallerIdRef.current = current.callerId;
    };
    switch (intent.type) {
      case "minimize":
        minimizeReview();
        return;
      case "browse":
        setBrowseIndex((idx) =>
          intent.dir === "prev" ? Math.max(0, idx - 1) : Math.min(queueLength - 1, idx + 1)
        );
        return;
      case "show-panel":
        if (currentCaller?.panelId) navigateToId(currentCaller.panelId);
        return;
      case "decide":
        continueReviewSession();
        decide(intent.decision);
        return;
      case "device-cancel":
        continueReviewSession();
        decide("dismiss");
        return;
      case "submit-client-config":
        continueReviewSession();
        submitClientConfig(intent.values);
        return;
      case "submit-credential-input":
        continueReviewSession();
        submitCredentialInput(intent.values);
        return;
      case "submit-secret-input":
        continueReviewSession();
        submitSecretInput(intent.values);
        return;
      case "resolve-mission-review":
        continueReviewSession();
        resolveMissionReview(intent.resolution);
        return;
      case "resolve-install-review":
        continueReviewSession();
        resolveInstallReview(intent.resolution);
        return;
      case "fetch-blob":
        fetchBlob(intent.hash, intent.refresh);
        return;
      case "open-in-workspace-history":
        openInWorkspaceHistory(intent.target);
        return;
    }
  };

  // Secret-input + device-code flows want keyboard focus on open; others stay
  // hands-off so the panel keeps focus and remains clickable.
  const needsFocus =
    current?.kind === "client-config" ||
    current?.kind === "credential-input" ||
    current?.kind === "device-code";
  const focusRequest =
    current && keyboardFocusRequest?.approvalId === current.approvalId
      ? `explicit:${current.approvalId}:${keyboardFocusRequest.sequence}`
      : current && needsFocus
        ? `initial:${current.approvalId}`
        : undefined;

  const theme = useMemo<OverlayThemeInfo>(
    () => ({
      appearance: effectiveTheme,
      accentColor: themeConfig.accentColor,
      grayColor: themeConfig.grayColor,
      radius: themeConfig.radius,
      scaling: themeConfig.scaling,
      panelBackground: themeConfig.panelBackground,
    }),
    [
      effectiveTheme,
      themeConfig.accentColor,
      themeConfig.grayColor,
      themeConfig.panelBackground,
      themeConfig.radius,
      themeConfig.scaling,
    ]
  );

  const overlayProps = useMemo(
    () =>
      current
        ? {
            approval: current,
            queue:
              queueLength > 1 ? { index: browseIndex, total: queueLength, canPrev, canNext } : null,
            decisionError:
              decisionError && decisionError.approvalId === current.approvalId
                ? decisionError.message
                : null,
            actionPending: submittingApprovalIds.has(current.approvalId),
            diffReview,
            blobResults,
            appearance: effectiveTheme,
          }
        : null,
    [
      blobResults,
      browseIndex,
      canNext,
      canPrev,
      current,
      decisionError,
      diffReview,
      effectiveTheme,
      queueLength,
      submittingApprovalIds,
    ]
  );

  /**
   * Where this approval is hosted (§7.2, §7.8).
   *
   * A unit install review opens on the full surface — a window-sized dialog this
   * chrome owns — and everything else keeps the floating content overlay. The
   * two hosts are exclusive: the overlay is a native view above the panels, so
   * leaving it up behind the dialog would float a second copy of the same
   * decision over the first.
   */
  const fullSurface = current != null && approvalOpensFullSurface(current);
  const overlayOpen = current != null && !minimized && !fullSurface && anchorBounds != null;
  useShellContentOverlay(
    overlayOpen && current && anchorBounds
      ? {
          surface: "approval-card",
          open: true,
          bounds: anchorBounds,
          focusRequest,
          theme,
          props: overlayProps,
        }
      : null,
    handleIntent
  );

  /**
   * The result of the last review, in the chrome strip (§7.2, §7.8).
   *
   * It sits beside whatever the queue is doing rather than in front of it: the
   * next approval still opens, the pill still appears, and this line is only a
   * report. That is why it renders on every branch below including the empty
   * one — by the time there is a result there is usually no approval left, and
   * a result that unmounted with the review would never be seen.
   *
   * The shape is the shell's existing post-action strip (`SavePasswordBar`'s
   * confirmation, `UserNotificationBar`'s notice): a `data-shell-top-chrome`
   * band above the panels, in normal DOM flow, that pushes content down instead
   * of covering it. A successful workspace-adoption result is the exception:
   * it is a brief confirmation with no link, because the workspace is already
   * open. Results for later installs keep their link until followed or
   * dismissed.
   */
  const resultNotice = installResult ? (
    <div data-shell-top-chrome="install-review-result" className="install-review-result">
      <InstallReviewOutcomeNotice
        outcome={{ source: "resolved", resolution: installResult }}
        compact
        {...(!transientWorkspaceReady && installResult.entryPoint?.kind === "panel"
          ? { onOpenEntryPoint: openEntryPoint }
          : {})}
        onDismiss={() => setInstallResult(null)}
      />
    </div>
  ) : null;

  if (!current || !currentCaller) return resultNotice;

  // The full surface is chrome, not overlay: it renders here, in this document,
  // so it can be a real dialog with the shell's focus behaviour. Closing it
  // without deciding is the same act as minimizing the card — the review stays
  // pending in the queue and the pill offers it back.
  if (!minimized && fullSurface) {
    return (
      <>
        {resultNotice}
        <ApprovalFullSurface
          approval={current}
          caller={currentCaller}
          queue={
            queueLength > 1 ? { index: browseIndex, total: queueLength, canPrev, canNext } : null
          }
          decisionError={
            decisionError && decisionError.approvalId === current.approvalId
              ? decisionError.message
              : null
          }
          actionPending={submittingApprovalIds.has(current.approvalId)}
          appearance={effectiveTheme}
          emit={handleIntent}
          onClose={minimizeReview}
        />
      </>
    );
  }

  // While expanded the card lives in the overlay surface — the chrome renders
  // nothing but the last result. Minimized, it shows the pill in the
  // notifications strip.
  if (!minimized) return resultNotice;

  return (
    <>
      {resultNotice}
      <ApprovalMinimizedPill
        approval={current}
        caller={currentCaller}
        tone={highestPendingTone(orderedPending)}
        count={queueLength}
        attentionSeq={attentionSeq}
        onExpand={() => {
          reviewingQueuedRef.current = true;
          reviewContinuationCallerIdRef.current = current.callerId;
          setKeyboardFocusRequest((previous) => ({
            approvalId: current.approvalId,
            sequence: (previous?.sequence ?? 0) + 1,
          }));
          setMinimized(false);
        }}
      />
    </>
  );
}

function ApprovalMinimizedPill({
  approval,
  caller,
  tone,
  count,
  attentionSeq,
  onExpand,
}: {
  approval: PendingApproval;
  caller: CallerInfo;
  tone: ApprovalTone;
  count: number;
  attentionSeq: number;
  onExpand: () => void;
}) {
  const copy = getApprovalCopy(approval);
  const multiple = count > 1;
  const primary = multiple ? `${count} approvals waiting` : copy.title;
  const secondary = multiple
    ? `${copy.title} · ${caller.label}`
    : `${caller.label} · ${caller.kindLabel.toLowerCase()}`;
  return (
    <div data-shell-top-chrome="approval-pill">
      <button
        type="button"
        className="approval-pill"
        data-approval-tone={tone}
        data-approval-pill=""
        onClick={onExpand}
        aria-label={
          multiple ? `Review ${count} pending approvals` : `Review approval: ${copy.title}`
        }
      >
        <span key={attentionSeq} className="approval-pill-pulse" aria-hidden="true" />
        <span className="approval-pill-icon">
          <ApprovalKindIcon approval={approval} size={15} />
        </span>
        <Flex direction="column" style={{ minWidth: 0, flex: 1 }}>
          <Text size="2" weight="bold" truncate>
            {primary}
          </Text>
          <Text size="1" color="gray" truncate>
            {secondary}
          </Text>
        </Flex>
        {multiple ? (
          <Badge color="gray" variant="soft" radius="full">
            {count}
          </Badge>
        ) : null}
        <Flex align="center" gap="1" className="approval-pill-cta">
          <Text size="1" weight="medium">
            Review
          </Text>
          <ChevronRightIcon />
        </Flex>
      </button>
    </div>
  );
}
