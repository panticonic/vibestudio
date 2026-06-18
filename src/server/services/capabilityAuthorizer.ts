import type { VerifiedCaller } from "@natstack/shared/serviceDispatcher";
import type { AppCapability } from "@natstack/shared/unitManifest";
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
}

export class CapabilityAccessError extends Error {
  readonly code = "EACCES";

  constructor(message: string) {
    super(message);
    this.name = "CapabilityAccessError";
  }
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
  };
}
