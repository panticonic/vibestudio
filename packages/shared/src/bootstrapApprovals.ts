import type { PendingApproval, PendingUnitInstallReviewApproval } from "./approvals.js";
import type { InstallReviewPart } from "./authority/unitInstallReview.js";
import type { HostTarget } from "./hostTargets.js";

/**
 * Which reviews a launch gate needs before starting a client
 * (docs/template-install-unit-approval-ux-plan.md §7.6).
 *
 * Before a client is admitted, a host-owned window or terminal presents its
 * review. A startup review is atomic, including any panels or workers batched
 * with that client. Once a client is running it can present every pending review:
 * app kind alone never establishes that a launch gate is currently presenting it.
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
    approval.parts.some(isLaunchGatePart)
  );
}

export function filterBootstrapApprovals(
  approvals: PendingApproval[]
): PendingUnitInstallReviewApproval[] {
  return approvals.filter(isBootstrapUnitApproval);
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
