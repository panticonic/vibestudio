import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import {
  callerKindForPrincipalKind,
  isCodeIdentityCallerKind,
  type CodeIdentityCallerKind,
} from "@vibestudio/shared/principalKinds";
import type { UserSubject } from "@vibestudio/identity/types";

const INTERNAL_DO_SOURCE = "vibestudio/internal";
const EVAL_DO_CLASS = "EvalDO";

function evalOwner(record: {
  source: { repoPath: string };
  className?: string;
  parentId?: string;
  stateArgs?: unknown;
}): { ownerId: string } | null {
  if (record.source.repoPath !== INTERNAL_DO_SOURCE || record.className !== EVAL_DO_CLASS) {
    return null;
  }
  if (
    !record.stateArgs ||
    typeof record.stateArgs !== "object" ||
    Array.isArray(record.stateArgs)
  ) {
    return null;
  }
  const stateArgs = record.stateArgs as Record<string, unknown>;
  const admission = stateArgs["agentExecutionAdmission"];
  if (!admission || typeof admission !== "object" || Array.isArray(admission)) {
    return null;
  }
  const ownerId = (admission as Record<string, unknown>)["ownerId"];
  if (
    (admission as Record<string, unknown>)["v"] !== 1 ||
    typeof ownerId !== "string" ||
    stateArgs["ownerPrincipalId"] !== ownerId ||
    record.parentId !== ownerId
  )
    return null;
  return { ownerId };
}

export interface ResolvedCodeIdentity {
  callerId: string;
  callerKind: CodeIdentityCallerKind;
  repoPath: string;
  effectiveVersion: string;
  executionDigest: string;
  requested: readonly import("@vibestudio/rpc").CapabilityScope[];
  evalOrigin?: { ownerId: string };
}

/**
 * Resolve the code/source identity for a runtime caller, used at trust-boundary
 * hand-offs (RPC verify, capability grants, audit). Reads from the Node-side
 * `EntityCache` mirror of `WorkspaceDO`. Returns null for callers without an
 * active entity (e.g. uninitialized handshake) or unsupported kinds (server,
 * shell, extension).
 */
export function resolveCodeIdentity(
  entityCache: Pick<EntityCache, "resolveActive">,
  callerId: string
): ResolvedCodeIdentity | null {
  const record = entityCache.resolveActive(callerId);
  if (!record) return null;
  const resolvedEvalOwner = evalOwner(record);
  if (resolvedEvalOwner) {
    const owner = entityCache.resolveActive(resolvedEvalOwner.ownerId);
    if (
      !owner ||
      !isCodeIdentityCallerKind(owner.kind) ||
      !owner.activeBuildKey ||
      !owner.activeExecutionDigest ||
      !/^[0-9a-f]{64}$/.test(owner.activeExecutionDigest) ||
      !owner.activeAuthority
    ) {
      // An inert user/session owner has no code identity by design. In that
      // case the exact product-baked EvalDO is the mediating harness. Continue
      // through the ordinary record validation below; forged/unsealed EvalDO
      // records still fail closed because they lack a sealed execution image.
    } else {
      return {
        // Runtime attribution remains the concrete EvalDO. The exact harness
        // identity comes from its immutable host-recorded owner chain; it is not
        // a request list for dynamic execution.
        callerId,
        callerKind: "do",
        repoPath: owner.source.repoPath,
        effectiveVersion: owner.source.effectiveVersion,
        executionDigest: owner.activeExecutionDigest,
        requested: [],
        evalOrigin: { ownerId: resolvedEvalOwner.ownerId },
      };
    }
  }
  if (!isCodeIdentityCallerKind(record.kind)) return null;
  const callerKind = callerKindForPrincipalKind(record.kind);
  if (!isCodeIdentityCallerKind(callerKind)) return null;
  if (!record.activeBuildKey) return null;
  if (!record.activeExecutionDigest || !/^[0-9a-f]{64}$/.test(record.activeExecutionDigest)) {
    return null;
  }
  if (!record.activeAuthority) return null;
  return {
    callerId,
    callerKind,
    repoPath: record.source.repoPath,
    effectiveVersion: record.source.effectiveVersion,
    executionDigest: record.activeExecutionDigest,
    requested: record.activeAuthority.requests,
    ...(resolvedEvalOwner ? { evalOrigin: { ownerId: resolvedEvalOwner.ownerId } } : {}),
  };
}

/**
 * Resolve the owning-user `subject` for a runtime caller by walking the entity's
 * `owner_user_id` stamp (WP0 §6 — lineage inheritance). A panel/worker/DO
 * attributes to the human whose subject launched its lineage; because the stamp
 * is written once at `entityActivate` from the parent's subject, this is a single
 * direct lookup with no recursion.
 *
 * Sibling to `resolveCodeIdentity`: same `EntityCache` mirror, same
 * null-on-miss contract. Returns null for callers with no active entity or no
 * owner stamp (e.g. the bootstrap principals of WP0 §5.4).
 *
 * The returned `handle` is the stable `userId` itself as a placeholder — the
 * live account handle (and all mutable personalization) is resolved from the
 * shared identity DB at the auth choke point (plan §2.1 / WP0 §3.1/§3.7), never
 * frozen here. `userId` is attribution/routing only, never a grant (WP0 §6).
 */
export function resolveUserSubject(
  entityCache: Pick<EntityCache, "resolveActive">,
  callerId: string
): UserSubject | null {
  const record = entityCache.resolveActive(callerId);
  if (!record) return null;
  const ownerUserId = record.ownerUserId;
  if (!ownerUserId) return null;
  return { userId: ownerUserId, handle: ownerUserId };
}
