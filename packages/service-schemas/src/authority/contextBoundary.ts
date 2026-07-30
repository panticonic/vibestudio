import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import { fixedPreparedAuthorityRequirement } from "@vibestudio/shared/typedServiceClient";
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
  operation?:
    | "openPanel"
    | "replacePanel"
    | "reload"
    | "unload"
    | "close"
    | "movePanel"
    | "takeOver"
    | "rebuildPanel"
    | "updatePanelState";
  targetArgument?: number;
  targetPath?: readonly (string | number)[];
  requestedContextPath?: readonly (string | number)[];
  requestedContextLookup?: {
    method: string;
    arguments: readonly {
      argument: number;
      path?: readonly (string | number)[];
    }[];
    resultPath: readonly (string | number)[];
  };
  tier: "gated" | "critical";
}) {
  const primary = input.primaryCapability ?? `service:${input.service}.${input.method}`;
  return {
    principals: input.principals,
    requirement: requirementForPrincipals(input.principals, primary),
    resource: { kind: "literal" as const, key: primary },
    prepared: {
      resolver: input.resolver ?? `${input.service}.${input.method}.contextBoundary`,
      ...(input.operation
        ? {
            contextBoundary: {
              operation: input.operation,
              targetArgument: input.targetArgument ?? 0,
              ...(input.targetPath ? { targetPath: input.targetPath } : {}),
              ...(input.requestedContextPath
                ? { requestedContextPath: input.requestedContextPath }
                : {}),
              ...(input.requestedContextLookup
                ? { requestedContextLookup: input.requestedContextLookup }
                : {}),
            },
          }
        : {}),
      leaves: [
        {
          capability: CONTEXT_BOUNDARY_CAPABILITY,
          requirement: fixedPreparedAuthorityRequirement(
            requirementForPrincipals(["host", "user", "code"], CONTEXT_BOUNDARY_CAPABILITY)
          ),
          tier: input.tier,
        },
      ],
    },
  };
}
