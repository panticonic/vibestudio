import type { PendingApproval, PendingUnitBatchApproval } from "./approvals.js";
import type { HostTarget } from "./hostTargets.js";

export function isBootstrapUnitApproval(
  approval: PendingApproval
): approval is PendingUnitBatchApproval {
  return (
    approval.kind === "unit-batch" &&
    approval.units.length > 0 &&
    approval.units.every((unit) => unit.unitKind === "app" || unit.unitKind === "extension") &&
    (approval.trigger === "startup" ||
      (approval.trigger === "meta-change" && approval.units.every((unit) => unit.unitKind === "app")))
  );
}

export function filterBootstrapApprovals(approvals: PendingApproval[]): PendingUnitBatchApproval[] {
  return approvals.filter(isBootstrapUnitApproval);
}

/**
 * Approvals that belong to the already-running workspace surface. Host-target
 * app startup approvals are handled out-of-band by bootstrap/pairing, not by
 * the generic consent queue inside whichever app happens to be running. Meta
 * pushes stay visible to the running shell because those are live workspace
 * config changes.
 */
export function filterRuntimeApprovals(approvals: PendingApproval[]): PendingApproval[] {
  return approvals.filter(
    (approval) => !(isBootstrapUnitApproval(approval) && approval.trigger === "startup")
  );
}

export function isBootstrapHostTargetApproval(
  approval: PendingApproval,
  target: HostTarget
): approval is PendingUnitBatchApproval {
  if (!isBootstrapUnitApproval(approval)) return false;
  if (approval.trigger === "startup") return true;
  return (
    approval.units.length > 0 &&
    approval.units.every((unit) => unit.unitKind === "app") &&
    approval.units.every((unit) => unit.target === target)
  );
}

export function filterBootstrapApprovalsForTarget(
  approvals: PendingApproval[],
  target: HostTarget
): PendingUnitBatchApproval[] {
  return approvals.filter((approval): approval is PendingUnitBatchApproval =>
    isBootstrapHostTargetApproval(approval, target)
  );
}
