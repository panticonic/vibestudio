/**
 * Reading a `review-pending` outcome on the client side
 * (docs/template-install-unit-approval-ux-plan.md U6).
 *
 * While a review covering a unit is unresolved, that unit's gated leaves are not
 * acquirable and every one of them resolves to the same typed outcome naming the
 * same open review. U6 asks for two things from that: one recoverable error, and
 * a UI that points at the review already waiting.
 *
 * Only the first half lived in the runtime. Every surface caught the error the
 * way it catches a failure — `Notifications could not be loaded: [workers.resolveService]
 * apps/shell is waiting on the review you already have open`, in an amber bar,
 * next to a Retry that could only fail again. Nothing was broken and nothing
 * needed retrying; the workspace was waiting on a question the person had not
 * answered yet, and no surface said so.
 *
 * This is the shared reader for that outcome, so a surface can tell "waiting on
 * you" apart from "went wrong" without knowing anything about authority.
 */

/** An open review that answers this call, ready to render. */
export interface PendingReviewNotice {
  approvalId: string;
  /** The review's own title, e.g. `what's in your workspace`. */
  title: string;
  /** One calm sentence. Not an error: nothing has gone wrong. */
  message: string;
}

interface CodedError {
  code?: unknown;
  errorCode?: unknown;
  data?: unknown;
  errorData?: unknown;
  cause?: unknown;
}

/**
 * The typed outcome, or null when this is an ordinary failure.
 *
 * Deliberately tolerant about shape: the same outcome is read in-process from a
 * thrown `ServiceAccessError`, and across the wire from whatever the RPC client
 * reconstructed. Both carry the code and the failure payload; neither is
 * guaranteed to carry them in the same place.
 */
export function pendingReviewNotice(error: unknown): PendingReviewNotice | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as CodedError;
  if (!hasReviewPendingCode(candidate)) return null;
  const review = findReview(candidate);
  if (!review) return null;
  return {
    approvalId: review.approvalId,
    title: review.title,
    message: `Waiting for you to finish reviewing ${review.title}.`,
  };
}

/** True for a `review-pending` outcome even when its payload did not survive. */
export function isReviewPending(error: unknown): boolean {
  return typeof error === "object" && error !== null && hasReviewPendingCode(error as CodedError);
}

function hasReviewPendingCode(error: CodedError): boolean {
  for (const candidate of payloads(error)) {
    // `code` on a reconstructed error, `errorCode` on the raw wire response —
    // the same field under the two names it travels by. Never the message: a
    // caller that parses prose is one wording change from silently deciding
    // that nothing is pending.
    if (candidate["code"] === "EREVIEWPENDING") return true;
    if (candidate["errorCode"] === "EREVIEWPENDING") return true;
    // Some RPC boundaries preserve the structured authority payload while
    // dropping the convenience error code. `reasonCode` is the canonical
    // domain discriminator, not prose, so it is equally safe to recognize.
    const failure = candidate["authorityFailure"];
    if (
      typeof failure === "object" &&
      failure !== null &&
      (failure as Record<string, unknown>)["reasonCode"] === "review-pending"
    ) {
      return true;
    }
  }
  return false;
}

function findReview(error: CodedError): { approvalId: string; title: string } | null {
  for (const candidate of payloads(error)) {
    const failure = (candidate as { authorityFailure?: unknown }).authorityFailure;
    if (typeof failure !== "object" || failure === null) continue;
    const remediation = (failure as { remediation?: unknown }).remediation;
    if (typeof remediation !== "object" || remediation === null) continue;
    const review = (remediation as { review?: unknown }).review;
    if (typeof review !== "object" || review === null) continue;
    const { approvalId, title } = review as { approvalId?: unknown; title?: unknown };
    if (typeof approvalId === "string" && typeof title === "string") {
      return { approvalId, title };
    }
  }
  return null;
}

/** The error itself and every nested envelope an RPC hop may have wrapped it in. */
function payloads(error: CodedError): Array<Record<string, unknown>> {
  const seen: Array<Record<string, unknown>> = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    if (seen.includes(record)) return;
    seen.push(record);
    visit(record["data"], depth + 1);
    visit(record["errorData"], depth + 1);
    visit(record["cause"], depth + 1);
  };
  visit(error, 0);
  return seen;
}
