import type { InvocationCardPayloadLike } from "./_helpers.js";

export type ManagedUnitSection = "apps" | "extensions" | "panels";

export interface ManagedMutationEvidence {
  index: number;
  contextId: string;
  applicationId: string;
  unit: string;
}

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function workspacePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const segments = value.replaceAll("\\", "/").split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return segments.join("/");
}

export function unitForPath(value: unknown, section: ManagedUnitSection): string | null {
  const path = workspacePath(value);
  if (!path) return null;
  const segments = path.split("/");
  return segments[0] === section && segments.length >= 2 ? `${segments[0]}/${segments[1]}` : null;
}

export function successfulToolDetails(
  call: InvocationCardPayloadLike,
  name: string
): Record<string, unknown> | null {
  if (
    call.name !== name ||
    call.execution?.status !== "complete" ||
    call.execution.isError === true
  ) {
    return null;
  }
  const envelope = record(call.execution.result);
  return envelope ? (record(envelope["details"]) ?? envelope) : null;
}

export function managedMutation(
  call: InvocationCardPayloadLike,
  index: number,
  section: ManagedUnitSection
): ManagedMutationEvidence | null {
  const details = successfulToolDetails(call, call.name);
  if (!details) return null;
  const paths =
    call.name === "apply_patch"
      ? details["status"] === "applied" && stringArray(details["paths"])
        ? details["paths"]
        : null
      : call.name === "edit" || call.name === "write"
        ? [call.arguments?.["path"] ?? details["path"]]
        : null;
  if (!paths || paths.length === 0) return null;

  const vcsResult = record(details["vcsResult"]);
  const contextId = vcsResult?.["contextId"];
  const applicationId = vcsResult?.["applicationId"];
  const workingHead = record(vcsResult?.["workingHead"]);
  const units = new Set(paths.map((path) => unitForPath(path, section)));
  if (
    typeof contextId !== "string" ||
    typeof applicationId !== "string" ||
    workingHead?.["kind"] !== "application" ||
    workingHead["applicationId"] !== applicationId ||
    typeof vcsResult?.["changeCount"] !== "number" ||
    vcsResult["changeCount"] < 1 ||
    units.size !== 1 ||
    units.has(null)
  ) {
    return null;
  }
  return { index, contextId, applicationId, unit: [...units][0]! };
}

export function verificationMatches(
  call: InvocationCardPayloadLike,
  operation: "test" | "build",
  unit: string,
  contextId: string
): boolean {
  if (
    call.arguments?.["operation"] !== operation ||
    workspacePath(call.arguments?.["target"]) !== unit
  ) {
    return false;
  }
  const details = successfulToolDetails(call, "verify");
  if (
    details?.["operation"] !== operation ||
    workspacePath(details["target"]) !== unit ||
    details["status"] !== (operation === "test" ? "passed" : "ok")
  ) {
    return false;
  }
  if (operation === "test") {
    const report = record(details["report"]);
    return (
      report?.["contextId"] === contextId &&
      workspacePath(report["target"]) === unit &&
      typeof report["total"] === "number" &&
      report["total"] > 0 &&
      report["failed"] === 0
    );
  }
  const receipt = record(details["receipt"]);
  const receiptUnit = record(receipt?.["unit"]);
  return (
    receipt?.["protocol"] === "build-verification-receipt.v1" &&
    receipt["contextId"] === contextId &&
    receipt["ref"] === `ctx:${contextId}` &&
    workspacePath(receipt["target"]) === unit &&
    receipt["status"] === "ok" &&
    workspacePath(receiptUnit?.["repoPath"]) === unit
  );
}

export function eventRef(value: unknown, eventId: string): boolean {
  const ref = record(value);
  return ref?.["kind"] === "event" && ref["eventId"] === eventId;
}

export function zeroWorkingCounts(value: unknown): boolean {
  const counts = record(value);
  return counts?.["applications"] === 0 && counts["workUnits"] === 0 && counts["changes"] === 0;
}
