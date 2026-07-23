import type {
  AuthorizationContext,
  AuthorityGrant,
  DirectAuthorityAttestation,
  PrincipalKind,
  RpcAuthorityEffect,
} from "@vibestudio/rpc";
import { randomUUID } from "node:crypto";
import { evaluateAuthority, requirementForPrincipals } from "@vibestudio/shared/authorization";
import { productDirectMethodCapability } from "@vibestudio/shared/authority/directMethodEffects";
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
  tier?: "open" | "gated" | "critical";
  mission?: import("@vibestudio/rpc").SessionMissionFact | null;
  contextIntegrity?: import("@vibestudio/rpc").ContextIntegrityFact | null;
  incarnationId?: string | null;
  /** Live manifest/provider policy may withhold the code grant. */
  grantCode?: boolean;
  grantStore?: CapabilityGrantStore;
  now?: number;
}

/** Exact mission-to-runtime join; both sides use canonical repo identity + EV. */
export function callerMatchesMissionHarness(
  caller: VerifiedCaller,
  mission: import("@vibestudio/rpc").SessionMissionFact
): boolean {
  return Boolean(
    caller.code?.executionDigest &&
    caller.code.repoPath === mission.harness.unit &&
    caller.code.effectiveVersion === mission.harness.ev
  );
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
  const sessionPrincipal = `session:${facts.sessionId}` as const;
  // Agent binding is an authenticated relationship fact, not an authorizing
  // origin. A harness's own infrastructure calls retain its sealed code origin;
  // only a host-verified eval/causal invocation is session-originated.
  // The authorizing origin remains the authenticated actor. Critical consent
  // is represented separately as an exact session-scoped confirmation facet,
  // so principal-family and manifest checks still apply to the actor itself.
  const sessionOrigin = caller.sessionOrigin === true;
  const authorizingOrigin = caller.hostOriginated
    ? ({ kind: "host", principal: product.hostPrincipal } as const)
    : sessionOrigin
      ? ({ kind: "session", principal: sessionPrincipal } as const)
      : code
        ? ({ kind: "code", principal: code } as const)
        : ({ kind: "user", principal: actingUser ?? (`user:anonymous` as const) } as const);
  const context: AuthorizationContext = {
    authorizingOrigin,
    host,
    actingUser,
    entity,
    incarnation: facts.incarnationId ?? null,
    executingCode:
      code && caller.code
        ? {
            principal: code,
            requested: caller.code.requested ?? [],
            sourceLineage: { class: "unknown", externalKeys: [] },
          }
        : null,
    initiatorChain: [
      ...(actingUser ? [actingUser] : []),
      ...(entity ? [entity] : []),
      ...(code ? [code] : []),
    ],
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
      ...(facts.mission ? { mission: facts.mission } : {}),
      ...(facts.mission && code ? { mediatingHarness: code } : {}),
    },
    contextIntegrity:
      facts.contextIntegrity ??
      (sessionOrigin
        ? { class: "internal", latchEpoch: 0, externalKeys: [] }
        : { class: "not-applicable", latchEpoch: 0, externalKeys: [] }),
  };
  // A call may carry several authenticated facts, but exactly one principal
  // authorizes it. In particular, a code-originated call retains the acting
  // user for membership/ownership relationships without inheriting that
  // user's capabilities. This is the confused-deputy boundary: requirements
  // may intersect facts, never union their grants.
  const authorizingPrincipals = caller.hostOriginated
    ? { host }
    : sessionOrigin
      ? { session: sessionPrincipal }
      : code
        ? { code }
        : { user: actingUser };
  const grants = productAuthorityGrants({
    caller,
    principals: authorizingPrincipals,
    capability: facts.capability,
    resourceKey: facts.resourceKey,
    sessionId: facts.sessionId,
    now,
    grantStore: facts.grantStore,
    grantCode: facts.grantCode ?? caller.codeApproved,
    tier: facts.tier,
  });
  if (facts.grantStore) {
    const subjects = [authorizingOrigin.principal] as import("@vibestudio/rpc").Principal[];
    if (facts.tier === "critical" && !subjects.includes(sessionPrincipal)) {
      subjects.push(sessionPrincipal);
    }
    if (context.session.mission) {
      subjects.push(
        `mission:${context.session.mission.missionId}@${context.session.mission.closureDigest}`
      );
    }
    grants.push(...facts.grantStore.grantsForSubjects(subjects, facts.capability, now));
  }
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
  return method.startsWith("__event:")
    ? `event:${method.slice("__event:".length)}`
    : `rpc:${method}`;
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
  mission?: import("@vibestudio/rpc").SessionMissionFact | null;
  contextIntegrity?: import("@vibestudio/rpc").ContextIntegrityFact | null;
  /** Live workspace service capability selected from the exact declarations. */
  capability?: string;
  /** Exact sealed receiver declaration selected from the active build. */
  effect?: RpcAuthorityEffect;
  /** Workspace service calls use gated acquisition, not the static product bridge. */
  tier?: "open" | "gated" | "critical";
  now?: number;
}): DirectAuthorityAttestation {
  const now = input.now ?? Date.now();
  const audience = directAuthorityAudience(input.source, input.className, input.objectKey);
  const resourceKey = audience;
  const productCapability = productDirectMethodCapability(input.className, input.method);
  const capability =
    input.capability ?? productCapability ?? directAuthorityCapability(input.method);
  const { context, grants } = authorizeVerifiedCaller(input.caller, {
    workspaceId: input.workspaceId,
    workspaceMember: input.workspaceMember,
    workspaceRole: input.workspaceRole,
    sessionId: input.sessionId,
    audience,
    capability,
    resourceKey,
    incarnationId: input.incarnationId,
    grantCode: input.grantCode ?? input.caller.codeApproved,
    grantStore: input.grantStore,
    mission: input.mission,
    contextIntegrity: input.contextIntegrity,
    tier: input.tier,
    now,
  });
  return {
    audience,
    method: input.method,
    effect:
      input.effect ??
      (productCapability
        ? { kind: "semantic", capability: productCapability }
        : { kind: "runtime-intrinsic" }),
    capability,
    resourceKey,
    issuedAt: now,
    expiresAt: now + 60_000,
    nonce: randomUUID(),
    context,
    grants,
  };
}

export interface WorkspaceDoMethodAuthority {
  effect: RpcAuthorityEffect;
  tier: "open" | "gated" | "critical";
}

/**
 * Stamp one exact workspace-service receiver declaration. Both external direct
 * RPC and the server's internal DO dispatcher use this projection so the
 * target service grant and any independent semantic method effect cannot
 * drift into parallel authority paths.
 */
export function attestWorkspaceDoRpc(
  input: Parameters<typeof attestDirectRpc>[0] & {
    service: { name: string; principals: readonly PrincipalKind[] };
    methodAuthority: WorkspaceDoMethodAuthority;
  }
): DirectAuthorityAttestation {
  const targetCapability = `workspace-service:${input.service.name}`;
  const methodCapability =
    input.methodAuthority.effect.kind === "semantic"
      ? input.methodAuthority.effect.capability
      : targetCapability;
  const attestation = attestDirectRpc({
    ...input,
    capability: methodCapability,
    effect: input.methodAuthority.effect,
    tier: input.methodAuthority.tier,
  });
  if (methodCapability !== targetCapability) {
    const target = attestDirectRpc({
      ...input,
      capability: targetCapability,
      effect: { kind: "workspace-service" },
      tier: "gated",
    });
    attestation.grants = Object.freeze([...attestation.grants, ...target.grants]);
  }
  return {
    ...attestation,
    targetRequirement: requirementForPrincipals(input.service.principals, targetCapability),
    targetCapability,
    targetTier: "gated",
  };
}
