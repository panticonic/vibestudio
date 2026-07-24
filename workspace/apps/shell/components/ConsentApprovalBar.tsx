/**
 * ConsentApprovalBar — the approval coordinator. It owns the approval state
 * (subscription, queue, minimized) and the RPC handlers, and renders the
 * minimized **pill** in the notifications strip. The expanded **card** is hosted
 * by the reusable content overlay (a native surface floating above the panels),
 * driven here via `useShellContentOverlay`: this component pushes the current
 * approval as props and runs the matching `shellApproval.*` call when the card
 * emits an intent. The presentational card lives in `./ApprovalCard`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { Badge, Flex, Text } from "@radix-ui/themes";
import { ChevronRightIcon } from "@radix-ui/react-icons";
import type { ApprovalDecision, PendingApproval } from "@vibestudio/shared/approvals";
import { getApprovalCopy } from "@vibestudio/shared/approvalCopy";
import { filterRuntimeApprovals } from "@vibestudio/shared/bootstrapApprovals";
import {
  createApprovalStateController,
  SHELL_APPROVAL_PENDING_CHANGED_EVENT,
} from "@vibestudio/shell-core/approvalState";
import {
  account,
  blobstore,
  events,
  panel,
  shellApproval,
  shellPresence,
} from "../shell/client";
import { useShellContentOverlay, type ContentOverlayBounds } from "../shell/useShellContentOverlay";
import { useShellEvent } from "../shell/useShellEvent";
import { effectiveThemeAtom, themeConfigAtom } from "../state/themeAtoms";
import { useNavigation } from "./NavigationContext";
import { ApprovalKindIcon } from "./ApprovalCard";
import {
  diffReviewPayloadHashes,
  getDiffReviewPayload,
  highestPendingTone,
  resolveCallerInfo,
  type ApprovalCardIntent,
  type ApprovalTone,
  type BlobResult,
  type CallerInfo,
  type GadBrowserTarget,
} from "./approvalCardModel";
import type { OverlayThemeInfo } from "../overlay/types";

/**
 * Id of the panel-region wrapper (rendered by PanelApp) whose rect anchors the
 * floating approval card overlay to the top-right of the panel viewport.
 */
export const APPROVAL_OVERLAY_HOST_ID = "app-approval-host";

/** Workspace source path of the gad-browser panel (the file-inspection surface
 *  the diff-review escape hatch deep-links into). */
const GAD_BROWSER_SOURCE = "panels/gad-browser";

/** Minimal structural view of a panel-tree node — enough to locate an existing
 *  gad-browser panel by its snapshot source without importing the full type. */
interface TreePanelNode {
  id: string;
  snapshot?: { source?: string };
  children?: TreePanelNode[];
}

/** Depth-first search for the first live gad-browser panel in the tree. */
function findGadBrowserPanel(nodes: TreePanelNode[]): TreePanelNode | null {
  for (const node of nodes) {
    if (node.snapshot?.source === GAD_BROWSER_SOURCE) return node;
    const child = node.children ? findGadBrowserPanel(node.children) : null;
    if (child) return child;
  }
  return null;
}

export function ConsentApprovalBar() {
  const [pendingAccess, setPendingAccess] = useState<PendingApproval[]>([]);
  const [decisionError, setDecisionError] = useState<{
    approvalId: string;
    message: string;
  } | null>(null);
  const [submittingApprovalId, setSubmittingApprovalId] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [browseIndex, setBrowseIndex] = useState(0);
  const [attentionSeq, setAttentionSeq] = useState(0);
  const [keyboardFocusRequested, setKeyboardFocusRequested] = useState(false);
  // Diff-review (P3.5): host-served blob cache, keyed by content hash, fetched
  // lazily on the overlay surface's behalf (the surface has no RPC).
  const [blobResults, setBlobResults] = useState<Record<string, BlobResult>>({});
  const blobResultsRef = useRef(blobResults);
  blobResultsRef.current = blobResults;
  const inFlightBlobsRef = useRef<Set<string>>(new Set());
  const seenApprovalIdsRef = useRef<Set<string>>(new Set());
  const { navigateToId } = useNavigation();
  const effectiveTheme = useAtomValue(effectiveThemeAtom);
  const themeConfig = useAtomValue(themeConfigAtom);

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
      setMinimized(false);
      setKeyboardFocusRequested(true);
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
    return () => controller.stop();
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

  const current = pendingAccess[browseIndex] ?? pendingAccess[0] ?? null;
  const queueLength = pendingAccess.length;
  const canPrev = queueLength > 1 && browseIndex > 0;
  const canNext = queueLength > 1 && browseIndex < queueLength - 1;
  const currentCaller = current ? resolveCallerInfo(current) : null;
  const diffReview = current ? getDiffReviewPayload(current) : null;
  const payloadHashes = diffReview ? diffReviewPayloadHashes(diffReview) : null;

  useEffect(() => {
    setDecisionError((error) => (error && error.approvalId !== current?.approvalId ? null : error));
    // A new approval starts with an empty blob cache — payload hashes are
    // per-approval, and nothing should carry over between them.
    setBlobResults({});
    inFlightBlobsRef.current.clear();
  }, [current?.approvalId]);

  // Fetch one payload blob on the surface's behalf. Only hashes named in the
  // current approval's payload are fetchable; any other hash is ignored.
  const fetchBlob = (hash: string) => {
    if (!payloadHashes || !payloadHashes.has(hash)) return;
    if (blobResultsRef.current[hash] || inFlightBlobsRef.current.has(hash)) return;
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
  const resolveUserland = (choice: string) => {
    if (current?.kind !== "userland") return;
    runApprovalAction(current, () => shellApproval.resolveUserland(current.approvalId, choice));
  };
  const resolveExternalAgent = (behavior: "allow" | "deny") => {
    if (current?.kind !== "external-agent") return;
    runApprovalAction(current, () =>
      shellApproval.resolveExternalAgent(current.approvalId, behavior)
    );
  };
  const resolveMissionReview = (
    resolution:
      | { decision: "approve"; selectedAuthorityKeys: string[] }
      | { decision: "dismiss" }
  ) => {
    if (current?.kind !== "mission-review") return;
    runApprovalAction(current, () =>
      shellApproval.resolveMissionReview(current.approvalId, resolution)
    );
  };
  const runApprovalAction = (approval: PendingApproval, action: () => Promise<unknown>) => {
    if (submittingApprovalId) return;
    setDecisionError(null);
    setSubmittingApprovalId(approval.approvalId);
    void action()
      .catch((err: unknown) => {
        console.error("[ConsentApprovalBar] approval action failed:", err);
        setDecisionError({
          approvalId: approval.approvalId,
          message: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => setSubmittingApprovalId(null));
  };
  // Diff-review escape hatch: reuse the open gad-browser panel if one exists
  // (navigate it to the new target + focus), otherwise create one. The target
  // rides along as launch state-args the panel consumes on mount/param-change.
  const openInGadBrowser = (target: GadBrowserTarget) => {
    const stateArgs = { diffTarget: target };
    void (async () => {
      try {
        const [snapshot, profile] = await Promise.all([
          panel.getTreeSnapshot(),
          account.getProfile().catch(() => null),
        ]);
        // Reusing a colleague's panel changes their live navigation state. Only
        // reuse within the acting account's owner group; if identity is
        // temporarily unavailable, creating a fresh panel is the safe action.
        const ownRoots = profile
          ? (snapshot.forest.find((group) => group.owner === profile.userId)?.rootPanels ?? [])
          : [];
        const existing = findGadBrowserPanel(ownRoots);
        if (existing) {
          await panel.navigate(existing.id, GAD_BROWSER_SOURCE, { stateArgs });
          navigateToId(existing.id);
        } else {
          await panel.createPanel(GAD_BROWSER_SOURCE, { stateArgs });
        }
      } catch (err: unknown) {
        console.error("[ConsentApprovalBar] open-in-gad-browser failed:", err);
      }
    })();
  };

  const handleIntent = (payload: unknown) => {
    if (typeof payload !== "object" || payload === null) return;
    const candidate = payload as { type?: unknown; approvalId?: unknown };
    if (typeof candidate.type !== "string" || typeof candidate.approvalId !== "string") return;
    const intent = payload as ApprovalCardIntent;
    if (!current || intent.approvalId !== current.approvalId) return;
    switch (intent.type) {
      case "minimize":
        setMinimized(true);
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
        decide(intent.decision);
        return;
      case "device-cancel":
        decide("dismiss");
        return;
      case "submit-client-config":
        submitClientConfig(intent.values);
        return;
      case "submit-credential-input":
        submitCredentialInput(intent.values);
        return;
      case "submit-secret-input":
        submitSecretInput(intent.values);
        return;
      case "resolve-userland":
        resolveUserland(intent.choice);
        return;
      case "resolve-external-agent":
        resolveExternalAgent(intent.behavior);
        return;
      case "resolve-mission-review":
        resolveMissionReview(intent.resolution);
        return;
      case "fetch-blob":
        fetchBlob(intent.hash);
        return;
      case "open-in-gad-browser":
        openInGadBrowser(intent.target);
        return;
    }
  };

  // Secret-input + device-code flows want keyboard focus on open; others stay
  // hands-off so the panel keeps focus and remains clickable.
  const needsFocus =
    current?.kind === "client-config" ||
    current?.kind === "credential-input" ||
    current?.kind === "device-code";

  const theme: OverlayThemeInfo = {
    appearance: effectiveTheme,
    accentColor: themeConfig.accentColor,
    grayColor: themeConfig.grayColor,
    radius: themeConfig.radius,
    scaling: themeConfig.scaling,
    panelBackground: themeConfig.panelBackground,
  };

  const overlayOpen = current != null && !minimized && anchorBounds != null;
  useShellContentOverlay(
    overlayOpen && current && anchorBounds
      ? {
          surface: "approval-card",
          open: true,
          bounds: anchorBounds,
          focus: needsFocus || keyboardFocusRequested,
          theme,
          props: {
            approval: current,
            queue:
              queueLength > 1 ? { index: browseIndex, total: queueLength, canPrev, canNext } : null,
            decisionError:
              decisionError && decisionError.approvalId === current.approvalId
                ? decisionError.message
                : null,
            actionPending: submittingApprovalId === current.approvalId,
            diffReview,
            blobResults,
            appearance: effectiveTheme,
          },
        }
      : null,
    handleIntent
  );

  if (!current || !currentCaller) return null;
  // While expanded the card lives in the overlay surface — the chrome renders
  // nothing. Minimized, it shows the pill in the notifications strip.
  if (!minimized) return null;

  return (
    <ApprovalMinimizedPill
      approval={current}
      caller={currentCaller}
      tone={highestPendingTone(pendingAccess)}
      count={queueLength}
      attentionSeq={attentionSeq}
      onExpand={() => setMinimized(false)}
    />
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
        <Flex align="center" gap="1" style={{ flexShrink: 0, color: "var(--gray-11)" }}>
          <Text size="1" weight="medium">
            Review
          </Text>
          <ChevronRightIcon />
        </Flex>
      </button>
    </div>
  );
}
