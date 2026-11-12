import type { ApprovalDecision } from "@vibestudio/shared/approvals";
import { authorityFailureForDecision } from "@vibestudio/shared/authorization";
import { RpcBoundaryError } from "@vibestudio/rpc";
import type { Credential } from "@vibestudio/credential-client/types";
import type { CredentialCallerRefusal } from "@vibestudio/credential-client/credentialActor";

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

const CALLER_REFUSAL_COPY: Record<CredentialCallerRefusal, string> = {
  "credential-actor-mismatch": "acts as the user personally and cannot be used by an agent",
  "credential-owner-mismatch": "acts as another member; use your own connection",
  "credential-owner-required": "acts as a member personally; connect your own account to use it",
};

/**
 * A caller-use refusal (see `credentialCallerUse`) is not a decision the user
 * can grant, so it is raised before any approval is requested. The code leads
 * the message so userland can turn `credential-owner-required` into "connect
 * your own".
 */
export function credentialCallerRefusalError(
  credential: Pick<Credential, "id" | "label">,
  code: CredentialCallerRefusal
): RpcBoundaryError {
  return new RpcBoundaryError(
    `${code}: ${credential.label ?? credential.id ?? "credential"} ${CALLER_REFUSAL_COPY[code]}`,
    "access",
    "EACCES"
  );
}
