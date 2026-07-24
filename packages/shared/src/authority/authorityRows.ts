import type { ResourceScope } from "@vibestudio/rpc";
import type { UnitAuthorityRequest } from "../authorityManifest.js";
import { capabilityDomain, type AuthorityDomainId, type AuthorityVerb } from "./capabilityDomains.js";
import { hostCapabilityPresentation } from "./hostCapabilityPresentations.js";

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
}): AuthorityRow {
  const staticCategory = capabilityDomain(input.capability);
  if (
    staticCategory &&
    input.category &&
    (staticCategory.domain !== input.category.domain || staticCategory.verb !== input.category.verb)
  ) {
    throw new Error(`Capability ${input.capability} contradicts the reviewed authority census`);
  }
  const category = staticCategory ?? input.category;
  const presentation = hostCapabilityPresentation(input.capability);
  if (!category || (!presentation && !input.reviewedAction)) {
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

export function declaredAuthorityRows(
  requests: readonly UnitAuthorityRequest[]
): AuthorityRow[] {
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
