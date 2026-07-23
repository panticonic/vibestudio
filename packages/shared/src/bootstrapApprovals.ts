import type { PendingApproval, PendingUnitBatchApproval } from "./approvals.js";
import type { HostTarget } from "./hostTargets.js";

export function isBootstrapUnitApproval(
  approval: PendingApproval
): approval is PendingUnitBatchApproval {
  return (
    approval.kind === "unit-batch" &&
    approval.units.length > 0 &&
    ((approval.trigger === "startup" &&
      approval.units.some((unit) => unit.unitKind === "app" || unit.unitKind === "extension")) ||
      (approval.trigger === "meta-change" &&
        approval.units.every((unit) => unit.unitKind === "app")))
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
    (approval) =>
      !(
        isBootstrapUnitApproval(approval) &&
        approval.trigger === "startup" &&
        approval.units.some((unit) => unit.unitKind === "app")
      )
  );
}

export function isBootstrapHostTargetApproval(
  approval: PendingApproval,
  target: HostTarget,
  requiredExtensionSources: readonly string[] = []
): approval is PendingUnitBatchApproval {
  if (!isBootstrapUnitApproval(approval)) return false;
  if (approval.trigger === "startup") {
    const required = new Set(requiredExtensionSources);
    return approval.units.some(
      (unit) =>
        (unit.unitKind === "app" && unit.target === target) ||
        (unit.unitKind === "extension" && required.has(unit.source.repo))
    );
  }
  return (
    approval.units.length > 0 &&
    approval.units.every((unit) => unit.unitKind === "app") &&
    approval.units.every((unit) => unit.target === target)
  );
}

export function filterBootstrapApprovalsForTarget(
  approvals: PendingApproval[],
  target: HostTarget,
  requiredExtensionSources: readonly string[] = []
): PendingUnitBatchApproval[] {
  return approvals.filter((approval): approval is PendingUnitBatchApproval =>
    isBootstrapHostTargetApproval(approval, target, requiredExtensionSources)
  );
}
