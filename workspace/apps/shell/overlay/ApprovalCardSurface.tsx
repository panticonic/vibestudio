/**
 * The "approval-card" overlay surface: hosts the presentational `ApprovalCard`
 * inside the content overlay. It derives the caller from the approval and
 * forwards card intents up to the chrome via `emitIntent`. No RPC — the chrome
 * coordinator (`ConsentApprovalBar`) performs the actual `shellApproval.*` calls.
 *
 * Diff review (P3.5): the surface has no RPC, so it fetches diff blobs through a
 * request/response over the intent + props channel — it emits a `fetch-blob`
 * intent for a content hash and resolves the pending promise when the chrome
 * pushes the result back down in `blobResults`. This is the `DiffContentFetcher`
 * the shared `DiffViewer` consumes.
 */
import { useCallback, useEffect, useRef } from "react";
import type { DiffContentFetcher, DiffReviewEntry } from "@workspace/ui";
import { ApprovalCard } from "../components/ApprovalCard";
import {
  resolveCallerInfo,
  type ApprovalQueueInfo,
  type BlobResult,
} from "../components/approvalCardModel";
import type { PendingApproval } from "@vibestudio/shared/approvals";
import type { OverlaySurfaceComponentProps } from "./types";

export interface ApprovalCardSurfaceProps {
  approval: PendingApproval;
  queue: ApprovalQueueInfo | null;
  decisionError: string | null;
  /** P3.5 diff-review payload (null when the approval carries no diff). */
  diffReview?: DiffReviewEntry[] | null;
  /** Chrome-pushed blob cache, keyed by content hash. */
  blobResults?: Record<string, BlobResult>;
  /** Chrome appearance, for the diff viewer's syntax theme. */
  appearance?: "light" | "dark";
}

function isApprovalCardSurfaceProps(value: unknown): value is ApprovalCardSurfaceProps {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { approval?: unknown }).approval === "object" &&
    (value as { approval?: { approvalId?: unknown } }).approval?.approvalId !== undefined
  );
}

export function ApprovalCardSurface({ props, emitIntent }: OverlaySurfaceComponentProps) {
  if (!isApprovalCardSurfaceProps(props)) return null;
  return <ApprovalCardSurfaceInner {...props} emitIntent={emitIntent} />;
}

type Waiter = { resolve: (value: string) => void; reject: (reason: Error) => void };

function ApprovalCardSurfaceInner({
  approval,
  queue,
  decisionError,
  diffReview,
  blobResults,
  appearance,
  emitIntent,
}: ApprovalCardSurfaceProps & { emitIntent: (payload: unknown) => void }) {
  const caller = resolveCallerInfo(approval);
  const approvalId = approval.approvalId;

  // Stable refs so the fetcher/effect always see the freshest inputs without
  // re-identifying the fetcher passed into the viewer.
  const blobsRef = useRef<Record<string, BlobResult>>(blobResults ?? {});
  blobsRef.current = blobResults ?? {};
  const emitRef = useRef(emitIntent);
  emitRef.current = emitIntent;
  const pendingRef = useRef<Map<string, Waiter[]>>(new Map());

  // Resolve any pending fetches whose result has now arrived in blobResults.
  useEffect(() => {
    const results = blobResults ?? {};
    for (const [hash, waiters] of Array.from(pendingRef.current.entries())) {
      const result = results[hash];
      if (!result) continue;
      pendingRef.current.delete(hash);
      for (const waiter of waiters) resolveWaiter(waiter, result);
    }
  }, [blobResults]);

  const fetchContent = useCallback<DiffContentFetcher>(
    (hash) =>
      new Promise<string>((resolve, reject) => {
        const existing = blobsRef.current[hash];
        if (existing) {
          resolveWaiter({ resolve, reject }, existing);
          return;
        }
        const waiters = pendingRef.current.get(hash) ?? [];
        waiters.push({ resolve, reject });
        pendingRef.current.set(hash, waiters);
        emitRef.current({ type: "fetch-blob", hash, approvalId });
      }),
    [approvalId]
  );

  return (
    <ApprovalCard
      key={approvalId}
      approval={approval}
      caller={caller}
      queue={queue}
      decisionError={decisionError}
      diffReview={diffReview ?? null}
      fetchContent={fetchContent}
      appearance={appearance ?? "light"}
      emit={(intent) => emitIntent(intent)}
    />
  );
}

function resolveWaiter(waiter: Waiter, result: BlobResult): void {
  if ("text" in result) {
    waiter.resolve(result.text);
  } else if ("error" in result) {
    waiter.reject(new Error(result.error));
  } else {
    waiter.reject(new Error("Content unavailable"));
  }
}
