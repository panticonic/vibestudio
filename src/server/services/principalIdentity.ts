import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import {
  callerKindForPrincipalKind,
  isCodeIdentityCallerKind,
  type CodeIdentityCallerKind,
} from "@vibestudio/shared/principalKinds";
import type { UserSubject } from "@vibestudio/identity/types";
import type { CapabilityScope } from "@vibestudio/rpc";

export interface ResolvedCodeIdentity {
  callerId: string;
  callerKind: CodeIdentityCallerKind;
  repoPath: string;
  executionDigest: string;
  requested: readonly CapabilityScope[];
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
  callerId: string,
  resolveRequests: (executionDigest: string) => readonly CapabilityScope[] | null
): ResolvedCodeIdentity | null {
  const record = entityCache.resolveActive(callerId);
  if (!record) return null;
  if (!isCodeIdentityCallerKind(record.kind)) return null;
  const callerKind = callerKindForPrincipalKind(record.kind);
  if (!isCodeIdentityCallerKind(callerKind)) return null;
  if (!record.activeExecutionDigest) return null;
  const requested = resolveRequests(record.activeExecutionDigest);
  if (!requested) return null;
  return {
    callerId,
    callerKind,
    repoPath: record.source.repoPath,
    executionDigest: record.activeExecutionDigest,
    requested,
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
