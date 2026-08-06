import type { PendingApproval, PendingUnitInstallReviewApproval } from "./approvals.js";
import type { InstallReviewPart } from "./authority/unitInstallReview.js";
import type { HostTarget } from "./hostTargets.js";

/**
 * Which reviews the launch gate owns, and which the running workspace does
 * (docs/template-install-unit-approval-ux-plan.md §7.6).
 *
 * Client apps and extensions are decided before the workspace UI exists, in a
 * host-owned window and in the terminal. That surface cannot be replaced by the
 * collection route for a simple reason: `apps/shell` is itself under review, so
 * it cannot render its own approval. Everything else — panels, workers, and the
 * templates that ship them — is reviewed inside the workspace.
 */

function isLaunchGatePart(part: InstallReviewPart): boolean {
  return part.kind === "app" || part.kind === "extension";
}

export function isBootstrapUnitApproval(
  approval: PendingApproval
): approval is PendingUnitInstallReviewApproval {
  return (
    approval.kind === "unit-install-review" &&
    approval.parts.length > 0 &&
    approval.parts.every(isLaunchGatePart)
  );
}

export function filterBootstrapApprovals(
  approvals: PendingApproval[]
): PendingUnitInstallReviewApproval[] {
  return approvals.filter(isBootstrapUnitApproval);
}

/**
 * Approvals that belong to the already-running workspace surface.
 *
 * A launch-gate decision is handled out-of-band by bootstrap, not by the
 * generic consent queue inside whichever app happens to be running — an app
 * cannot host the decision about whether that app may run.
 */
export function filterRuntimeApprovals(approvals: PendingApproval[]): PendingApproval[] {
  return approvals.filter(
    (approval) =>
      !(isBootstrapUnitApproval(approval) && approval.parts.some((part) => part.kind === "app"))
  );
}

/**
 * Each host target reviews its own client app and the extensions that target
 * requires — never another target's, which the person in front of this device
 * has no way to evaluate and no reason to be asked about.
 */
export function isBootstrapHostTargetApproval(
  approval: PendingApproval,
  target: HostTarget,
  requiredExtensionSources: readonly string[] = []
): approval is PendingUnitInstallReviewApproval {
  if (!isBootstrapUnitApproval(approval)) return false;
  const required = new Set(requiredExtensionSources);
  return approval.parts.some(
    (part) =>
      (part.kind === "app" && part.target === target) ||
      (part.kind === "extension" && required.has(part.repoPath))
  );
}

export function filterBootstrapApprovalsForTarget(
  approvals: PendingApproval[],
  target: HostTarget,
  requiredExtensionSources: readonly string[] = []
): PendingUnitInstallReviewApproval[] {
  return approvals.filter((approval): approval is PendingUnitInstallReviewApproval =>
    isBootstrapHostTargetApproval(approval, target, requiredExtensionSources)
  );
}
