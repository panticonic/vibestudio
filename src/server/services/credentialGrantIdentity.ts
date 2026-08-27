import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";

/**
 * Stable agent identity for credential grants.
 *
 * A resident agent carries its binding directly. Evaluated code can instead
 * inherit the owning agent through its admitted execution origin. Every
 * credential boundary must use this same ordering so a grant made while
 * connecting is also valid when the credential is consumed by egress.
 */
export function credentialGrantAgentId(
  caller: Pick<VerifiedCaller, "agentBinding" | "executionSession">,
  code: Pick<NonNullable<VerifiedCaller["code"]>, "evalOrigin"> | null | undefined
): string | undefined {
  return (
    caller.agentBinding?.entityId ??
    (caller.executionSession !== undefined ? code?.evalOrigin?.ownerId : undefined)
  );
}
