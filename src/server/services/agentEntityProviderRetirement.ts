import type { Credential } from "@vibestudio/credential-client/types";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import type { CredentialLifecycle } from "./credentialLifecycle.js";

export interface AgentEntityProviderRetirementDeps {
  credentialStore: { listUrlBound(): Promise<Credential[]> };
  credentialLifecycle: Pick<CredentialLifecycle, "retireAgentEntity">;
  /** Agent-scoped credential-use grants die with their agent entity. */
  credentialUseGrantStore?: { revokeForAgent(agentId: string): number | Promise<number> };
}

/**
 * A retired agent entity is gone for good, so its authority at every provider
 * that gave it a principal (a credential's agent exchange; each agent entity
 * is its own principal there) is revoked, and its agent-scoped credential-use
 * grants are dropped. Runs from the entity-retirement cleanup, which retries
 * until it completes: a failed provider call propagates.
 *
 * Only the credentials of the entity's own owner are ever used; a revoked
 * credential is skipped (see `CredentialLifecycle.retireAgentEntity` for a
 * session the provider no longer honours).
 */
export async function retireAgentEntityAtProviders(
  deps: AgentEntityProviderRetirementDeps,
  record: EntityRecord
): Promise<void> {
  // Only self-bound agent vessels are agent entities at a provider.
  if (record.agentBinding?.entityId !== record.id) return;
  await deps.credentialUseGrantStore?.revokeForAgent(record.id);
  if (!record.ownerUserId) return;
  const credentials = (await deps.credentialStore.listUrlBound()).filter(
    (credential): credential is Credential & { id: string } =>
      !!credential.id &&
      !credential.revokedAt &&
      credential.actor === "human" &&
      credential.owner?.userId === record.ownerUserId &&
      !!credential.agentExchange?.retireUrl
  );
  const failures: unknown[] = [];
  for (const credential of credentials) {
    try {
      await deps.credentialLifecycle.retireAgentEntity(credential, record.id);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `Agent ${record.id} could not be retired at its providers`, {
      cause: failures[0],
    });
  }
}
