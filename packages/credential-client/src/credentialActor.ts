import type { Credential } from "./types.js";

/**
 * How the host may use `credential` for one verified caller.
 *
 * - `direct`: inject the stored credential.
 * - `agent-exchange`: an agent execution session acting for the credential's
 *   owner; the host injects an agent-attributed token obtained through the
 *   credential's RFC 8693 `agentExchange`, never the human token itself.
 * - `refused`: never usable by this caller, whatever the user approves.
 */
export type CredentialCallerUse =
  | { kind: "direct" }
  | { kind: "agent-exchange" }
  | { kind: "refused"; code: CredentialCallerRefusal };

export type CredentialCallerRefusal =
  /** An agent may not act through the user's personal credential. */
  | "credential-actor-mismatch"
  /** The credential acts as a different member. */
  | "credential-owner-mismatch"
  /** No member stands behind the request, or the member has not connected their own. */
  | "credential-owner-required";

/**
 * The caller facts this rule needs, all host-verified: `agentId` is
 * `credentialGrantAgentId(caller)`, `userId` is the acting account
 * (`callerAccountUserId`, WP0 §5–6: device → user; agents and other deputies
 * inherit their spawner's user through lineage).
 */
export interface CredentialCallerFacts {
  agentId?: string;
  userId?: string;
}

/**
 * A credential the provider attributes to the human personally
 * (`actor: "human"`) records every use as that human's own action. It is
 * therefore used only for its owning member's actions (attribution
 * correctness among trusted members, not inter-user hardening), and an agent
 * of that member reaches it only through the credential's agent exchange.
 * Agent-attributed and unattributed credentials impose no caller rule.
 */
export function credentialCallerUse(
  credential: Pick<Credential, "actor" | "owner" | "agentExchange">,
  caller: CredentialCallerFacts
): CredentialCallerUse {
  if (credential.actor !== "human") return { kind: "direct" };
  if (caller.userId === undefined) {
    return { kind: "refused", code: "credential-owner-required" };
  }
  if (credential.owner?.userId !== caller.userId) {
    return { kind: "refused", code: "credential-owner-mismatch" };
  }
  if (caller.agentId === undefined) return { kind: "direct" };
  return credential.agentExchange
    ? { kind: "agent-exchange" }
    : { kind: "refused", code: "credential-actor-mismatch" };
}

/**
 * Why none of `candidates` (credentials that matched the request audience)
 * is usable by the caller, or null when at least one is. When the only human
 * credentials belong to other members, the answer is that the acting member
 * must connect their own — never a fallback to someone else's.
 */
export function credentialSelectionRefusal(
  candidates: readonly Pick<Credential, "actor" | "owner" | "agentExchange">[],
  caller: CredentialCallerFacts
): CredentialCallerRefusal | null {
  let refusal: CredentialCallerRefusal | null = null;
  for (const candidate of candidates) {
    const use = credentialCallerUse(candidate, caller);
    if (use.kind !== "refused") return null;
    refusal =
      use.code === "credential-owner-mismatch"
        ? "credential-owner-required"
        : (refusal ?? use.code);
  }
  return refusal;
}

/**
 * A durable agent-scoped grant may name a human-attributed credential only
 * when that credential has an agent exchange; otherwise the grant could never
 * be exercised and would misdescribe the agent's authority.
 */
export function credentialRefusesAgentGrant(
  credential: Pick<Credential, "actor" | "agentExchange">
): boolean {
  return credential.actor === "human" && !credential.agentExchange;
}
