import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import type { PrincipalKind } from "@vibestudio/shared/authorization";

export const CONTEXT_BOUNDARY_CAPABILITY = "context.boundary" as const;

/** Canonical schema-owned declaration for a state-dependent context boundary. */
export function contextBoundaryAuthority(input: {
  service: string;
  method: string;
  principals: readonly PrincipalKind[];
  resolver?: string;
}) {
  const primary = `service:${input.service}.${input.method}`;
  return {
    requirement: requirementForPrincipals(input.principals, primary),
    resource: { kind: "literal" as const, key: primary },
    prepared: {
      resolver: input.resolver ?? `${input.service}.${input.method}.contextBoundary`,
      leaves: [
        {
          capability: CONTEXT_BOUNDARY_CAPABILITY,
          requirement: requirementForPrincipals(
            ["host", "user", "code", "entity"],
            CONTEXT_BOUNDARY_CAPABILITY
          ),
          evalAcquisition: {
            kind: "approval" as const,
            title: "Use another runtime context",
            description: "Review access to another agent or panel's existing context.",
            operation: { kind: "runtime", verb: "Use existing context" },
            grantScopes: ["run", "session", "version"] as const,
          },
        },
      ],
    },
  };
}

