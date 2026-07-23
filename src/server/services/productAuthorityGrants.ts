import type { AuthorityGrant, Principal, PrincipalKind } from "@vibestudio/rpc";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { capabilityPatternCovers } from "@vibestudio/shared/authorityManifest";
import { scopeCovers } from "@vibestudio/shared/authorization";
import { getProductBootManifest } from "../internalDOs/productBootManifest.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";

// Product bootstrap grants are derived only from authenticated invocation facts:
// the receiver's live declaration decides which principal family is admitted,
// while installed code is additionally bounded by its exact sealed manifest.
// Static source censuses are audit evidence, never runtime authority inputs.

export interface ProductGrantInput {
  caller: VerifiedCaller;
  principals: Partial<Record<PrincipalKind, Principal | null>>;
  capability: string;
  resourceKey: string;
  sessionId: string;
  now: number;
  /** Undefined only for the temporary direct-RPC admission bridge. */
  tier?: "open" | "gated" | "critical";
  grantStore?: CapabilityGrantStore;
  grantCode?: boolean;
}

/**
 * Resolve host bootstrap admission plus live user decisions. Receiver
 * requirements remain the authority boundary; code admission additionally
 * binds to the exact requests sealed into `caller.code`.
 */
export function productAuthorityGrants(input: ProductGrantInput): AuthorityGrant[] {
  const grants: AuthorityGrant[] = [];
  // Critical effects are never standing product authority. Service-tier user
  // and session origins acquire through the unified store; sealed shipped code
  // and the product host retain only the exact reviewed admission snapshot.
  if (input.tier === "critical") return grants;
  // Users are trusted principals in the product threat model. Their live,
  // authenticated calls receive the reviewed receiver capability at open and
  // gated tiers; untrusted content acts through code/session origins instead
  // and therefore cannot inherit this admission. Critical effects still take
  // the fresh-confirmation path above.
  const admittedPrincipals = ["host", "user"] as const;
  for (const kind of admittedPrincipals) {
    const subject = input.principals[kind];
    if (!subject) continue;
    grants.push(productGrant(subject, input.capability, input.resourceKey, input.now));
  }

  const code = input.principals["code"];
  const identity = input.caller.code;
  // A manifest is a request, never an approval. Only a host-stamped active
  // unit incarnation may turn its exact sealed requests into version-bound
  // authority. Unit retirement/version change removes that live fact.
  if (!code || !identity || input.grantCode !== true) return grants;

  if (
    identity.requested?.some(
      (request) =>
        capabilityPatternCovers(request.capability, input.capability) &&
        scopeCovers(request.resource, input.resourceKey)
    )
  ) {
    grants.push({
      ...productGrant(code, input.capability, input.resourceKey, input.now),
      provenance: "sealed-manifest-admission-v1",
    });
  }
  return grants;
}

function productGrant(
  subject: Principal,
  capability: string,
  resourceKey: string,
  now: number
): AuthorityGrant {
  return {
    subject,
    capability,
    resource: { kind: "exact", key: resourceKey },
    effect: "allow",
    issuedBy: getProductBootManifest().hostPrincipal,
    createdAt: now,
    provenance: "reviewed-product-admission-v1",
  };
}
