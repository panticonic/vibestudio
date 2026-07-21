import type {
  AuthorizationContext,
  AuthorityGrant,
  DirectAuthorityAttestation,
} from "@vibestudio/rpc";
import type { PrincipalKind } from "@vibestudio/rpc";
import { evaluateAuthority, requirementForPrincipals } from "@vibestudio/shared/authorization";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { getProductBootManifest } from "../internalDOs/productBootManifest.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { productAuthorityGrants } from "./productAuthorityGrants.js";

export interface AuthorityFacts {
  workspaceId: string;
  workspaceMember: boolean;
  workspaceRole?: string | null;
  workspaceRevision?: string;
  sessionId: string;
  audience: string;
  capability: string;
  resourceKey: string;
  incarnationId?: string | null;
  /** Live manifest/provider policy may withhold the code grant. */
  grantCode?: boolean;
  grantStore?: CapabilityGrantStore;
  now?: number;
}

/**
 * Constructs the one authenticated authority vocabulary from verified host
 * records. R3A baseline grants are explicit, exact-resource grants that retain
 * the pre-refactor policy while binding code calls to their full artifact.
 */
export function authorizeVerifiedCaller(
  caller: VerifiedCaller,
  facts: AuthorityFacts
): { context: AuthorizationContext; grants: AuthorityGrant[] } {
  const now = facts.now ?? Date.now();
  const product = getProductBootManifest();
  const host = caller.hostOriginated === true ? product.hostPrincipal : null;
  const actingUser =
    caller.subject && caller.subject.userId !== "system"
      ? (`user:${caller.subject.userId}` as const)
      : null;
  const code = caller.code?.executionDigest
    ? (`code:${caller.code.repoPath}@${caller.code.executionDigest}` as const)
    : null;
  const entityId = caller.agentBinding?.entityId ?? (code ? caller.runtime.id : null);
  const entity = entityId ? (`entity:${entityId}` as const) : null;
  const authorizingOrigin = caller.hostOriginated
    ? ({ kind: "host", principal: product.hostPrincipal } as const)
    : code
      ? ({ kind: "code", principal: code } as const)
      : entity
        ? ({ kind: "entity", principal: entity } as const)
        : ({ kind: "user", principal: actingUser ?? (`user:anonymous` as const) } as const);
  const context: AuthorizationContext = {
    authorizingOrigin,
    host,
    actingUser,
    device: null,
    entity,
    incarnation: facts.incarnationId ?? null,
    codeAuthority: {
      executor:
        code && caller.code ? { principal: code, requested: caller.code.requested ?? [] } : null,
      execution: null,
      initiator: null,
      delegations: [],
    },
    deviceOwnership: null,
    ownerChain: actingUser ? [actingUser] : [],
    agentBinding:
      caller.agentBinding && entity
        ? {
            entity,
            contextId: caller.agentBinding.contextId,
            channelId: caller.agentBinding.channelId,
          }
        : null,
    workspace: {
      workspaceId: facts.workspaceId,
      member: facts.workspaceMember,
      role: facts.workspaceRole ?? null,
      revision: facts.workspaceRevision ?? "live",
    },
    session: {
      id: facts.sessionId,
      audience: facts.audience,
      version: "1.0.0",
      expiresAt: now + 5_000,
    },
  };
  // A call may carry several authenticated facts, but exactly one principal
  // authorizes it. In particular, a code-originated call retains the acting
  // user for membership/ownership relationships without inheriting that
  // user's capabilities. This is the confused-deputy boundary: requirements
  // may intersect facts, never union their grants.
  const authorizingPrincipals = caller.hostOriginated
    ? { host }
    : code
      ? { code }
      : caller.agentBinding && entity
        ? { entity }
        : { user: actingUser };
  const grants = productAuthorityGrants({
    caller,
    principals: authorizingPrincipals,
    capability: facts.capability,
    resourceKey: facts.resourceKey,
    sessionId: facts.sessionId,
    now,
    grantStore: facts.grantStore,
    grantCode: facts.grantCode,
  });
  return { context, grants };
}

/** Evaluate an out-of-band host workflow with the same canonical vocabulary. */
export function verifiedCallerHasAuthority(
  caller: VerifiedCaller,
  facts: AuthorityFacts,
  principals: readonly PrincipalKind[]
): boolean {
  const resolved = authorizeVerifiedCaller(caller, facts);
  return evaluateAuthority({
    context: resolved.context,
    grants: resolved.grants,
    requirement: requirementForPrincipals(principals, facts.capability),
    resourceKey: facts.resourceKey,
    now: facts.now,
  }).allowed;
}

export function directAuthorityCapability(method: string): string {
  return `rpc:${method}`;
}

export function directAuthorityAudience(
  source: string,
  className: string,
  objectKey: string
): string {
  return `do:${source}:${className}:${objectKey}`;
}

export function attestDirectRpc(input: {
  caller: VerifiedCaller;
  source: string;
  className: string;
  objectKey: string;
  method: string;
  workspaceId: string;
  workspaceMember: boolean;
  workspaceRole?: string | null;
  sessionId: string;
  incarnationId?: string | null;
  grantCode?: boolean;
  grantStore?: CapabilityGrantStore;
  now?: number;
}): DirectAuthorityAttestation {
  const now = input.now ?? Date.now();
  const audience = directAuthorityAudience(input.source, input.className, input.objectKey);
  const resourceKey = audience;
  const { context, grants } = authorizeVerifiedCaller(input.caller, {
    workspaceId: input.workspaceId,
    workspaceMember: input.workspaceMember,
    workspaceRole: input.workspaceRole,
    sessionId: input.sessionId,
    audience,
    capability: directAuthorityCapability(input.method),
    resourceKey,
    incarnationId: input.incarnationId,
    grantCode: input.grantCode,
    grantStore: input.grantStore,
    now,
  });
  return {
    audience,
    method: input.method,
    resourceKey,
    issuedAt: now,
    expiresAt: now + 5_000,
    context,
    grants,
  };
}
