import type { PrincipalKind } from "@vibestudio/rpc";

/** Default compositional requirement shared by a service's methods. */
export interface ServiceAuthorityPolicy {
  principals: PrincipalKind[];
  /** Human-readable explanation shown by capability discovery. */
  description?: string;
}

/** Restrictedness / destructiveness tier — drives read-only gating, UX, audit. */
export type MethodSensitivity = "read" | "write" | "admin" | "destructive";

/**
 * Reviewed authority tier. Receiver-specific host methods use the checked-in
 * host census; reusable and runtime-discovered method contracts carry their
 * own decision. A mounted method must have exactly one source.
 */
export interface MethodTierPolicy {
  tier: "open" | "gated" | "critical";
  session: "family" | "codeOnly";
  rationale: string;
  scopeSplit?: string;
}

export function resolveMethodTierPolicy(
  method: string,
  declared: MethodTierPolicy | undefined,
  censused: MethodTierPolicy | null
): MethodTierPolicy {
  if (declared && censused) {
    throw new Error(`Service method ${method} declares a tier already owned by the host census`);
  }
  const resolved = declared ?? censused;
  if (!resolved) {
    throw new Error(`Service method ${method} has no reviewed tier decision`);
  }
  return resolved;
}

/** Human-facing explanation of a conditional principal narrowing. */
export interface AccessRestriction {
  when: string;
  principals: PrincipalKind[];
  reason: string;
}

/** A declared approval gate a method may trigger at runtime. */
export interface AccessApproval {
  when?: string;
  capability?: string;
  operation: { kind: string; verb: string; groupKeyTemplate?: string };
  grantScopes?: string[];
  severity?: "standard" | "severe";
  reason: string;
}

/** A capability/state prerequisite a method needs before it can succeed. */
export interface AccessRequirement {
  kind: "grant" | "credential" | "entity" | "context" | "state";
  description: string;
  grantKey?: string;
}

/** Queryable documentation metadata; enforcement lives only in `authority`. */
export interface MethodAccessDescriptor {
  restrictedTo?: AccessRestriction[];
  sensitivity?: MethodSensitivity;
  approval?: AccessApproval[];
  requires?: AccessRequirement[];
}
