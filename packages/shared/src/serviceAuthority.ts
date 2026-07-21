import type { PrincipalKind } from "@vibestudio/rpc";

/** Default compositional requirement shared by a service's methods. */
export interface ServiceAuthorityPolicy {
  principals: PrincipalKind[];
  /** Human-readable explanation shown by capability discovery. */
  description?: string;
}

/** Restrictedness / destructiveness tier — drives read-only gating, UX, audit. */
export type MethodSensitivity = "read" | "write" | "admin" | "destructive";

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

