import type { Credential } from "./types.js";

/**
 * Whether the host must refuse to inject `credential` for a caller.
 *
 * A credential the provider attributes to the human personally
 * (`actor: "human"`) is never used by an agent execution session: the provider
 * would record the agent's action as the human's own. `agentId` is the
 * host-verified agent identity (`credentialGrantAgentId`), never a userland
 * claim. Agent-attributed and unattributed credentials impose no caller rule.
 */
export function credentialActorRefusesCaller(
  credential: Pick<Credential, "actor">,
  agentId: string | undefined
): boolean {
  return credential.actor === "human" && agentId !== undefined;
}
