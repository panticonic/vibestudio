/**
 * The "approval-card" overlay surface: hosts the presentational `ApprovalCard`
 * inside the content overlay. It derives the caller from the approval and
 * forwards card intents up to the chrome via `emitIntent`. No RPC — the chrome
 * coordinator (`ConsentApprovalBar`) performs the actual `shellApproval.*` calls.
 */
import type { PendingApproval } from "@natstack/shared/approvals";
import { ApprovalCard } from "../components/ApprovalCard";
import { resolveCallerInfo, type ApprovalQueueInfo } from "../components/approvalCardModel";
import type { OverlaySurfaceComponentProps } from "./types";

export interface ApprovalCardSurfaceProps {
  approval: PendingApproval;
  queue: ApprovalQueueInfo | null;
  decisionError: string | null;
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
  const caller = resolveCallerInfo(props.approval);
  return (
    <ApprovalCard
      key={props.approval.approvalId}
      approval={props.approval}
      caller={caller}
      queue={props.queue}
      decisionError={props.decisionError}
      emit={(intent) => emitIntent(intent)}
    />
  );
}
