import type { AgentBinding } from "@vibestudio/identity/types";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";

/**
 * Project one authenticated credential id through the canonical live session
 * entity. The credential proves only `entityId`; semantic coordinates and
 * ownership remain facts of the entity graph.
 */
export function bindingForLiveAgentEntity(
  record: EntityRecord | null,
  agentId: string
): AgentBinding | null {
  if (!record || record.status !== "active" || record.kind !== "session") return null;
  const binding = record.agentBinding;
  if (
    !binding ||
    binding.entityId !== record.id ||
    binding.contextId !== record.contextId ||
    !binding.channelId
  ) {
    return null;
  }
  return { agentId, ...binding };
}

/** Account/system owner currently attached to a live agent session. */
export function ownerForLiveAgentEntity(record: EntityRecord | null): string | null {
  if (!record || record.status !== "active" || record.kind !== "session") return null;
  return record.ownerUserId ?? null;
}
