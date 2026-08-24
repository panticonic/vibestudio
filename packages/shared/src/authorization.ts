import type {
  AuthorizationContext,
  AuthorizationDecision,
  AuthorityFailureInfo,
  AuthorityGrant,
  AuthorityGrantSubject,
  AuthorityLock,
  AuthorityRequirement,
  Principal,
  PrincipalKind,
  ResourceScope,
} from "@vibestudio/rpc";
import { capabilityPatternCovers } from "./authorityManifest.js";
import { capability } from "./authorityRequirements.js";

export {
  allOf,
  anyOf,
  capability,
  relationship,
  requirementForPrincipals,
} from "./authorityRequirements.js";

export type {
  AuthorizationContext,
  AuthorizationDecision,
  AuthorityGrant,
  AuthorityRequirement,
  CapabilityScope,
  ContextIntegrityFact,
  ExecutionAdmissionFact,
  AttachedHostExecutionFact,
  LiveWorkspaceRelationship,
  Principal,
  PrincipalKind,
  ResourceScope,
} from "@vibestudio/rpc";

export interface AuthorityEvaluationInput {
  context: AuthorizationContext;
  requirement: AuthorityRequirement;
  resourceKey: string;
  grants: readonly AuthorityGrant[];
  locks?: readonly AuthorityLock[];
  now?: number;
  /** Critical confirmation checks bind to the concrete invocation. */
  invocationDigest?: string;
  /** Live receiver digest used only by version-scoped grant constraints. */
  providerExecutionDigest?: string;
  /** Critical ignores ordinary grants and admits only a fresh confirmation. */
  tier?: "open" | "gated" | "critical";
  relation?: (input: {
    context: AuthorizationContext;
    name: Extract<AuthorityRequirement, { kind: "relationship" }>["name"];
    value?: string;
    resourceKey: string;
    now: number;
  }) => boolean;
}

/** Convert one canonical denial into stable agent/UI remediation data. */
export function authorityFailureForDecision(
  decision: AuthorizationDecision,
  input: {
    capability: string;
    resourceKey: string;
    tier: "open" | "gated" | "critical";
  }
): AuthorityFailureInfo {
  if (decision.allowed || decision.code === "allowed") {
    throw new Error("An allowed authority decision has no failure remediation");
  }
  const common = {
    reasonCode: decision.code,
    reason: decision.reason,
    capability: input.capability,
    resourceKey: input.resourceKey,
  } as const;
  switch (decision.code) {
    case "approval-required":
      return {
        ...common,
        remediation: {
          kind: "request-user-approval",
          message: "Request user approval, then retry the exact invocation.",
        },
      };
    case "operation-policy-denied":
      return {
        ...common,
        remediation: {
          kind: "edit-mission",
          message:
            "This operation is outside the active automation policy. Edit the automation before retrying it.",
        },
      };
    case "fixed-code-not-requested":
      return {
        ...common,
        remediation: {
          kind: "update-installed-code-manifest",
          message:
            "Add this authority request to the installed unit manifest, then submit the new exact version for user review.",
          request: {
            capability: input.capability,
            resource: { kind: "exact", key: input.resourceKey },
            tier: input.tier === "critical" ? "critical" : "gated",
          },
        },
      };
    case "receiver-rejected":
      return {
        ...common,
        remediation: {
          kind: "use-admitted-principal",
          message: "Invoke this method through a principal admitted by its receiver contract.",
        },
      };
    case "invalid-session":
      return {
        ...common,
        remediation: {
          kind: "refresh-session",
          message: "Refresh the authenticated authority session and retry.",
        },
      };
    case "invalid-attestation":
      return {
        ...common,
        remediation: {
          kind: "retry-through-host",
          message: "Retry through the host route that creates a fresh authority attestation.",
        },
      };
    case "user-denied":
      return {
        ...common,
        remediation: {
          kind: "respect-denial",
          message: "The user denied or locked this action; do not retry automatically.",
        },
      };
  }
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

/**
 * Seal a receiver-authored requirement into the canonical capability selected
 * by the host. Userland receiver schemas are necessarily written in their
 * provider-local vocabulary, while grants and installed-code manifests use the
 * build-bound `userland:...#digest` identity. Both the generic method
 * placeholder and the exact local receiver name therefore denote the same
 * canonical capability at the receiver boundary.
 */
export function bindReceiverCapability(
  requirement: AuthorityRequirement,
  localCapability: string,
  canonicalCapability: string
): AuthorityRequirement {
  if (requirement.kind === "capability") {
    return requirement.capability === METHOD_CAPABILITY ||
      requirement.capability === localCapability
      ? { ...requirement, capability: canonicalCapability }
      : requirement;
  }
  if (requirement.kind === "all" || requirement.kind === "any") {
    return {
      ...requirement,
      requirements: requirement.requirements.map((child) =>
        bindReceiverCapability(child, localCapability, canonicalCapability)
      ),
    };
  }
  return requirement;
}

/**
 * Evaluates a complete compound requirement against exactly one authority set.
 * Session origins may expose two exact subject facets (session and authenticated
 * mission), but grants from users, harness code, entities, and other sessions are
 * never unioned into that set. Deny precedence is uniform across both facets.
 */
export function evaluateAuthority(input: AuthorityEvaluationInput): AuthorizationDecision {
  const now = input.now ?? Date.now();
  if (!input.resourceKey || input.resourceKey !== input.resourceKey.trim()) {
    throw new Error("Authority resource key must be a non-empty canonical string");
  }
  const authoritySubjects = new Set(subjectsForOrigin(input.context));
  // Critical confirmation is always a one-shot fact of the authenticated
  // session, including when installed code remains the authorizing origin for
  // manifest confinement. This adds only the exact confirmation subject; it
  // does not union ordinary session grants into code authority.
  if (input.tier === "critical") {
    authoritySubjects.add(`session:${input.context.session.id}`);
  }

  const evaluate = (requirement: AuthorityRequirement): AuthorizationDecision => {
    if (requirement.kind === "all") {
      let consumable: AuthorizationDecision | null = null;
      for (const child of requirement.requirements) {
        const decision = evaluate(child);
        if (!decision.allowed) return { ...decision, requirement };
        if (decision.consumable) {
          if (consumable && consumable.grantId !== decision.grantId) {
            throw new Error(
              "One compound authority leaf cannot merge multiple single-use confirmations"
            );
          }
          consumable = decision;
        }
      }
      return {
        allowed: true,
        code: "allowed",
        reason: "all requirements satisfied",
        requirement,
        ...(consumable?.principal ? { principal: consumable.principal } : {}),
        ...(consumable?.grantId ? { grantId: consumable.grantId } : {}),
        ...(consumable ? { consumable: true } : {}),
      };
    }
    if (requirement.kind === "any") {
      const matching = requirement.requirements.filter((child) =>
        requirementMatchesOrigin(child, input.context)
      );
      if (matching.length === 0) {
        return {
          allowed: false,
          code: "receiver-rejected",
          reason: `no authority branch admits the ${input.context.authorizingOrigin.kind} origin`,
          requirement,
        };
      }
      const decisions = matching.map(evaluate);
      const allowed = decisions.find((decision) => decision.allowed);
      if (allowed) return { ...allowed, requirement };
      return {
        allowed: false,
        code: decisions.some((decision) => decision.code === "user-denied")
          ? "user-denied"
          : decisions.some((decision) => decision.code === "fixed-code-not-requested")
            ? "fixed-code-not-requested"
            : decisions.some((decision) => decision.code === "invalid-session")
              ? "invalid-session"
              : decisions.some((decision) => decision.code === "receiver-rejected")
                ? "receiver-rejected"
                : "approval-required",
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
        code: allowed ? "allowed" : "invalid-session",
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
        : builtinRelationship(input.context, requirement.name, requirement.value);
      return {
        allowed,
        code: allowed ? "allowed" : "receiver-rejected",
        reason: allowed
          ? `relationship ${requirement.name} satisfied`
          : `relationship ${requirement.name} not satisfied`,
        requirement,
      };
    }

    const principal = principalForRequirement(input.context, requirement);
    if (!principal) {
      return {
        allowed: false,
        code: "receiver-rejected",
        reason: `authenticated ${requirement.principal} principal is required`,
        requirement,
      };
    }
    if (!isCanonicalPrincipal(principal)) {
      return {
        allowed: false,
        code: "receiver-rejected",
        reason: `authenticated ${requirement.principal} principal is malformed`,
        requirement,
      };
    }

    // Open waives only the request/grant requirement. Principal-family and
    // relationship checks in the surrounding requirement still run.
    if (input.tier === "open") {
      return {
        allowed: true,
        code: "allowed",
        reason: `${principal} is admitted to open capability ${requirement.capability}`,
        requirement,
        principal,
      };
    }

    const standingLock = input.locks?.[0];
    if (standingLock) {
      return {
        allowed: false,
        code: "user-denied",
        reason: `The user locked ${requirement.capability} for this agent`,
        requirement,
        principal,
        grantId: standingLock.id,
        standing: true,
      };
    }

    // Installed code is bounded by its exact manifest. Host-admitted evaluated
    // sessions use executingCode only for attribution and confinement.
    if (input.context.authorizingOrigin.kind === "code") {
      const manifest = input.context.executingCode;
      const requested =
        manifest !== null &&
        manifest.principal === principal &&
        manifest.requested.some(
          (scope) =>
            capabilityPatternCovers(scope.capability, requirement.capability) &&
            scopeCovers(scope.resource, input.resourceKey)
        );
      if (!requested) {
        const manifestDetail =
          manifest === null
            ? "no sealed code manifest was attached"
            : manifest.principal !== principal
              ? `the attached manifest belongs to ${manifest.principal}`
              : (() => {
                  const sameResourceCapabilities = manifest.requested
                    .filter((scope) => scopeCovers(scope.resource, input.resourceKey))
                    .map((scope) => scope.capability)
                    .slice(0, 3);
                  return sameResourceCapabilities.length > 0
                    ? `same-resource declarations: ${sameResourceCapabilities.join(", ")}`
                    : "no declaration covers the resource";
                })();
        return {
          allowed: false,
          code: "fixed-code-not-requested",
          reason: `${principal} did not request ${requirement.capability} for ${input.resourceKey} (${manifestDetail})`,
          requirement,
          principal,
        };
      }
    }

    const candidates = input.grants.filter(
      (grant) =>
        authoritySubjects.has(grant.subject) &&
        capabilityPatternCovers(grant.capability, requirement.capability) &&
        grant.createdAt <= now &&
        (grant.revokedAt === undefined || grant.revokedAt > now) &&
        (grant.expiresAt === undefined || grant.expiresAt > now) &&
        grantConstraintsMatch(
          grant,
          input.context,
          input.invocationDigest,
          input.providerExecutionDigest
        ) &&
        scopeCovers(grant.resource, input.resourceKey)
    );

    // Invocation-bound grants are single-use at every tier. Keeping a consumed
    // gated grant eligible makes the dispatcher select it, fail its atomic
    // consume, and retry the same stale row forever. Standing grants have no
    // invocation digest and remain reusable.
    const unconsumedCandidates = candidates.filter(
      (grant) =>
        grant.effect === "deny" ||
        grant.constraints?.invocationDigest === undefined ||
        grant.consumedAt === undefined
    );

    // A critical exercise is authorized only by an unconsumed confirmation for
    // this exact invocation; ordinary standing/session grants are invisible.
    const tierCandidates =
      input.tier === "critical"
        ? unconsumedCandidates.filter(
            (grant) =>
              grant.provenance === "critical-confirmation" &&
              grant.constraints?.invocationDigest === input.invocationDigest
          )
        : unconsumedCandidates;

    const denied = candidates.find((grant) => grant.effect === "deny");
    if (denied) {
      return {
        allowed: false,
        code: "user-denied",
        reason: `${principal} is explicitly denied ${requirement.capability} on ${input.resourceKey}`,
        requirement,
        principal,
        ...(denied.id ? { grantId: denied.id } : {}),
        standing: denied.constraints?.sessionId === undefined,
      };
    }
    const lineageRejected = tierCandidates.some(
      (grant) => grant.effect === "allow" && !lineageAtConsentCovers(grant, input.context)
    );
    const allowed = tierCandidates.find(
      (grant) => grant.effect === "allow" && lineageAtConsentCovers(grant, input.context)
    );
    if (!allowed && lineageRejected) {
      return {
        allowed: false,
        code: "approval-required",
        reason: `${principal} has authority, but new outside content entered the session`,
        requirement,
        principal,
      };
    }
    return {
      allowed: Boolean(allowed),
      code: allowed ? "allowed" : "approval-required",
      reason: allowed
        ? `${principal} is granted ${requirement.capability}`
        : `${principal} lacks ${requirement.capability} on ${input.resourceKey}`,
      requirement,
      principal,
      ...(allowed?.id ? { grantId: allowed.id } : {}),
      ...(allowed?.constraints?.invocationDigest ? { consumable: true } : {}),
    };
  };
  return evaluate(input.requirement);
}

export function subjectsForOrigin(
  context: AuthorizationContext
): ReadonlySet<AuthorityGrantSubject> {
  const subjects = new Set<AuthorityGrantSubject>([context.authorizingOrigin.principal]);
  if (context.session.taskAuthority) subjects.add(context.session.taskAuthority);
  if (
    context.authorizingOrigin.kind === "session" &&
    context.executionSession?.agentBinding?.bindingId
  ) {
    subjects.add(`agent:${context.executionSession.agentBinding.bindingId}`);
  }
  if (context.authorizingOrigin.kind === "session" && context.executionSession?.mission) {
    subjects.add(context.executionSession.mission.subject);
  }
  return subjects;
}

function principalForRequirement(
  context: AuthorizationContext,
  requirement: Extract<AuthorityRequirement, { kind: "capability" }>
): Principal | null {
  const kind = requirement.principal;
  const origin = context.authorizingOrigin;
  if (kind === origin.kind) return origin.principal;
  // Declared code methods admit eval sessions by family mapping.
  if (kind === "code" && origin.kind === "session" && requirement.codeOnly !== true) {
    return origin.principal;
  }
  if (kind === "mission" && origin.kind === "session" && context.executionSession?.mission) {
    return context.executionSession.mission.subject;
  }
  return null;
}

export function scopeCovers(scope: ResourceScope, key: string): boolean {
  switch (scope.kind) {
    case "exact":
      return scope.key === key;
    case "prefix": {
      if (scope.prefix === "" || key === scope.prefix) return true;
      if (!key.startsWith(scope.prefix)) return false;
      // A bare name is a hierarchical namespace and must end at a slash
      // boundary (`context` must not cover `contextual`). A prefix ending in a
      // separator is already an explicit lexical namespace, which lets
      // manifests truthfully describe bounded dynamic names such as
      // `workspace-repo-delete:projects/system-test-*`.
      return /[#/:._-]$/u.test(scope.prefix) || key[scope.prefix.length] === "/";
    }
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

/** Exact set containment between two semantic resource envelopes. */
export function resourceScopeContains(parent: ResourceScope, child: ResourceScope): boolean {
  if (child.kind === "exact") return scopeCovers(parent, child.key);
  if (parent.kind !== child.kind) return false;
  switch (parent.kind) {
    case "prefix":
      return child.kind === "prefix" && child.prefix.startsWith(parent.prefix);
    case "origin":
      return child.kind === "origin" && child.origin === parent.origin;
    case "domain":
      return child.kind === "domain" && child.domain === parent.domain;
    case "network":
      return child.kind === "network";
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
  value: string | undefined
): boolean {
  switch (name) {
    case "workspace-member":
      return context.workspace?.member === true;
    case "workspace-role":
      return context.workspace?.member === true && context.workspace.role === value;
    case "entity-self":
      return context.entity !== null && (value === undefined || context.entity === value);
    case "entity-owner":
      return (
        context.entity !== null &&
        context.actingUser !== null &&
        context.ownerChain.includes(context.actingUser)
      );
    case "agent-binding":
      return context.entity !== null && context.agentBinding?.entity === context.entity;
    case "code-source": {
      const code = context.executingCode?.principal;
      if (!code || value === undefined) return false;
      const match = /^code:([^@]+)@[0-9a-f]{64}$/.exec(code);
      const repoPath = match?.[1];
      return Boolean(
        repoPath && (value.endsWith("/") ? repoPath.startsWith(value) : repoPath === value)
      );
    }
    case "context-integrity":
      return context.contextIntegrity?.class !== "external";
    case "closure-internal":
      // Only the receiver's attested-chain relation resolver can satisfy this.
      return false;
  }
}

function requirementMatchesOrigin(
  requirement: AuthorityRequirement,
  context: AuthorizationContext
): boolean {
  if (requirement.kind === "capability") {
    return principalForRequirement(context, requirement) !== null;
  }
  if (requirement.kind === "all") {
    const capabilities = requirement.requirements.filter(containsCapabilityRequirement);
    return (
      capabilities.length === 0 ||
      capabilities.some((child) => requirementMatchesOrigin(child, context))
    );
  }
  if (requirement.kind === "any") {
    return requirement.requirements.some((child) => requirementMatchesOrigin(child, context));
  }
  return true;
}

function containsCapabilityRequirement(requirement: AuthorityRequirement): boolean {
  if (requirement.kind === "capability") return true;
  if (requirement.kind === "all" || requirement.kind === "any") {
    return requirement.requirements.some(containsCapabilityRequirement);
  }
  return false;
}

function grantConstraintsMatch(
  grant: AuthorityGrant,
  context: AuthorizationContext,
  invocationDigest: string | undefined,
  providerExecutionDigest: string | undefined
): boolean {
  const constraints = grant.constraints;
  if (!constraints) return true;
  if (constraints.sessionId !== undefined && constraints.sessionId !== context.session.id)
    return false;
  if (constraints.taskRef !== undefined && constraints.taskRef !== context.session.taskRef)
    return false;
  if (
    constraints.agentBindingId !== undefined &&
    constraints.agentBindingId !== context.executionSession?.agentBinding?.bindingId
  )
    return false;
  if (
    constraints.invocationDigest !== undefined &&
    constraints.invocationDigest !== invocationDigest
  )
    return false;
  if (
    constraints.providerExecutionDigest !== undefined &&
    constraints.providerExecutionDigest !== providerExecutionDigest
  )
    return false;
  if (constraints.missionSubject !== undefined) {
    const mission = context.executionSession?.mission;
    if (!mission || constraints.missionSubject !== mission.subject) return false;
  }
  return true;
}

function lineageAtConsentCovers(grant: AuthorityGrant, context: AuthorizationContext): boolean {
  const integrity = context.contextIntegrity;
  // P3 interim semantics: no latch fact means no lineage gate yet.
  if (!integrity || integrity.class === "not-applicable") return true;
  const consented = new Set(grant.constraints?.lineageAtConsent ?? []);
  return lineageClasses(integrity).every((lineageClass) => consented.has(lineageClass));
}

export function lineageClasses(
  integrity: import("@vibestudio/rpc").ContextIntegrityFact
): readonly string[] {
  if (integrity.class !== "external") return ["none"];
  const classes = new Set<string>();
  for (const key of integrity.externalKeys) {
    const prefix = key.split(":", 1)[0]?.toLowerCase();
    classes.add(
      prefix === "web" || prefix === "email" || prefix === "channel"
        ? prefix === "channel"
          ? "channel-external"
          : prefix
        : "external"
    );
  }
  return [...classes].sort();
}

/**
 * Structural well-formedness only.
 *
 * A principal's safety comes from being host-constructed out of authenticated
 * facts, never from its shape, so this rejects malformed strings rather than
 * asserting what a version looks like. Code principals in particular name a
 * reviewed unit version rather than a build digest, and "versions are sha256"
 * is an assumption about the current effective-version scheme that authorization
 * has no business hard-coding.
 */
function isCanonicalPrincipal(principal: Principal): boolean {
  if (/^(host|user|session):[^:][^\0]*$/.test(principal)) return true;
  if (/^agent:[^:][^\0]*$/.test(principal)) return true;
  return /^(code|mission):[^@\0]+@[^@\0]+$/.test(principal);
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
