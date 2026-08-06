import type { AuthorityGrant, Principal, PrincipalKind } from "@vibestudio/rpc";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { getProductBootManifest } from "../internalDOs/productBootManifest.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";

// Product bootstrap grants are derived only from authenticated invocation facts:
// the receiver's live declaration decides which principal family is admitted.
// Static source censuses are audit evidence, never runtime authority inputs.
//
// This covers the host and the acting human only. Installed code holds nothing
// here — see below.

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
}

/**
 * Resolve host bootstrap admission for the host and the acting human. Receiver
 * requirements remain the authority boundary.
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

  // Installed code gets NO grant here. A manifest is a request, never an
  // approval: admitting a unit records that its exact version was reviewed and
  // accepted, and nothing more (U3, U5). What a unit may actually do comes from
  // ordinary stored grants — install clearance minted when the review was
  // accepted, or an at-use decision — which the caller reads out of the
  // canonical grant store alongside these product grants.
  //
  // Synthesizing an allow for every declared request is what made admission mean
  // blanket authority, and it is what made revocation meaningless: there was no
  // record to revoke. A declared request with no stored grant now prompts.
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
