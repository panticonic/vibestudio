import type { RuntimeEntitySummary } from "@vibestudio/shared/runtime/entitySpec";
import type { VerifiedCodeIdentity } from "@vibestudio/shared/serviceDispatcher";

export interface ActivePanelCode {
  callerId: string;
  runtimeEntityId: string;
  source: string;
  executionDigest: string;
}

/**
 * Bind a renderer caller to the exact active runtime entity that selected its
 * code. The desktop shell only authenticates and relays this identity: it does
 * not borrow the product host's build authority to reconstruct it.
 */
export function verifyPanelCodeIdentity(
  panel: ActivePanelCode,
  entities: readonly RuntimeEntitySummary[]
): VerifiedCodeIdentity {
  const entity = entities.find((candidate) => candidate.id === panel.runtimeEntityId);
  if (!entity) {
    throw new Error(`Active runtime entity is missing for panel ${panel.callerId}`);
  }
  if (
    entity.kind !== "panel" ||
    entity.source !== panel.source ||
    entity.executionDigest !== panel.executionDigest ||
    !entity.authorityRequests ||
    !entity.authorityDelegations
  ) {
    throw new Error(`Panel execution identity changed while resolving ${panel.callerId}`);
  }
  return {
    callerId: panel.callerId,
    callerKind: "panel",
    repoPath: panel.source,
    executionDigest: panel.executionDigest,
    requested: entity.authorityRequests,
    delegations: entity.authorityDelegations,
  };
}
