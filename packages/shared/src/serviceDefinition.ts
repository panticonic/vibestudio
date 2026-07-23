import type { ServiceAuthorityPolicy } from "./serviceAuthority.js";
import type { AuthorityRequirement } from "./authorization.js";
import type {
  AuthorityChallengePresentation,
  ServiceContext,
  ServiceHandler,
  VerifiedCaller,
} from "./serviceDispatcher.js";
import type { MethodSchema } from "./typedServiceClient.js";

export interface PreparedAuthoritySelection {
  capability: string;
  resourceKey: string;
  /** Required only for a schema leaf whose requirement kind is `selected`. */
  requirement?: AuthorityRequirement;
  authorizingCaller?: VerifiedCaller;
  challenge?: AuthorityChallengePresentation;
  /** Host-selected tier, allowed only when the schema declares its closed set. */
  tier?: "gated" | "critical";
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
