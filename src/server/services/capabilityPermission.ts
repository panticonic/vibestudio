import type { PendingCapabilityApproval } from "@natstack/shared/approvals";
import {
  PANEL_AUTOMATE_CAPABILITY,
  PANEL_STRUCTURAL_CAPABILITY,
} from "@natstack/shared/panelAccessPolicy";
import type { VerifiedCaller } from "@natstack/shared/serviceDispatcher";
import type { ApprovalQueue, GrantedDecision } from "./approvalQueue.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";

/**
 * Canonical capability name guarding cross-context durable-object entity access.
 * Re-exported here so callers can import the constant from the capability
 * permission module rather than redefining it.
 */
export const RUNTIME_CROSS_CONTEXT_ENTITY = "runtime.crossContextEntity" as const;

export interface CapabilityPermissionResource {
  type: string;
  label: string;
  value: string;
  /**
   * Stable grant key. Defaults to value so existing grants remain readable and
   * call sites can choose human-readable keys for non-URL resources.
   */
  key?: string;
}

export function panelCapabilityResourceKey(
  targetPanelId: string,
  requesterEntityId: string
): string {
  return `panel:${targetPanelId}:requester:${requesterEntityId}`;
}

export interface CapabilityPermissionRequest {
  caller: VerifiedCaller;
  capability: string;
  severity?: PendingCapabilityApproval["severity"];
  dedupKey?: string | null;
  signal?: AbortSignal;
  resource: CapabilityPermissionResource;
  title: string;
  description?: string;
  details?: PendingCapabilityApproval["details"];
  deniedReason: string;
}

export interface CapabilityPermissionDeps {
  approvalQueue: ApprovalQueue;
  grantStore: CapabilityGrantStore;
}

export interface CapabilityPermissionResult {
  allowed: boolean;
  reason?: string;
  decision?: Exclude<GrantedDecision, "deny">;
}

export async function requestCapabilityPermission(
  deps: CapabilityPermissionDeps,
  request: CapabilityPermissionRequest
): Promise<CapabilityPermissionResult> {
  const callerKind = normalizeCallerKind(request.caller.runtime.kind);
  if (!callerKind) {
    return {
      allowed: false,
      reason: "Capability caller is not a panel, worker, or durable object",
    };
  }

  const identity = request.caller.code;
  if (!identity) {
    return { allowed: false, reason: `Unknown capability caller: ${request.caller.runtime.id}` };
  }

  const resourceKey = request.resource.key ?? request.resource.value;
  const dedupKey =
    request.dedupKey === undefined && isPanelCapability(request.capability)
      ? `panel-capability:${request.capability}:${resourceKey}`
      : request.dedupKey;
  if (deps.grantStore.hasGrant(request.capability, resourceKey, identity)) {
    return { allowed: true };
  }

  const decision = await deps.approvalQueue.request({
    kind: "capability",
    callerId: request.caller.runtime.id,
    callerKind,
    repoPath: identity.repoPath,
    effectiveVersion: identity.effectiveVersion,
    capability: request.capability,
    severity: request.severity,
    dedupKey,
    title: request.title,
    description: request.description,
    resource: {
      type: request.resource.type,
      label: request.resource.label,
      value: request.resource.value,
    },
    grantResourceKey: resourceKey,
    details: request.details,
    signal: request.signal,
  });
  if (decision === "deny") {
    return { allowed: false, reason: request.deniedReason };
  }
  if (decision !== "once") {
    deps.grantStore.grant(request.capability, resourceKey, identity, decision);
    if (typeof deps.approvalQueue.resolveMatching === "function") {
      deps.approvalQueue.resolveMatching((approval) => {
        if (approval.kind !== "capability") return false;
        const pendingResourceKey = approval.grantResourceKey ?? approval.resource?.value;
        if (approval.capability !== request.capability || pendingResourceKey !== resourceKey) {
          return false;
        }
        if (decision === "session") return approval.callerId === request.caller.runtime.id;
        if (decision === "repo") return approval.repoPath === identity.repoPath;
        return (
          approval.repoPath === identity.repoPath &&
          approval.effectiveVersion === identity.effectiveVersion
        );
      }, "once");
    }
  }
  return { allowed: true, decision };
}

export function normalizeCallerKind(kind: string): "panel" | "worker" | "do" | null {
  if (kind === "panel" || kind === "worker" || kind === "do") {
    return kind;
  }
  return null;
}

function isPanelCapability(capability: string): boolean {
  return capability === PANEL_AUTOMATE_CAPABILITY || capability === PANEL_STRUCTURAL_CAPABILITY;
}
