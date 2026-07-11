import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { AppCapability } from "@vibestudio/shared/unitManifest";
import {
  callerHasAppCapability,
  callerHasPlatformCapability,
  type CapabilityTrustDeps,
} from "./chromeTrust.js";

export interface CapabilityDecision {
  allowed: boolean;
  reason?: string;
}

export interface CapabilityAuthorizer {
  check(caller: VerifiedCaller, capability: AppCapability): CapabilityDecision;
  require(caller: VerifiedCaller, capability: AppCapability): void;
  /**
   * WP9 §3 — true iff the caller's LIVE role (resolved from the identity DB via
   * `roleOf`, never a field frozen onto the connection) is `root` or `admin`.
   * This is the gate for host-administrative operations (invite/revoke user,
   * workspace create/delete/switch). It is NEVER consulted in capability-grant
   * matching, which stays code-identity-scoped (plan §0.1) — role gates WHO may
   * invoke certain admin methods, orthogonal to WHETHER the code is approved.
   */
  isRootOrAdmin(caller: VerifiedCaller): boolean;
  /** `isRootOrAdmin` as an assertion; throws `CapabilityAccessError` otherwise. */
  requireRootOrAdmin(caller: VerifiedCaller, operation: string): void;
}

export class CapabilityAccessError extends Error {
  readonly code = "EACCES";

  constructor(message: string) {
    super(message);
    this.name = "CapabilityAccessError";
  }
}

/**
 * WP9 §3 — resolve the caller's LIVE role and report whether it is root/admin.
 *
 * `UserSubject` carries only `{userId, handle}` (the role is mutable, WP0 §3.7),
 * so the role is looked up fresh from the shared identity DB via `deps.roleOf`
 * at the moment of the gate — a demotion/promotion takes effect immediately,
 * with no reconnect. Denies when the caller has no host-verified subject (an
 * unauthenticated/bootstrap principal is never an admin human) or when no
 * `roleOf` resolver is wired (no role can be affirmed).
 */
export function isRootOrAdmin(
  caller: VerifiedCaller,
  deps: Pick<CapabilityTrustDeps, "roleOf"> = {}
): boolean {
  const userId = caller.subject?.userId;
  if (!userId) return false;
  const role = deps.roleOf?.(userId);
  return role === "root" || role === "admin";
}

/** `isRootOrAdmin` as an assertion; throws `CapabilityAccessError` otherwise. */
export function requireRootOrAdmin(
  caller: VerifiedCaller,
  operation: string,
  deps: Pick<CapabilityTrustDeps, "roleOf"> = {}
): void {
  if (isRootOrAdmin(caller, deps)) return;
  throw new CapabilityAccessError(`${operation} requires the root or admin role`);
}

export function createCapabilityAuthorizer(deps: CapabilityTrustDeps = {}): CapabilityAuthorizer {
  return {
    check(caller, capability) {
      const kind = caller.runtime.kind;
      if (callerHasAppCapability(caller, capability, deps)) return { allowed: true };
      if (callerHasPlatformCapability(caller, capability, deps)) return { allowed: true };
      if (kind === "app") {
        return {
          allowed: false,
          reason: `App ${caller.runtime.id} does not have capability '${capability}'`,
        };
      }
      return {
        allowed: false,
        reason: `Caller kind '${kind}' cannot use capability '${capability}'`,
      };
    },
    require(caller, capability) {
      const decision = this.check(caller, capability);
      if (decision.allowed) return;
      throw new CapabilityAccessError(decision.reason ?? `Capability '${capability}' is required`);
    },
    isRootOrAdmin(caller) {
      return isRootOrAdmin(caller, deps);
    },
    requireRootOrAdmin(caller, operation) {
      requireRootOrAdmin(caller, operation, deps);
    },
  };
}
