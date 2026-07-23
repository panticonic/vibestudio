import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import type { PrincipalKind } from "@vibestudio/shared/authorization";

export const CONTEXT_BOUNDARY_CAPABILITY = "context.boundary" as const;

/** Canonical schema-owned declaration for a state-dependent context boundary. */
export function contextBoundaryAuthority(input: {
  service: string;
  method: string;
  /** Stable semantic primary capability for a promptable method. */
  primaryCapability?: string;
  principals: readonly PrincipalKind[];
  resolver?: string;
  tier: "gated" | "critical";
}) {
  const primary = input.primaryCapability ?? `service:${input.service}.${input.method}`;
  return {
    requirement: requirementForPrincipals(input.principals, primary),
    resource: { kind: "literal" as const, key: primary },
    prepared: {
      resolver: input.resolver ?? `${input.service}.${input.method}.contextBoundary`,
      leaves: [
        {
          capability: CONTEXT_BOUNDARY_CAPABILITY,
          requirement: requirementForPrincipals(
            ["host", "user", "code"],
            CONTEXT_BOUNDARY_CAPABILITY
          ),
          tier: input.tier,
        },
      ],
    },
  };
}
