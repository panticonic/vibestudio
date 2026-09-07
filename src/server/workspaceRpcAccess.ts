import type { IdentityDb } from "@vibestudio/identity/identityDb";
import type { MembershipStore } from "@vibestudio/identity/membership";
import { evaluateWorkspaceRpcBoundary } from "@vibestudio/identity/workspaceRpcPolicy";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";

/** Live governing facts, read below mutable workspace source. This check opens
 * only the RPC boundary; the ordinary receiver still decides all authority. */
export function assertWorkspaceRpcAccess(input: {
  caller: VerifiedCaller;
  destinationWorkspaceId: string;
  target: string;
  operation: string;
  purpose: "call" | "discover";
  identity: Pick<IdentityDb, "getWorkspaceRpcPolicy" | "getPrivateWorkspaceOwner">;
  membership: Pick<MembershipStore, "has">;
}): void {
  const sourceWorkspaceId = input.caller.workspaceId;
  if (sourceWorkspaceId === input.destinationWorkspaceId) return;
  const userId = input.caller.subject?.userId;
  const deny = () => {
    // Uniform failure: callers cannot use policy checks as a private directory.
    throw Object.assign(new Error("Cross-workspace RPC is not permitted"), { code: "EACCES" });
  };
  if (!sourceWorkspaceId || !userId || input.caller.hostOriginated) return deny();
  if (
    !input.membership.has(userId, sourceWorkspaceId) ||
    !input.membership.has(userId, input.destinationWorkspaceId)
  )
    return deny();
  const decision = evaluateWorkspaceRpcBoundary({
    sourceWorkspaceId,
    destinationWorkspaceId: input.destinationWorkspaceId,
    initiatingUserId: userId,
    target: input.target,
    operation: input.operation,
    purpose: input.purpose,
    sourcePolicy: input.identity.getWorkspaceRpcPolicy(sourceWorkspaceId),
    destinationPolicy: input.identity.getWorkspaceRpcPolicy(input.destinationWorkspaceId),
    destinationRole: input.identity.getPrivateWorkspaceOwner(input.destinationWorkspaceId)?.role,
    // Export eligibility is checked against the exact receiver implementation
    // after this preflight, before ordinary authority/acquisition can run.
    exported: true,
  });
  if (!decision.allowed) deny();
}
