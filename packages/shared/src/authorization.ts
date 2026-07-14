import type {
  AuthorizationContext,
  AuthorizationDecision,
  AuthorityGrant,
  AuthorityRequirement,
  Principal,
  PrincipalKind,
  ResourceScope,
} from "@vibestudio/rpc";
import { capabilityPatternCovers } from "./authorityManifest.js";

export type {
  AuthorizationContext,
  AuthorizationDecision,
  AuthorityGrant,
  AuthorityRequirement,
  CapabilityScope,
  DirectAuthorityAttestation,
  LiveWorkspaceRelationship,
  Principal,
  PrincipalKind,
  ResourceScope,
  VerifiedDelegation,
} from "@vibestudio/rpc";

export interface AuthorityEvaluationInput {
  context: AuthorizationContext;
  requirement: AuthorityRequirement;
  resourceKey: string;
  grants: readonly AuthorityGrant[];
  now?: number;
  relation?: (input: {
    context: AuthorizationContext;
    name: Extract<AuthorityRequirement, { kind: "relationship" }>["name"];
    value?: string;
    resourceKey: string;
    now: number;
  }) => boolean;
}

export function capability(
  principal: PrincipalKind,
  name: string,
  delegation?: { audience: string; purpose: string; issuer?: Principal }
): AuthorityRequirement {
  return {
    kind: "capability",
    principal,
    capability: name,
    ...(delegation ? { delegation } : {}),
  };
}

export function allOf(...requirements: readonly AuthorityRequirement[]): AuthorityRequirement {
  if (requirements.length === 0) throw new Error("allOf requires at least one requirement");
  return { kind: "all", requirements };
}

export function anyOf(...requirements: readonly AuthorityRequirement[]): AuthorityRequirement {
  if (requirements.length === 0) throw new Error("anyOf requires at least one requirement");
  return { kind: "any", requirements };
}

export function relationship(
  name: Extract<AuthorityRequirement, { kind: "relationship" }>["name"],
  value?: string
): AuthorityRequirement {
  return { kind: "relationship", name, ...(value === undefined ? {} : { value }) };
}

/** Placeholder used by a declarative method policy before its canonical name is known. */
export const METHOD_CAPABILITY = "$method";

export function methodCapability(principal: PrincipalKind): AuthorityRequirement {
  return capability(principal, METHOD_CAPABILITY);
}

/** Bind a reusable method declaration to the canonical capability at dispatch. */
export function bindMethodCapability(
  requirement: AuthorityRequirement,
  capabilityName: string
): AuthorityRequirement {
  if (requirement.kind === "capability") {
    return requirement.capability === METHOD_CAPABILITY
      ? { ...requirement, capability: capabilityName }
      : requirement;
  }
  if (requirement.kind === "all" || requirement.kind === "any") {
    return {
      ...requirement,
      requirements: requirement.requirements.map((child) =>
        bindMethodCapability(child, capabilityName)
      ),
    };
  }
  return requirement;
}

/** Canonical R3A requirement for a method's explicitly admitted principals. */
export function requirementForPrincipals(
  principals: readonly PrincipalKind[],
  capabilityName: string
): AuthorityRequirement {
  const unique = [...new Set(principals)];
  if (unique.length === 0) throw new Error("An authority declaration requires a principal");
  const requirements = unique.map((principal): AuthorityRequirement => {
    const grant = capability(principal, capabilityName);
    switch (principal) {
      case "host":
        return grant;
      case "user":
      case "code":
        return allOf(grant, relationship("workspace-member"));
      case "device":
        return allOf(
          grant,
          relationship("device-owned-by-user"),
          relationship("workspace-member")
        );
      case "entity":
        return allOf(
          grant,
          relationship("agent-binding"),
          relationship("workspace-member")
        );
    }
  });
  return requirements.length === 1 ? requirements[0]! : anyOf(...requirements);
}

/**
 * Evaluates one complete compound requirement. Capabilities are checked only
 * against the named principal; grants from other principals are never unioned.
 */
export function evaluateAuthority(input: AuthorityEvaluationInput): AuthorizationDecision {
  const now = input.now ?? Date.now();
  if (!input.resourceKey || input.resourceKey !== input.resourceKey.trim()) {
    throw new Error("Authority resource key must be a non-empty canonical string");
  }
  const evaluate = (requirement: AuthorityRequirement): AuthorizationDecision => {
    if (requirement.kind === "all") {
      for (const child of requirement.requirements) {
        const decision = evaluate(child);
        if (!decision.allowed) return { ...decision, requirement };
      }
      return { allowed: true, code: "allowed", reason: "all requirements satisfied", requirement };
    }
    if (requirement.kind === "any") {
      const decisions = requirement.requirements.map(evaluate);
      const allowed = decisions.find((decision) => decision.allowed);
      return allowed
        ? { allowed: true, code: "allowed", reason: allowed.reason, requirement }
        : {
            allowed: false,
            code: decisions.some((decision) => decision.code === "denied")
              ? "denied"
              : "missing-grant",
            reason: decisions.map((decision) => decision.reason).join("; "),
            requirement,
          };
    }
    if (requirement.kind === "session") {
      const session = input.context.session;
      const allowed =
        session.expiresAt > now &&
        (requirement.audience === undefined || session.audience === requirement.audience) &&
        (requirement.minVersion === undefined ||
          compareVersions(session.version, requirement.minVersion) >= 0);
      return {
        allowed,
        code: allowed ? "allowed" : "session",
        reason: allowed ? "session constraints satisfied" : "session constraint failed",
        requirement,
      };
    }
    if (requirement.kind === "relationship") {
      const allowed = input.relation
        ? input.relation({
            context: input.context,
            name: requirement.name,
            ...(requirement.value === undefined ? {} : { value: requirement.value }),
            resourceKey: input.resourceKey,
            now,
          })
        : builtinRelationship(input.context, requirement.name, requirement.value, now);
      return {
        allowed,
        code: allowed ? "allowed" : "relationship",
        reason: allowed
          ? `relationship ${requirement.name} satisfied`
          : `relationship ${requirement.name} not satisfied`,
        requirement,
      };
    }

    const principal = principalFor(input.context, requirement.principal);
    if (!principal) {
      return {
        allowed: false,
        code: "missing-principal",
        reason: `authenticated ${requirement.principal} principal is required`,
        requirement,
      };
    }
    if (!isCanonicalPrincipal(principal, requirement.principal)) {
      return {
        allowed: false,
        code: "missing-principal",
        reason: `authenticated ${requirement.principal} principal is malformed`,
        requirement,
      };
    }
    if (requirement.principal === "code") {
      const manifest = input.context.codeManifest;
      const requested =
        manifest?.principal === principal &&
        manifest.requested.some(
          (scope) =>
            capabilityPatternCovers(scope.capability, requirement.capability) &&
            scopeCovers(scope.resource, input.resourceKey)
        );
      if (!requested) {
        return {
          allowed: false,
          code: "not-requested",
          reason: `${principal} did not request ${requirement.capability} for ${input.resourceKey}`,
          requirement,
          principal,
        };
      }
    }
    const matching = input.grants.filter(
      (grant) =>
        grant.subject === principal &&
        capabilityPatternCovers(grant.capability, requirement.capability) &&
        grant.createdAt <= now &&
        (grant.revokedAt === undefined || grant.revokedAt > now) &&
        (grant.expiresAt === undefined || grant.expiresAt > now) &&
        grantConstraintsMatch(grant, input.context) &&
        scopeCovers(grant.resource, input.resourceKey)
    );
    const denied = matching.some((grant) => grant.effect === "deny");
    if (denied) {
      return {
        allowed: false,
        code: "denied",
        reason: `${principal} is explicitly denied ${requirement.capability} on ${input.resourceKey}`,
        requirement,
        principal,
      };
    }
    const allowed = matching.some((grant) => grant.effect === "allow");
    if (allowed && requirement.delegation) {
      const delegated = input.context.delegation.some(
        (delegation) =>
          delegation.subject === principal &&
          delegation.audience === requirement.delegation?.audience &&
          delegation.audience === input.context.session.audience &&
          delegation.purpose === requirement.delegation?.purpose &&
          (requirement.delegation?.issuer === undefined ||
            delegation.issuer === requirement.delegation.issuer) &&
          (delegation.revokedAt === undefined || delegation.revokedAt > now) &&
          (delegation.notBefore === undefined || delegation.notBefore <= now) &&
          delegation.expiresAt > now &&
          delegation.capabilities.some(
            (scope) =>
              capabilityPatternCovers(scope.capability, requirement.capability) &&
              scopeCovers(scope.resource, input.resourceKey)
          )
      );
      if (!delegated) {
        return {
          allowed: false,
          code: "delegation",
          reason: `${principal} lacks a live attenuated delegation for ${requirement.capability}`,
          requirement,
          principal,
        };
      }
    }
    return {
      allowed,
      code: allowed ? "allowed" : "missing-grant",
      reason: allowed
        ? `${principal} is granted ${requirement.capability}`
        : `${principal} lacks ${requirement.capability} on ${input.resourceKey}`,
      requirement,
      principal,
    };
  };
  return evaluate(input.requirement);
}

function principalFor(context: AuthorizationContext, kind: PrincipalKind): Principal | null {
  switch (kind) {
    case "host":
      return context.host;
    case "user":
      return context.actingUser;
    case "device":
      return context.device;
    case "code":
      return context.code;
    case "entity":
      return context.entity;
  }
}

function scopeCovers(scope: ResourceScope, key: string): boolean {
  switch (scope.kind) {
    case "exact":
      return scope.key === key;
    case "prefix":
      return scope.prefix === "" || key === scope.prefix || key.startsWith(`${scope.prefix}/`);
    case "origin":
      return key === scope.origin;
    case "domain": {
      const hostname = resourceHostname(key);
      return Boolean(
        hostname && (hostname === scope.domain || hostname.endsWith(`.${scope.domain}`))
      );
    }
    case "network":
      return true;
  }
}

function resourceHostname(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

function builtinRelationship(
  context: AuthorizationContext,
  name: Extract<AuthorityRequirement, { kind: "relationship" }>["name"],
  value: string | undefined,
  now: number
): boolean {
  switch (name) {
    case "workspace-member":
      return context.workspace?.member === true;
    case "workspace-role":
      return context.workspace?.member === true && context.workspace.role === value;
    case "device-owned-by-user":
      return Boolean(
        context.device &&
          context.actingUser &&
          context.deviceOwnership?.device === context.device &&
          context.deviceOwnership.user === context.actingUser
      );
    case "entity-self":
      return context.entity !== null && (value === undefined || context.entity === value);
    case "entity-owner":
      return context.entity !== null && context.ownerChain.includes(context.actingUser as Principal);
    case "entity-deputy":
      return (
        context.entity !== null &&
        context.ownerChain.slice(1).includes(context.actingUser as Principal)
      );
    case "channel-owner":
    case "channel-editor":
    case "channel-member":
      // Channel relations require a live lookup from the owning channel service.
      return false;
    case "agent-binding":
      return context.agentBinding?.entity === context.entity;
    case "code-source": {
      if (!context.code || value === undefined) return false;
      const match = /^code:([^@]+)@[0-9a-f]{64}$/.exec(context.code);
      const repoPath = match?.[1];
      return Boolean(repoPath && (value.endsWith("/") ? repoPath.startsWith(value) : repoPath === value));
    }
    case "delegation":
      return context.delegation.some(
        (delegation) =>
          (delegation.revokedAt === undefined || delegation.revokedAt > now) &&
          (delegation.notBefore === undefined || delegation.notBefore <= now) &&
          delegation.expiresAt > now &&
          delegation.audience === context.session.audience &&
          (value === undefined || delegation.purpose === value)
      );
  }
}

function grantConstraintsMatch(grant: AuthorityGrant, context: AuthorizationContext): boolean {
  const constraints = grant.constraints;
  if (!constraints) return true;
  if (constraints.sessionId !== undefined && constraints.sessionId !== context.session.id) {
    return false;
  }
  if (
    constraints.minVersion !== undefined &&
    compareVersions(context.session.version, constraints.minVersion) < 0
  ) {
    return false;
  }
  return !(
    constraints.maxVersion !== undefined &&
    compareVersions(context.session.version, constraints.maxVersion) > 0
  );
}

function isCanonicalPrincipal(principal: Principal, expected: PrincipalKind): boolean {
  if (!principal.startsWith(`${expected}:`) || principal.length <= expected.length + 1) return false;
  if (expected !== "code") return true;
  return /^code:[^@]+@[0-9a-f]{64}$/.test(principal);
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map((part) => Number.parseInt(part, 10));
  const b = right.split(".").map((part) => Number.parseInt(part, 10));
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}
