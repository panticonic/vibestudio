import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";

/**
 * Stable agent identity for credential grants.
 *
 * Installed agent code is an exact-version subject, even when the resident
 * runtime carries an agent binding. Only evaluated code follows the owning
 * agent because an eval's generated code identity is ephemeral and its exact
 * executable admission is enforced independently. Every credential boundary
 * must use this same rule so a grant made while connecting is also valid when
 * the credential is consumed by egress.
 */
export function credentialGrantAgentId(
  caller: Pick<VerifiedCaller, "agentBinding" | "executionSession">,
  code: Pick<NonNullable<VerifiedCaller["code"]>, "evalOrigin"> | null | undefined
): string | undefined {
  if (caller.executionSession === undefined) return undefined;
  return code?.evalOrigin?.ownerId ?? caller.agentBinding?.entityId;
}
