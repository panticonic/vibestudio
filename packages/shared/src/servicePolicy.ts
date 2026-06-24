/**
 * Service Policy - Permission checking for services.
 *
 * This module checks which caller types (shell, panel, server) can access
 * which services. The policy is looked up from the service's ServiceDefinition
 * as registered in the dispatcher.
 */

import type { CallerKind } from "./serviceDispatcher.js";

export type ServicePolicy = {
  /** Which caller kinds can access this service */
  allowed: CallerKind[];
  /** Human-readable description */
  description?: string;
};

/** Restrictedness / destructiveness tier — drives read-only gating, UX, audit. */
export type MethodSensitivity = "read" | "write" | "admin" | "destructive";

/**
 * A conditional caller-kind narrowing applied after the static `callers` gate
 * (lifts a handler-side check like "app/session entities require shell/server"
 * into declared, queryable form).
 */
export interface AccessRestriction {
  /** Structured/human condition under which this narrowing applies. */
  when: string;
  /** Caller kinds permitted when the condition holds. */
  callers: CallerKind[];
  reason: string;
}

/**
 * A declared approval gate a method MAY trigger at runtime. The handler/guard
 * reads `capability`/`operation`/`grantScopes` from here rather than hardcoding
 * strings, so the catalog can never advertise an approval profile that differs
 * from what actually happens. `operation.kind` aligns with the real
 * ApprovalOperationDescriptor enum (see approvals.ts).
 */
export interface AccessApproval {
  /** Condition that triggers approval; omitted ⇒ always. */
  when?: string;
  /** Capability name checked/granted (e.g. "cors-response-read"). */
  capability?: string;
  /** Operation descriptor for approval UI grouping/copy. */
  operation: { kind: string; verb: string; groupKeyTemplate?: string };
  /** Scopes this approval can persist as (e.g. "once"|"session"|"version"|"repo"|"origin"). */
  grantScopes?: string[];
  severity?: "standard" | "severe";
  reason: string;
}

/** A capability/state prerequisite a method needs before it can succeed. */
export interface AccessRequirement {
  kind: "grant" | "credential" | "entity" | "context" | "state";
  description: string;
  /** Stable grant/resource key used for grant lookups, when applicable. */
  grantKey?: string;
}

/**
 * Declarable, queryable descriptive access metadata for a method, surfaced by
 * the capability catalog and JIT error hints. The enforced caller-kind gate is
 * `ServicePolicy` (method-level `policy`, falling back to the service policy);
 * this descriptor adds what policy can't express — `sensitivity` (doc tier) and
 * the declared conditional gates `restrictedTo` / `approval` / `requires`.
 */
export interface MethodAccessDescriptor {
  /** Conditional caller narrowing surfaced after the static gate. */
  restrictedTo?: AccessRestriction[];
  /** Restrictedness tier (read | write | admin | destructive). */
  sensitivity?: MethodSensitivity;
  /** Approval gates the method may trigger. */
  approval?: AccessApproval[];
  /** Capability/state prerequisites. */
  requires?: AccessRequirement[];
}

/**
 * Registry interface for looking up service policies.
 * ServiceDispatcher implements this via getPolicy().
 */
export interface PolicyRegistry {
  getPolicy(service: string): ServicePolicy | undefined;
  getMethodPolicy?(service: string, method: string): ServicePolicy | undefined;
}

/**
 * Check if a caller kind can access a service.
 * Throws an error if access is denied.
 *
 * Looks up the policy from the registry (ServiceDispatcher).
 */
export function checkServiceAccess(
  service: string,
  callerKind: CallerKind,
  registry: PolicyRegistry,
  method?: string
): void {
  let policy: ServicePolicy | undefined;

  if (method && registry.getMethodPolicy) {
    policy = registry.getMethodPolicy(service, method);
  }

  if (!policy) {
    policy = registry.getPolicy(service);
  }

  if (!policy) {
    throw new Error(`Unknown service '${service}'`);
  }

  if (!policy.allowed.includes(callerKind)) {
    // DOs run worker code and retain access to services that already admit
    // worker runtimes unless a method explicitly includes/excludes `do`.
    if (callerKind === "do" && policy.allowed.includes("worker")) return;
    throw new Error(`Service '${service}' is not accessible to ${callerKind} callers`);
  }
}
