import {
  parseUnitAuthorityManifest,
  type UnitAuthorityManifest,
} from "@vibestudio/shared/authorityManifest";
import type { EntityActivationInput, EntityRecord } from "@vibestudio/shared/runtime/entitySpec";

export interface PreparedExecutionIdentity {
  executionDigest?: string;
  authorityRequests?: readonly import("@vibestudio/shared/authorityManifest").UnitAuthorityRequest[];
}

export interface ActiveExecutionIdentity {
  activeExecutionDigest: string;
  activeAuthority: UnitAuthorityManifest;
}

export interface PreparedRuntimeEntityIdentity extends PreparedExecutionIdentity {
  buildKey: string;
  effectiveVersion: string;
}

export interface DeclaredWorkspaceServiceActivationPlan {
  source: string;
  className: string;
  key: string;
  contextId: string;
}

type ExistingDeclaredWorkspaceServiceIdentity = Pick<
  EntityRecord,
  | "source"
  | "contextId"
  | "className"
  | "key"
  | "activeBuildKey"
  | "activeExecutionDigest"
  | "ownerUserId"
  | "agentBinding"
>;

/**
 * Crosses the immutable-build → active-entity boundary. Executable entities
 * may only be activated from the complete sealed identity of their exact
 * artifact; a source version or build key is never an authority substitute.
 */
export function requireActiveExecutionIdentity(
  prepared: PreparedExecutionIdentity,
  label = "prepared runtime execution"
): ActiveExecutionIdentity {
  if (!prepared.executionDigest || !/^[0-9a-f]{64}$/.test(prepared.executionDigest)) {
    throw new Error(`${label} is missing a canonical execution digest`);
  }
  // Source manifests may omit an orthogonal empty section, but the builder
  // normalizes both arrays into the immutable execution recipe. Crossing the
  // activation boundary with either field absent would make it impossible to
  // distinguish a deliberately empty envelope from a partially propagated
  // one, so the sealed runtime form is intentionally total.
  if (!Array.isArray(prepared.authorityRequests)) {
    throw new Error(`${label} authority is missing normalized requests`);
  }
  const activeAuthority = parseUnitAuthorityManifest(
    { requests: prepared.authorityRequests },
    `${label} authority`
  );
  return {
    activeExecutionDigest: prepared.executionDigest,
    activeAuthority,
  };
}

/**
 * Compose the durable incarnation of a manifest-declared workspace service.
 *
 * A newly resolved service is host-managed workspace infrastructure, so it is
 * owned by the synthetic system subject. When the canonical entity already
 * exists, ownership and agent lineage are immutable: resolution may finish its
 * executable identity, but may never claim or re-parent it. The prepared build
 * must also describe the entity's already-selected effective version; carrying
 * an old effective version forward onto a new build would manufacture an
 * execution identity that no artifact actually has.
 */
export function declaredWorkspaceServiceActivationInput(
  plan: DeclaredWorkspaceServiceActivationPlan,
  prepared: PreparedRuntimeEntityIdentity,
  existing: ExistingDeclaredWorkspaceServiceIdentity | null,
  systemOwnerUserId: string
): EntityActivationInput {
  if (existing) {
    const identityChecks: Array<{ field: string; existing: unknown; prepared: unknown }> = [
      { field: "source", existing: existing.source.repoPath, prepared: plan.source },
      { field: "contextId", existing: existing.contextId, prepared: plan.contextId },
      { field: "className", existing: existing.className, prepared: plan.className },
      { field: "key", existing: existing.key, prepared: plan.key },
      {
        field: "effectiveVersion",
        existing: existing.source.effectiveVersion,
        prepared: prepared.effectiveVersion,
      },
    ];
    for (const check of identityChecks) {
      if (check.existing !== check.prepared) {
        throw new Error(
          `Declared workspace service ${plan.source}:${plan.className}:${plan.key} cannot mix ` +
            `${check.field} ${JSON.stringify(check.existing)} with prepared ` +
            `${JSON.stringify(check.prepared)}`
        );
      }
    }
    if (existing.activeBuildKey && existing.activeBuildKey !== prepared.buildKey) {
      throw new Error(
        `Declared workspace service ${plan.source}:${plan.className}:${plan.key} is already ` +
          `bound to build ${existing.activeBuildKey}; cannot prepare ${prepared.buildKey}`
      );
    }
    if (
      existing.activeExecutionDigest &&
      existing.activeExecutionDigest !== prepared.executionDigest
    ) {
      throw new Error(
        `Declared workspace service ${plan.source}:${plan.className}:${plan.key} is already ` +
          `bound to execution ${existing.activeExecutionDigest}; cannot prepare ` +
          `${prepared.executionDigest ?? "an incomplete execution identity"}`
      );
    }
    if (!existing.ownerUserId) {
      throw new Error(
        `Declared workspace service ${plan.source}:${plan.className}:${plan.key} has no ` +
          "immutable owner; refusing to synthesize ownership for an existing entity"
      );
    }
  }

  return {
    kind: "do",
    source: { repoPath: plan.source, effectiveVersion: prepared.effectiveVersion },
    contextId: plan.contextId,
    activeBuildKey: prepared.buildKey,
    ...requireActiveExecutionIdentity(
      prepared,
      `declared workspace service ${plan.source}:${plan.className}:${plan.key}`
    ),
    className: plan.className,
    key: plan.key,
    ownerUserId: existing ? existing.ownerUserId : systemOwnerUserId,
    ...(existing?.agentBinding ? { agentBinding: existing.agentBinding } : {}),
  };
}
