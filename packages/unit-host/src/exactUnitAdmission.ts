import { ServiceAccessError } from "@vibestudio/shared/serviceDispatcher";

export interface ExactUnitAdmissionReview {
  approvalId: string;
  title: string;
}

/** Enforce consent for the exact immutable image at a native execution boundary. */
export function requireExactUnitAdmission(input: {
  service: string;
  operation: string;
  unitLabel: string;
  name: string;
  repoPath: string;
  effectiveVersion: string;
  isAdmitted?: (repoPath: string, effectiveVersion: string) => boolean;
  openReviewFor?: (code: {
    repoPath: string;
    effectiveVersion: string;
  }) => ExactUnitAdmissionReview | null;
}): void {
  if (!input.isAdmitted || input.isAdmitted(input.repoPath, input.effectiveVersion)) return;

  const review = input.openReviewFor?.({
    repoPath: input.repoPath,
    effectiveVersion: input.effectiveVersion,
  });
  if (review) {
    const reason = `Waiting for you to finish reviewing ${review.title}.`;
    throw new ServiceAccessError(input.service, input.operation, reason, "EREVIEWPENDING", {
      authorityFailure: {
        reasonCode: "review-pending",
        reason,
        remediation: {
          kind: "resolve-open-review",
          message: "Finish the review that is already open, then retry the exact invocation.",
          review,
        },
      },
    });
  }

  const reason = `This version of ${input.name} (${input.repoPath}@${input.effectiveVersion}) needs your review before it can run.`;
  throw new ServiceAccessError(input.service, input.operation, reason, "EACCES", {
    authorityFailure: {
      reasonCode: "approval-required",
      reason,
      remediation: {
        kind: "request-user-approval",
        message: `Review ${input.name} in the approvals list, accept it if you trust it, then open it again.`,
      },
    },
  });
}
