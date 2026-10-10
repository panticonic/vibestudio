import type { PrincipalKind } from "@vibestudio/rpc";

/**
 * A catalog method may narrow, but never broaden, the principals granted by
 * its containing workspace service.
 */
export function workspaceMethodPrincipals(
  servicePrincipals: readonly PrincipalKind[],
  methodPrincipals?: readonly string[]
): readonly PrincipalKind[] {
  return methodPrincipals
    ? servicePrincipals.filter((principal) => methodPrincipals.includes(principal))
    : servicePrincipals;
}
