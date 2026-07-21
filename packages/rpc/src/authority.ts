/** Wire-safe authority facts shared by host-service and direct-RPC dispatch. */

export type PrincipalKind = "host" | "user" | "device" | "code" | "entity";
export type Principal = `${PrincipalKind}:${string}`;

export type ResourceScope =
  | { kind: "exact"; key: string }
  | { kind: "prefix"; prefix: string }
  | { kind: "origin"; origin: string }
  | { kind: "domain"; domain: string }
  | { kind: "network"; value: "*" };

export interface CapabilityScope {
  capability: string;
  resource: ResourceScope;
}

export interface VerifiedDelegation {
  id: string;
  issuer: Principal;
  subject: Principal;
  audience: string;
  purpose: string;
  capabilities: readonly CapabilityScope[];
  notBefore?: number;
  expiresAt: number;
  revokedAt?: number;
}

export interface LiveWorkspaceRelationship {
  workspaceId: string;
  member: boolean;
  role: string | null;
  revision: string;
}

export type AuthorizationOrigin =
  | { kind: "code"; principal: Principal }
  | { kind: "user"; principal: Principal }
  | { kind: "host"; principal: Principal }
  | { kind: "device"; principal: Principal }
  | { kind: "entity"; principal: Principal };

export interface CodeAuthorityChain {
  executor: {
    principal: Principal;
    requested: readonly CapabilityScope[];
  } | null;
  execution:
    | {
        phase: "preparation" | "run";
        principal: Principal;
        runId: string;
        runDigest: string;
        requested: readonly CapabilityScope[];
      }
    | null;
  initiator:
    | { kind: "code" | "interactive-user" | "host"; principal: Principal }
    | null;
  delegations: readonly VerifiedDelegation[];
}

/**
 * Every field is constructed from authenticated transport and live host state.
 * Runtime shape is deliberately absent: routing facts are not authority facts.
 */
export interface AuthorizationContext {
  authorizingOrigin: AuthorizationOrigin;
  host: Principal | null;
  actingUser: Principal | null;
  device: Principal | null;
  entity: Principal | null;
  incarnation: string | null;
  codeAuthority: CodeAuthorityChain;
  deviceOwnership: {
    device: Principal;
    user: Principal;
    revision: string;
  } | null;
  ownerChain: readonly Principal[];
  agentBinding: { entity: Principal; contextId: string; channelId: string } | null;
  workspace: LiveWorkspaceRelationship | null;
  session: {
    id: string;
    audience: string;
    version: string;
    expiresAt: number;
  };
}

export interface AuthorityGrant extends CapabilityScope {
  subject: Principal;
  effect: "allow" | "deny";
  issuedBy: Principal;
  createdAt: number;
  expiresAt?: number;
  revokedAt?: number;
  constraints?: {
    sessionId?: string;
    minVersion?: string;
    maxVersion?: string;
  };
  binding:
    | { kind: "principal" }
    | { kind: "exact-execution"; repoPath: string; executionDigest: string }
    | {
        kind: "session";
        sessionId: string;
        repoPath: string;
        executionDigest: string;
      }
    | {
        kind: "selector";
        repoPath: string;
        selector: string;
        resolvedExecutionDigest: string;
      };
  provenance: string;
}

export type AuthorityRequirement =
  | {
      kind: "capability";
      principal: PrincipalKind;
      capability: string;
      delegation?: { audience: string; purpose: string; issuer?: Principal };
    }
  | {
      kind: "relationship";
      name:
        | "workspace-member"
        | "workspace-role"
        | "device-owned-by-user"
        | "entity-self"
        | "entity-owner"
        | "entity-deputy"
        | "channel-owner"
        | "channel-editor"
        | "channel-member"
        | "agent-binding"
        | "code-source"
        | "delegation";
      value?: string;
    }
  | { kind: "session"; audience?: string; minVersion?: string }
  | { kind: "all"; requirements: readonly AuthorityRequirement[] }
  | { kind: "any"; requirements: readonly AuthorityRequirement[] };

export interface AuthorizationDecision {
  allowed: boolean;
  code:
    | "allowed"
    | "missing-principal"
    | "denied"
    | "missing-grant"
    | "not-requested"
    | "delegation"
    | "relationship"
    | "session";
  reason: string;
  requirement: AuthorityRequirement;
  principal?: Principal;
}

/** Fresh host mediation for one direct method and target object. */
export interface DirectAuthorityAttestation {
  audience: string;
  method: string;
  resourceKey: string;
  issuedAt: number;
  expiresAt: number;
  context: AuthorizationContext;
  grants: readonly AuthorityGrant[];
  /** Host-resolved containment, enforced by the receiver before method entry. */
  readOnly?: true;
}

/**
 * Trusted workerd-router ingress time for direct authority evaluation.
 * The router always overwrites this transport fact after authenticating the
 * host dispatch, so userland cannot extend an attestation's validity.
 */
export const DIRECT_AUTHORITY_ACCEPTED_AT_HEADER = "X-Vibestudio-Authority-Accepted-At";
