import type {
  ApprovalDecision,
  ApprovalOperationDescriptor,
  ApprovalRequesterCategory,
  ApprovalResourceScope,
  DiffReviewEntry,
  PendingCapabilityApproval,
} from "@vibestudio/shared/approvals";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { ApprovalQueue, CapabilityGrantedDecision, GrantedDecision } from "./approvalQueue.js";
import type { CapabilityGrantStore, CapabilityGrantSubject } from "./capabilityGrantStore.js";
import { parseSha256 } from "@vibestudio/shared/execution/identity";

export const NETWORK_ALL_RESOURCE_KEY = "network:*" as const;

/**
 * Apply operation-specific decision policy to the decisions an authority
 * acquisition would ordinarily offer. Keeping this intersection at the
 * authority broker means every UI and transport receives the same contract.
 */
export function constrainApprovalDecisions(
  candidates: readonly ApprovalDecision[],
  allowed: readonly ApprovalDecision[] | undefined
): ApprovalDecision[] {
  const permitted = allowed ? new Set(allowed) : null;
  return [...new Set(candidates)].filter((decision) => permitted?.has(decision) ?? true);
}

export interface CapabilityPermissionResource {
  type: string;
  label: string;
  value: string;
  /**
   * Stable grant key. Defaults to value so existing grants remain readable and
   * call sites can choose human-readable keys for non-URL resources.
   */
  key?: string;
  scope?: ApprovalResourceScope;
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
  requesterCategory?: ApprovalRequesterCategory;
  operation?: ApprovalOperationDescriptor;
  signal?: AbortSignal;
  resource: CapabilityPermissionResource;
  title: string;
  description?: string;
  details?: PendingCapabilityApproval["details"];
  /** Host-computed diff-review payload (narrow-host-vcs-plan §5.1) surfaced on
   *  the pending approval. */
  diffReview?: DiffReviewEntry[];
  deniedReason: string;
  allowedDecisions?: PendingCapabilityApproval["allowedDecisions"];
  /** Authenticated authority-session identity. Defaults to the concrete
   * runtime id for ordinary code calls; eval supplies its live host session. */
  authoritySessionId?: string;
}

export interface CapabilityPermissionDeps {
  approvalQueue: ApprovalQueue;
  grantStore: CapabilityGrantStore;
}

/**
 * Ordinary service calls are scoped to the authenticated runtime incarnation.
 * Reusing this identity for both the authority context and approval persistence
 * makes a session decision immediately effective and reusable by that runtime.
 */
export function authoritySessionIdForCaller(caller: VerifiedCaller): string {
  return caller.runtime.id;
}

export type CapabilityPermissionResult =
  | {
      allowed: true;
      decision?: Exclude<CapabilityGrantedDecision, "deny" | "dismiss">;
    }
  | {
      allowed: false;
      reason: string;
      decision?: "deny" | "dismiss";
    };

export async function requestCapabilityPermission(
  deps: CapabilityPermissionDeps,
  request: CapabilityPermissionRequest
): Promise<CapabilityPermissionResult> {
  const callerKind = request.caller.runtime.kind;
  if (request.caller.code) {
    try {
      parseSha256(request.caller.code.executionDigest, "capability caller execution digest");
    } catch (error) {
      return {
        allowed: false,
        reason: error instanceof Error ? error.message : "Capability caller has no exact artifact",
      };
    }
  }
  const subject = capabilityGrantSubject(
    request.caller,
    request.authoritySessionId ?? authoritySessionIdForCaller(request.caller)
  );
  if (!subject) {
    return { allowed: false, reason: `Unknown capability caller: ${request.caller.runtime.id}` };
  }
  const identity = request.caller.code;

  const resourceKey = request.resource.key ?? request.resource.value;
  const resourceScope = request.resource.scope ?? exactResourceScope(resourceKey);
  const dedupKey = request.dedupKey;
  if (deps.grantStore.hasGrant(request.capability, resourceKey, subject, resourceScope)) {
    return { allowed: true };
  }
  if (deps.grantStore.hasDenial(request.capability, resourceKey, subject, resourceScope)) {
    return { allowed: false, reason: `${request.deniedReason} (blocked in Permissions)` };
  }

  const decision = await deps.approvalQueue.requestCapability({
    kind: "capability",
    callerId: request.caller.runtime.id,
    callerKind,
    authoritySubject: subject.principal,
    authoritySessionId: subject.sessionId,
    ...(request.caller.subject ? { requestedByUserId: request.caller.subject.userId } : {}),
    ...(identity ? { repoPath: identity.repoPath, executionDigest: identity.executionDigest } : {}),
    capability: request.capability,
    severity: request.severity,
    dedupKey,
    ...(request.requesterCategory ? { requesterCategory: request.requesterCategory } : {}),
    ...(request.operation ? { operation: request.operation } : {}),
    title: request.title,
    description: request.description,
    resource: {
      type: request.resource.type,
      label: request.resource.label,
      value: request.resource.value,
    },
    resourceScope,
    grantResourceKey: resourceKey,
    details: request.details,
    allowedDecisions: request.allowedDecisions?.filter(
      (decision) => decision !== "version" || identity !== undefined
    ),
    ...(request.diffReview ? { diffReview: request.diffReview } : {}),
    signal: request.signal,
  });
  if (decision === "deny" || decision === "dismiss") {
    return {
      allowed: false,
      decision,
      reason: decision === "dismiss" ? "Approval was dismissed" : request.deniedReason,
    };
  }
  if (decision !== "once" && decision !== "run") {
    const reusableDecision = decision as Exclude<GrantedDecision, "once" | "deny">;
    const grantIntent = resourceGrantIntentForDecision(
      request.capability,
      resourceKey,
      resourceScope,
      reusableDecision
    );
    deps.grantStore.grant(
      request.capability,
      grantIntent.resourceKey,
      subject,
      reusableDecision,
      grantIntent.resourceScope,
      Date.now(),
      "allow",
      request.caller.subject ? (`user:${request.caller.subject.userId}` as const) : undefined,
      "interactive-capability-approval"
    );
    if (typeof deps.approvalQueue.resolveMatching === "function") {
      deps.approvalQueue.resolveMatching((approval) => {
        if (approval.kind !== "capability") return false;
        const pendingResourceKey = approval.grantResourceKey ?? approval.resource?.value;
        if (!pendingResourceKey) return false;
        return deps.grantStore.hasGrant(
          approval.capability,
          pendingResourceKey,
          capabilityGrantSubjectFromApproval(approval),
          approval.resourceScope
        );
      }, "once");
    }
  }
  return { allowed: true, decision };
}

/** True if a non-prompting grant already covers this capability/resource for the caller. */
export function capabilityAlreadyGranted(
  deps: CapabilityPermissionDeps,
  caller: VerifiedCaller,
  capability: string,
  resource: CapabilityPermissionResource
): boolean {
  const subject = capabilityGrantSubject(caller, authoritySessionIdForCaller(caller));
  if (!subject) return false;
  const resourceKey = resource.key ?? resource.value;
  return deps.grantStore.hasGrant(
    capability,
    resourceKey,
    subject,
    resource.scope ?? exactResourceScope(resourceKey)
  );
}

export function normalizeCallerKind(
  kind: string
): "panel" | "app" | "worker" | "do" | "extension" | null {
  if (
    kind === "panel" ||
    kind === "app" ||
    kind === "worker" ||
    kind === "do" ||
    kind === "extension"
  ) {
    return kind;
  }
  return null;
}

export function capabilityGrantSubject(
  caller: VerifiedCaller,
  sessionId: string
): CapabilityGrantSubject | null {
  if (caller.code) {
    try {
      parseSha256(caller.code.executionDigest, "capability caller execution digest");
    } catch {
      return null;
    }
    return {
      principal: `code:${caller.code.repoPath}@${caller.code.executionDigest}`,
      sessionId,
      code: {
        repoPath: caller.code.repoPath,
        executionDigest: caller.code.executionDigest,
      },
    };
  }
  if (caller.hostOriginated) return { principal: "host:product", sessionId };
  if (caller.subject && caller.subject.userId !== "system") {
    return { principal: `user:${caller.subject.userId}`, sessionId };
  }
  if (caller.agentBinding) {
    return { principal: `entity:${caller.agentBinding.entityId}`, sessionId };
  }
  return null;
}

export function capabilityGrantSubjectFromApproval(
  approval: PendingCapabilityApproval
): CapabilityGrantSubject {
  if (!approval.authoritySubject) {
    throw new Error("Pending capability approval has no canonical authority subject");
  }
  if (approval.repoPath && approval.executionDigest) {
    return {
      principal: approval.authoritySubject,
      sessionId: approval.authoritySessionId ?? approval.callerId,
      code: { repoPath: approval.repoPath, executionDigest: approval.executionDigest },
    };
  }
  return {
    principal: approval.authoritySubject,
    sessionId: approval.authoritySessionId ?? approval.callerId,
  };
}

function exactResourceScope(key: string): ApprovalResourceScope {
  return { kind: "exact", key };
}

function resourceGrantIntentForDecision(
  capability: string,
  resourceKey: string,
  resourceScope: ApprovalResourceScope,
  decision: Exclude<GrantedDecision, "once" | "deny">
): { resourceKey: string; resourceScope: ApprovalResourceScope } {
  if (isNetworkCapability(capability) && decision === "version") {
    return {
      resourceKey: NETWORK_ALL_RESOURCE_KEY,
      resourceScope: { kind: "network", value: "*" },
    };
  }
  return { resourceKey, resourceScope };
}

function isNetworkCapability(capability: string): boolean {
  return capability === "external-network-fetch" || capability === "cors-response-read";
}
