import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import {
  callerKindForPrincipalKind,
  isCodeIdentityCallerKind,
  type CodeIdentityCallerKind,
} from "@vibestudio/shared/principalKinds";
import type { UserSubject } from "@vibestudio/identity/types";
import type { EvalCeilingPurpose } from "@vibestudio/shared/authorityManifest";

const INTERNAL_DO_SOURCE = "vibestudio/internal";
const EVAL_DO_CLASS = "EvalDO";

function evalOwnerCeilingPurpose(record: {
  source: { repoPath: string };
  className?: string;
  parentId?: string;
  stateArgs?: unknown;
}): { ownerId: string; purpose: EvalCeilingPurpose } | null {
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
  const ownerId = stateArgs["ownerPrincipalId"];
  const purpose = stateArgs["authorityCeilingPurpose"];
  if (
    typeof ownerId !== "string" ||
    record.parentId !== ownerId ||
    (purpose !== "agentic-code-execution" && purpose !== "tool-eval" && purpose !== "test-eval")
  ) {
    return null;
  }
  return { ownerId, purpose };
}

export interface ResolvedCodeIdentity {
  callerId: string;
  callerKind: CodeIdentityCallerKind;
  repoPath: string;
  effectiveVersion: string;
  executionDigest: string;
  requested: readonly import("@vibestudio/rpc").CapabilityScope[];
  evalCeilings: readonly import("@vibestudio/shared/authorityManifest").EvalAuthorityCeiling[];
  evalOrigin?: { ownerId: string; purpose: EvalCeilingPurpose };
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
  const evalOwner = evalOwnerCeilingPurpose(record);
  if (evalOwner) {
    const owner = entityCache.resolveActive(evalOwner.ownerId);
    if (
      !owner ||
      !isCodeIdentityCallerKind(owner.kind) ||
      !owner.activeBuildKey ||
      !owner.activeExecutionDigest ||
      !/^[0-9a-f]{64}$/.test(owner.activeExecutionDigest) ||
      !owner.activeAuthority
    ) {
      return null;
    }
    const requested = owner.activeAuthority.evalCeilings
      .filter((ceiling) => ceiling.audience === "eval" && ceiling.purpose === evalOwner.purpose)
      .flatMap((ceiling) => ceiling.capabilities);
    if (requested.length === 0) return null;
    return {
      // Runtime attribution remains the concrete EvalDO. Only the code digest
      // and request ceiling come from its immutable, host-recorded owner chain.
      callerId,
      callerKind: "do",
      repoPath: owner.source.repoPath,
      effectiveVersion: owner.source.effectiveVersion,
      executionDigest: owner.activeExecutionDigest,
      requested,
      // An eval cannot widen its owner's ceiling. A child installed
      // unit must establish its own sealed identity and authority manifest.
      evalCeilings: [],
      evalOrigin: { ownerId: evalOwner.ownerId, purpose: evalOwner.purpose },
    };
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
    evalCeilings: record.activeAuthority.evalCeilings,
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
