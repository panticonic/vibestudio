import type { PendingUnitInstallReviewApproval } from "@vibestudio/shared/approvals";

type Code = { repoPath: string; effectiveVersion: string };
type Review = Pick<PendingUnitInstallReviewApproval, "approvalId" | "title"> & {
  parts: readonly Code[];
};
type OpenReview = { approvalId: string; title: string };

export const unitReviewCodeKey = (code: Code): string =>
  `${code.repoPath}@${code.effectiveVersion}`;

/** Running launch-gate code must keep presenting reviews; unavailable code may explain its exact open review. */
export function createOpenUnitReviewLookup(deps: {
  listPendingReviews(): readonly Review[];
  isLaunchGateRepoPath(repoPath: string): boolean;
  creationReviewOwed(): boolean;
  creationReviewUnits(): ReadonlySet<string> | null;
  hasVersion(repoPath: string, effectiveVersion: string): boolean;
}) {
  const forUnavailableCode = (code: Code): OpenReview | null => {
    for (const pending of deps.listPendingReviews()) {
      if (
        pending.parts.some(
          (part) =>
            part.repoPath === code.repoPath && part.effectiveVersion === code.effectiveVersion
        )
      ) {
        return { approvalId: pending.approvalId, title: pending.title };
      }
    }
    // Creation review never covers units admitted by the separate launch gate.
    if (deps.isLaunchGateRepoPath(code.repoPath) || !deps.creationReviewOwed()) return null;
    const units = deps.creationReviewUnits();
    const owed = units
      ? units.has(unitReviewCodeKey(code))
      : !deps.hasVersion(code.repoPath, code.effectiveVersion);
    return owed
      ? { approvalId: "workspace-creation-review", title: "what's in your workspace" }
      : null;
  };
  return {
    forUnavailableCode,
    // Already running apps/extensions must not be blocked by a later review
    // that the host's own presentation surface needs them to display.
    forRunningCode: (code: Code): OpenReview | null =>
      deps.isLaunchGateRepoPath(code.repoPath) ? null : forUnavailableCode(code),
  };
}
