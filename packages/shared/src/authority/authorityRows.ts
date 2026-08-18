import type { ResourceScope } from "@vibestudio/rpc";
import type { UnitAuthorityRequest } from "../authorityManifest.js";
import { HOST_SEMANTIC_CAPABILITY_COPY } from "../hostApprovalCopy.js";
import { productBuiltinPresentation } from "./productBuiltinIndex.js";
import { generatedHostCapabilityPresentation } from "./hostAuthorityCatalog.generated.js";
import {
  capabilityDomain,
  type AuthorityDomainId,
  type AuthorityVerb,
} from "./authorityDomains.js";

export type AuthorityStatement = "declared" | "allowed" | "snapshot" | "prospective";
export type AuthorityRowState = "active" | "suspended" | "locked";

export interface AuthorityRowProvenance {
  source: "manifest" | "approval" | "profile" | "mission" | "receiver";
  decidedAt?: number;
  decidedBy?: string;
  surface?: string;
  lineageClasses?: readonly string[];
}

export interface AuthorityRow {
  capability: string;
  domain: AuthorityDomainId;
  verb: AuthorityVerb;
  action: string;
  resource: string;
  resourceScope: ResourceScope;
  tier: "gated" | "critical";
  statement: AuthorityStatement;
  state?: AuthorityRowState;
  provenance: AuthorityRowProvenance;
  /**
   * The platform has no reviewed presentation for this capability. Set only by
   * an inspection that asked to degrade rather than fail; such a row is always
   * contextual and always headline.
   */
  unrecognized?: true;
  flags: {
    lineageTainted?: boolean;
    irreversible?: boolean;
    newInDiff?: boolean;
    removedInDiff?: boolean;
  };
}

export function authorityRow(input: {
  capability: string;
  resource: ResourceScope;
  resourcePhrase?: string;
  tier: "gated" | "critical";
  statement: AuthorityStatement;
  state?: AuthorityRowState;
  provenance: AuthorityRowProvenance;
  flags?: AuthorityRow["flags"];
  category?: { domain: AuthorityDomainId; verb: AuthorityVerb };
  reviewedAction?: string;
  /**
   * Render an unrecognized capability as an unknown row instead of throwing.
   * Set by install/template inspection, where foreign code supplies the
   * capability names and a typo must not break the review.
   */
  degradeUnknown?: boolean;
}): AuthorityRow {
  const receiverDeclared =
    input.category &&
    (input.capability.startsWith("workspace-service:") || input.capability.startsWith("userland:"));
  const staticCategory = receiverDeclared ? null : capabilityDomain(input.capability);
  // Host effects use the reviewed census; workspace receivers use their sealed
  // provider vocabulary, whether reached through a service facade or directly.
  const category = staticCategory ?? input.category;
  const presentation =
    HOST_SEMANTIC_CAPABILITY_COPY.find(({ prefix }) =>
      prefix.endsWith(":") || prefix.endsWith(".")
        ? input.capability.startsWith(prefix)
        : input.capability === prefix || input.capability.startsWith(`${prefix}:`)
    )?.presentation ??
    productBuiltinPresentation(input.capability) ??
    generatedHostCapabilityPresentation(input.capability);
  if (!category || (!presentation && !input.reviewedAction)) {
    if (input.degradeUnknown) {
      // A foreign template must not be able to break a review with a typo. An
      // unrecognized request renders as an unknown row rather than failing
      // inspection — and unknown means contextual and headline everywhere
      // downstream, so nothing is quietly granted or quietly hidden
      // (docs/template-install-unit-approval-ux-plan.md §6.1, §10).
      return {
        capability: input.capability,
        domain: "safety",
        verb: "manage",
        action: "do something this version of Vibestudio doesn't recognize",
        resource: input.resourcePhrase ?? resourcePhrase(input.resource),
        resourceScope: input.resource,
        tier: input.tier,
        statement: input.statement,
        ...(input.state ? { state: input.state } : {}),
        provenance: input.provenance,
        flags: input.flags ?? {},
        unrecognized: true,
      };
    }
    throw new Error(`Capability ${input.capability} has no reviewed authority presentation`);
  }
  if (!staticCategory && category.domain === "safety") {
    throw new Error("Workspace services cannot declare the Safety controls domain");
  }
  return {
    capability: input.capability,
    domain: category.domain,
    verb: category.verb,
    action: staticCategory ? presentation!.action : (input.reviewedAction ?? presentation!.action),
    resource: input.resourcePhrase ?? resourcePhrase(input.resource),
    resourceScope: input.resource,
    tier: input.tier,
    statement: input.statement,
    ...(input.state ? { state: input.state } : {}),
    provenance: input.provenance,
    flags: input.flags ?? {},
  };
}

export function declaredAuthorityRows(requests: readonly UnitAuthorityRequest[]): AuthorityRow[] {
  return requests.map((request) =>
    authorityRow({
      capability: request.capability,
      resource: request.resource,
      tier: request.tier,
      statement: "declared",
      provenance: { source: "manifest" },
    })
  );
}

export function resourcePhrase(scope: ResourceScope): string {
  switch (scope.kind) {
    case "exact":
      return scope.key;
    case "prefix":
      return scope.prefix === "" ? "anything in this workspace" : `${scope.prefix}…`;
    case "origin":
      return scope.origin;
    case "domain":
      return scope.domain;
    case "network":
      return "the web";
  }
}
