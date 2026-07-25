import type { ServiceAuthorityPolicy } from "./serviceAuthority.js";
import type { AuthorityRequirement } from "./authorization.js";
import type {
  AuthorityChallengePresentation,
  ServiceContext,
  ServiceHandler,
  VerifiedCaller,
} from "./serviceDispatcher.js";
import type { MethodSchema } from "./typedServiceClient.js";

interface PreparedAuthoritySelectionFields {
  capability: string;
  resourceKey: string;
  authorizingCaller?: VerifiedCaller;
  challenge?: AuthorityChallengePresentation;
  /** Host-selected tier, allowed only when the schema declares its closed set. */
  tier?: "gated" | "critical";
}

declare const fixedPreparedAuthoritySelectionBrand: unique symbol;
declare const selectedPreparedAuthoritySelectionBrand: unique symbol;

export type FixedPreparedAuthoritySelection = PreparedAuthoritySelectionFields & {
  requirement?: never;
  readonly [fixedPreparedAuthoritySelectionBrand]: true;
};

export type SelectedPreparedAuthoritySelection = PreparedAuthoritySelectionFields & {
  requirement: AuthorityRequirement;
  readonly [selectedPreparedAuthoritySelectionBrand]: true;
};

export type PreparedAuthoritySelection =
  | FixedPreparedAuthoritySelection
  | SelectedPreparedAuthoritySelection;

/** Select only resource/presentation data for a schema-fixed prepared leaf. */
export function fixedPreparedAuthoritySelection<const S extends PreparedAuthoritySelectionFields>(
  selection: S
): S & FixedPreparedAuthoritySelection {
  return selection as S & FixedPreparedAuthoritySelection;
}

/**
 * Select a complete host-derived requirement for a dynamic prepared leaf.
 * Rejecting missing or mismatched capability leaves here keeps malformed
 * authority out of the dispatcher and next-action/approval machinery.
 */
export function selectedPreparedAuthoritySelection<
  const S extends PreparedAuthoritySelectionFields & { requirement: AuthorityRequirement },
>(selection: S): S & SelectedPreparedAuthoritySelection {
  let capabilityLeaves = 0;
  const visit = (requirement: AuthorityRequirement): void => {
    if (requirement.kind === "capability") {
      capabilityLeaves += 1;
      if (requirement.capability !== selection.capability) {
        throw new Error(
          `Selected prepared authority for '${selection.capability}' contains capability ` +
            `'${requirement.capability}'`
        );
      }
      return;
    }
    if (requirement.kind === "all" || requirement.kind === "any") {
      for (const child of requirement.requirements) visit(child);
    }
  };
  visit(selection.requirement);
  if (capabilityLeaves === 0) {
    throw new Error(
      `Selected prepared authority for '${selection.capability}' has no capability leaf`
    );
  }
  return selection as S & SelectedPreparedAuthoritySelection;
}

export type AuthorityPreparationResolver = (
  ctx: ServiceContext,
  args: unknown[]
) => readonly PreparedAuthoritySelection[] | Promise<readonly PreparedAuthoritySelection[]>;

export interface ServiceDefinition {
  name: string;
  description?: string;
  /** Compositional authority contract for every method unless overridden. */
  authority: ServiceAuthorityPolicy;
  /**
   * Method schema table — pure data (Zod arg tuples, optional return schemas,
   * per-method authority). For services with external callers this should be a
   * table from `@vibestudio/service-schemas` so typed clients derive their types
   * from the same source of truth (see typedServiceClient.ts).
   */
  methods: Record<string, MethodSchema>;
  /** Side-effect-free resolvers referenced by method authority schemas. */
  authorityPreparation?: Record<string, AuthorityPreparationResolver>;
  handler: ServiceHandler;
}
