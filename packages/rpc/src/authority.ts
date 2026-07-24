/** Wire-safe authority facts shared by host-service and direct-RPC dispatch. */

export type PrincipalKind = "host" | "user" | "code" | "session" | "mission";
export type Principal = `${PrincipalKind}:${string}`;
export type AgentGrantPrincipal = `agent:${string}`;
export type AuthorityGrantSubject = Principal | AgentGrantPrincipal;
export type EntityPrincipal = `entity:${string}`;

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

export interface LiveWorkspaceRelationship {
  workspaceId: string;
  member: boolean;
  role: string | null;
  revision: string;
}

/** Exactly one origin authorizes a call. Entity and device identity are facts, never grant subjects. */
export type AuthorizationOrigin =
  | { kind: "code"; principal: `code:${string}` }
  | { kind: "user"; principal: `user:${string}` }
  | { kind: "host"; principal: `host:${string}` }
  | { kind: "session"; principal: `session:${string}` };

export interface ContextIntegrityFact {
  class: "internal" | "external" | "not-applicable";
  latchEpoch: number;
  externalKeys: readonly string[];
}

export interface CodeLineageFact {
  class: "internal" | "external" | "unknown";
  externalKeys: readonly string[];
}

export interface SessionMissionFact {
  missionId: string;
  closureDigest: string;
  harness: { unit: string; ev: string };
}

export type AgentExecutionMode = "interactive" | "mission" | "test";

export interface AgentExecutionTestAuthorityRule {
  ruleId: string;
  capability: string;
  resource: ResourceScope;
  tier: "gated" | "critical";
  decision: "once" | "deny";
}

export interface AgentExecutionTestUserlandRule {
  ruleId: string;
  subjectId: string;
  decision: string;
  remember: boolean;
}

export interface AgentExecutionTestCasePolicy {
  testId: string;
  authority: readonly AgentExecutionTestAuthorityRule[];
  userland: readonly AgentExecutionTestUserlandRule[];
  unexpectedPrompts: "fail";
}

export type AgentExecutionTestPolicy =
  | {
      policyId: string;
      kind: "orchestrator";
    }
  | {
      policyId: string;
      kind: "case";
      orchestratorPolicyId: string;
      case: AgentExecutionTestCasePolicy;
    };

export interface AgentExecutionTestPolicySpec {
  testId: string;
  authority: readonly AgentExecutionTestAuthorityRule[];
  userland: readonly AgentExecutionTestUserlandRule[];
  unexpectedPrompts: "fail";
}

/**
 * Host-created proof that one concrete EvalDO run belongs to a live task,
 * approved mission, or test policy. It is relationship evidence, never a
 * capability token and never accepted from caller input.
 */
export interface AgentExecutionSessionFact {
  v: 1;
  authoritySessionId: string;
  authoritySessionVersion: number;
  mode: AgentExecutionMode;
  ownerUser: `user:${string}`;
  workspaceId: string;
  contextId: string;
  agentBinding: {
    entityId: string;
    channelId: string;
    bindingId: string;
  } | null;
  taskRef: string;
  harness: {
    principal: `code:${string}`;
    repoPath: string;
    effectiveVersion: string;
  };
  eval: {
    runtimeId: string;
    runId: string;
  };
  causalParent: {
    logId: string;
    head: string;
    invocationId: string;
  } | null;
  mission?: SessionMissionFact;
  testPolicy?: AgentExecutionTestPolicy;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

/**
 * Every field is constructed from authenticated transport and live host state.
 * The harness is a conduit: its identity is a fact, while session/mission grants
 * authorize eval calls directly.
 */
export interface AuthorizationContext {
  authorizingOrigin: AuthorizationOrigin;
  host: `host:${string}` | null;
  actingUser: `user:${string}` | null;
  entity: EntityPrincipal | null;
  incarnation: string | null;
  executingCode: {
    principal: `code:${string}`;
    requested: readonly CapabilityScope[];
    sourceLineage: CodeLineageFact;
  } | null;
  initiatorChain: readonly string[];
  ownerChain: readonly `user:${string}`[];
  agentBinding: { entity: EntityPrincipal; contextId: string; channelId: string } | null;
  executionSession: AgentExecutionSessionFact | null;
  /**
   * Host-attested unattended-test policy for the live execution context.
   *
   * An evaluated run carries this through `executionSession`. Reviewed
   * infrastructure code created inside that run's context carries the same
   * policy without pretending to be the eval/session author. Its code origin
   * and manifest confinement therefore remain intact while gated test
   * invocations can settle without a nonexistent human approver.
   */
  testPolicy: AgentExecutionTestPolicy | null;
  workspace: LiveWorkspaceRelationship | null;
  session: {
    id: string;
    audience: string;
    version: string;
    expiresAt: number;
    mission?: SessionMissionFact;
    mediatingHarness?: `code:${string}`;
    taskRef?: string;
  };
  contextIntegrity: ContextIntegrityFact | null;
}

export interface AuthorityGrantConstraints {
  sessionId?: string;
  invocationDigest?: string;
  missionSubject?: `mission:${string}`;
  envelopeId?: string;
  lineageAtConsent?: readonly string[];
  taskRef?: string;
  agentBindingId?: string;
}

export interface AuthorityGrant extends CapabilityScope {
  id?: string;
  subject: AuthorityGrantSubject;
  effect: "allow" | "deny";
  issuedBy: string;
  createdAt: number;
  expiresAt?: number;
  revokedAt?: number;
  consumedAt?: number;
  suspendedAt?: number;
  lastUsedAt?: number;
  scope?: "once" | "task" | "agent" | "mission" | "version" | "session" | "system";
  constraints?: AuthorityGrantConstraints;
  provenance: string;
  decidedBy?: string;
  decisionSurface?: string;
}

export interface AuthorityLock {
  id: string;
  agentBindingId: string;
  level: "resource" | "capability" | "cell" | "agent" | "workspace";
  capability?: string;
  resource?: ResourceScope;
  domain?: string;
  verb?: string;
  decidedBy: string;
  surface: "card" | "profile";
  createdAt: number;
  revokedAt?: number;
  attemptCount: number;
  lastAttemptAt?: number;
}

export type AuthorityRequirement =
  | { kind: "capability"; principal: PrincipalKind; capability: string; codeOnly?: true }
  | {
      kind: "relationship";
      name:
        | "workspace-member"
        | "workspace-role"
        | "entity-self"
        | "entity-owner"
        | "agent-binding"
        | "code-source"
        | "context-integrity"
        | "closure-internal";
      value?: string;
    }
  | { kind: "session"; audience?: string; minVersion?: string }
  | { kind: "all"; requirements: readonly AuthorityRequirement[] }
  | { kind: "any"; requirements: readonly AuthorityRequirement[] };

export interface AuthorizationDecision {
  allowed: boolean;
  code:
    | "allowed"
    | "approval-required"
    | "mission-change-required"
    | "user-denied"
    | "receiver-rejected"
    | "fixed-code-not-requested"
    | "invalid-session"
    | "invalid-attestation";
  reason: string;
  requirement: AuthorityRequirement;
  principal?: Principal;
  grantId?: string;
  consumable?: boolean;
  standing?: boolean;
}

export interface InvocationSnapshot {
  v: 1;
  service: string;
  method: string;
  capability: string;
  /** Additional live target-declaration requirement, composed with the method declaration. */
  targetRequirement?: AuthorityRequirement;
  targetCapability?: string;
  resourceKey: string;
  argsDigest: string;
  preparedStateDigest: string;
  callerPrincipal: Principal;
  sessionId: string;
  taskRef?: string;
  agentBindingId?: string;
  agentName?: string;
  lineageClasses?: readonly string[];
  irreversible?: boolean;
  agentScopeEligible?: boolean;
  executionMode?: AgentExecutionMode;
  testPolicyId?: string;
  mission: `mission:${string}` | "-";
  snippetDigest: string;
  codeLineage: { class: CodeLineageFact["class"]; chain: readonly string[] };
  contextLineage: ContextIntegrityFact | null;
  initiatorChain: readonly string[];
  at: number;
}

export interface AcquisitionInfo {
  acquisitionId: string;
  /** Exact runtime that originated the protected invocation. */
  ownerRuntimeId: string;
  snapshotDigest: string;
  capability: string;
  resourceKey: string;
  tier: "gated" | "critical";
  cardType: "permission.gated" | "permission.outside" | "confirm.critical";
  renderedAction: string;
  pending: boolean;
  /** The host has minted an exact invocation grant; the receiver may retry
   * authorization inline without entering the human-decision rendezvous. */
  preauthorized?: true;
  cooldownUntil?: number;
  decidedBy?: "user" | "rule";
}

export type AuthorityFailureReasonCode =
  | Exclude<AuthorizationDecision["code"], "allowed">
  | "receiver-undeclared"
  | "attestation-required"
  | "attestation-invalid"
  | "eval-read-only";

export type AuthorityRemediationKind =
  | "request-user-approval"
  | "request-mission-change"
  | "update-installed-code-manifest"
  | "declare-rpc-receiver"
  | "use-admitted-principal"
  | "satisfy-relationship"
  | "refresh-session"
  | "respect-denial"
  | "use-writable-session"
  | "retry-through-host";

/**
 * Machine-readable explanation for an authority refusal. Callers and agents
 * must branch on this object rather than parsing the human diagnostic.
 */
export interface AuthorityFailureInfo {
  reasonCode: AuthorityFailureReasonCode;
  reason: string;
  capability?: string;
  resourceKey?: string;
  remediation: {
    kind: AuthorityRemediationKind;
    message: string;
    /** Exact manifest request suggested for reviewed installed/eval code. */
    request?: {
      capability: string;
      resource: { kind: "exact"; key: string };
      tier: "gated" | "critical";
    };
  };
}

export interface AuthorityPreflightLeaf {
  capability: string;
  resourceKey: string;
  status: "granted" | "consumable-once" | "acquirable" | "denied";
  tier: "open" | "gated" | "critical";
  failure?: AuthorityFailureInfo;
}

export interface AuthorityPreflightResult {
  decision: "allowed" | "acquirable" | "denied";
  leaves: AuthorityPreflightLeaf[];
  severityPreview?: "routine" | "sensitive" | "critical";
  wouldPrompt?: {
    cardType: "permission.gated" | "permission.outside" | "confirm.critical";
    renderedAction: string;
  };
}

/** Fresh host mediation for one direct method/event and target object. */
export interface DirectAuthorityAttestation {
  audience: string;
  method: string;
  /** Exact sealed receiver effect resolved by the host for this invocation. */
  effect:
    | { kind: "runtime-intrinsic" }
    | { kind: "semantic"; capability: string }
    | { kind: "workspace-service" };
  /** Host-resolved authority identity for this exact receiver invocation. */
  capability: string;
  /** Live target-declaration requirement, composed with the receiver method policy. */
  targetRequirement?: AuthorityRequirement;
  /** Semantic capability naming the live target; distinct from a protected method effect. */
  targetCapability?: string;
  /** Tier of the live target declaration, evaluated independently of the method tier. */
  targetTier?: "gated" | "critical";
  /** Canonical protected invocation bound to a critical one-shot confirmation. */
  invocationDigest?: string;
  resourceKey: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  context: AuthorizationContext;
  grants: readonly AuthorityGrant[];
  locks?: readonly AuthorityLock[];
  /** Host-resolved containment, enforced by the receiver before method entry. */
  readOnly?: true;
}

/**
 * Trusted workerd-router ingress time for direct authority evaluation.
 * The router always overwrites this transport fact after authenticating the
 * host dispatch, so userland cannot extend an attestation's validity.
 */
export const DIRECT_AUTHORITY_ACCEPTED_AT_HEADER = "X-Vibestudio-Authority-Accepted-At";
