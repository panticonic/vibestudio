import type { ApprovalDecision } from "@vibestudio/shared/approvals";
import { authorityFailureForDecision } from "@vibestudio/shared/authorization";
import { RpcBoundaryError } from "@vibestudio/rpc";

export function credentialApprovalDeniedError(credentialId: string): RpcBoundaryError {
  const capability = "credentials.use";
  return new RpcBoundaryError("Credential approval denied", "access", "EACCES", undefined, {
    denied: true,
    authorityFailure: authorityFailureForDecision(
      {
        allowed: false,
        code: "user-denied",
        reason: "Credential approval denied",
        requirement: { kind: "capability", principal: "code", capability },
      },
      { capability, resourceKey: `credential:${credentialId}`, tier: "critical" }
    ),
  });
}

export type CredentialGrantIdentity = {
  repoPath: string;
  effectiveVersion: string;
  agentId?: string;
};

export type CredentialApprovalDecision = Extract<
  ApprovalDecision,
  "once" | "session" | "agent" | "version" | "deny"
>;

/**
 * Credential consent has exactly three lifetimes: one request, this session,
 * or the verified durable subject (agent identity for agent-owned eval;
 * otherwise the exact installed code version).
 */
export function credentialApprovalDecisions(
  identity: CredentialGrantIdentity,
  options: { onceOnly?: boolean; preapprovesUse?: boolean } = {}
): CredentialApprovalDecision[] {
  if (options.onceOnly) return ["once", "deny"];
  return [
    ...(options.preapprovesUse ? [] : (["once"] as const)),
    "session",
    identity.agentId ? "agent" : "version",
    "deny",
  ];
}

export function assertCredentialApprovalDecision(
  identity: CredentialGrantIdentity,
  decision: ApprovalDecision,
  options: { onceOnly?: boolean; preapprovesUse?: boolean } = {}
): asserts decision is CredentialApprovalDecision {
  if (
    !credentialApprovalDecisions(identity, options).includes(decision as CredentialApprovalDecision)
  ) {
    throw new Error(
      `Credential approval decision '${decision}' cannot be represented for this requester`
    );
  }
}
