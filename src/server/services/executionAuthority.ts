import type { ExecutionAuthorityOrigin } from "@vibestudio/rpc";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";

/** Copying execution must preserve its scope. Distinct launch subjects cannot
 * be substituted for one another by cloning or by choosing an existing key. */
export function retainExecutionAuthority(
  launch: ExecutionAuthorityOrigin | undefined,
  retained: ExecutionAuthorityOrigin | undefined
): ExecutionAuthorityOrigin | undefined {
  if (launch && retained && canonicalJson(launch) !== canonicalJson(retained)) {
    throw new Error("Execution authority belongs to a different launch subject");
  }
  return retained ?? launch;
}

/** Resolve only authenticated launch facts. Never walk mutable ancestry or
 * accept an execution origin from the public runtime/eval request. Reviewed
 * service code carries this scope for the arbitrary execution it launches;
 * its own implementation calls retain their ordinary code authority. */
export function executionAuthorityForCaller(
  caller: VerifiedCaller,
  entities: Pick<EntityCache, "resolveActive">
): ExecutionAuthorityOrigin | undefined {
  if (caller.website) {
    if (!caller.website.connected) throw new Error("Website launch requires a live connection");
    const { subject, userId, workspaceId, origin, binding } = caller.website;
    return {
      kind: "website",
      website: {
        subject,
        userId,
        workspaceId,
        origin,
        binding: { subject: binding.subject, generation: binding.generation },
      },
    };
  }
  return (
    caller.executionAuthority ??
    caller.executionSession?.authorityOrigin ??
    entities.resolveActive(caller.runtime.id)?.executionAuthority ??
    (caller.agentBinding
      ? entities.resolveActive(caller.agentBinding.entityId)?.executionAuthority
      : undefined)
  );
}

/** Reusing an executable identity cannot change its authority owner, including
 * from an unscoped runtime to a scoped one. Check before preparing any code. */
export function assertExecutionAuthorityMatches(
  attempted: ExecutionAuthorityOrigin | undefined,
  existing: ExecutionAuthorityOrigin | undefined
): void {
  if (canonicalJson(attempted ?? null) !== canonicalJson(existing ?? null)) {
    throw new Error("Execution authority belongs to a different launch subject");
  }
}
