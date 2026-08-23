/** Wire-safe authority facts shared by host-service and direct-RPC dispatch. */

import type { CallerKind } from "./types.js";

export type PrincipalKind = "host" | "user" | "code" | "session" | "mission";
export type Principal = `${PrincipalKind}:${string}`;
export type AgentGrantPrincipal = `agent:${string}`;
export type TaskGrantPrincipal = `task:${string}`;
export type AuthorityGrantSubject = Principal | AgentGrantPrincipal | TaskGrantPrincipal;
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

/**
 * A host-normalized evaluated-execution ceiling. It is an attenuation term,
 * never a grant or receiver allowlist. Relationship and transport facts are
 * deliberately absent because only the host may derive them.
 */
export interface EvalAuthorityManifest {
  mode: "adaptive" | "strict";
  effects: "read-only" | "read-write";
  approvals: "prompt" | "pregranted-only";
  requests: readonly CapabilityScope[];
  digest: string;
}

/**
 * Receiver-derived provenance for one owner-bound attached-host route.
 * This is immutable attenuation and relationship evidence, never caller input,
 * a principal, or a copied grant list.
 */
export interface AttachedHostExecutionFact {
  v: 1;
  sessionId: string;
  /** Exact signed routed invocation; propagated only by the child host. */
  requestId: string;
  parentHostId: string;
  childHostId: string;
  childGenerationId: string;
  developmentRunId: string;
  ownerRuntimeId: string;
  ownerRuntimeKind: CallerKind;
  ownerUserId: string | null;
  authorityCeiling: readonly CapabilityScope[];
  authorityCeilingDigest: string;
  expiresAt: number;
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

export interface SessionReviewedClosureFact {
  subject: AuthorityGrantSubject;
  closureDigest: string;
  harness: { unit: string; ev: string };
}

export type AgentExecutionMode = "interactive" | "mission" | "test";

/**
 * A capability-name matcher for unattended test decisions. Exact is the
 * default; prefix is reserved for a production capability namespace whose
 * concrete suffix is intentionally authored at runtime.
 */
export type AgentExecutionTestCapabilityScope =
  | { kind: "exact"; key: string }
  | { kind: "prefix"; prefix: string };

export interface AgentExecutionTestAuthorityRule {
  ruleId: string;
  capability: AgentExecutionTestCapabilityScope;
  resource: ResourceScope;
  tier: "gated" | "critical";
  decision: "once" | "deny";
}

export interface AgentExecutionTestAgentPolicy {
  /** The primary model that agents created inside this test context execute. */
  model: string;
  /** System tests are unattended, so downstream agents inherit full-auto. */
  approvalLevel: 2;
  /** Exact host-enforced route; arbitrary workspace fallback settings are never inherited. */
  fallback:
    | "disabled"
    | {
        model: string;
        thinkingLevel: "low";
        on: readonly ["usage_limit_terminal"];
        scope: "all-turns";
      };
}

export interface AgentExecutionTestCasePolicy {
  testId: string;
  agent: AgentExecutionTestAgentPolicy;
  authority: readonly AgentExecutionTestAuthorityRule[];
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
  agent: AgentExecutionTestAgentPolicy;
  authority: readonly AgentExecutionTestAuthorityRule[];
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
  /** Opaque host-minted identity shared by the verified runtime task closure. */
  taskAuthority?: TaskGrantPrincipal;
  harness: {
    /** `code:<repoPath>@<effectiveVersion>` — the reviewed source identity. */
    principal: `code:${string}`;
    repoPath: string;
    effectiveVersion: string;
    /**
     * The artifact the recipe produced for this run. Authenticated in its own
     * right and used for activation checks and audit; it is deliberately not
     * part of the principal, because authorization asks which unit this is and
     * not which build of it is loaded.
     */
    executionDigest: string;
  };
  eval: {
    runtimeId: string;
    runId: string;
    authorityManifest: EvalAuthorityManifest;
    /** Host-minted producer credential for the canonical live event sink. */
    eventSinkNonce?: string;
  };
  /** Present only when verified attached transport created this eval run. */
  attachedHost?: AttachedHostExecutionFact;
  causalParent: {
    logId: string;
    head: string;
    invocationId: string;
  } | null;
  reviewedClosure?: SessionReviewedClosureFact;
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
    reviewedClosure?: SessionReviewedClosureFact;
    mediatingHarness?: `code:${string}`;
    taskRef?: string;
    /** Host-attested task closure; never accepted from invocation payloads. */
    taskAuthority?: TaskGrantPrincipal;
  };
  contextIntegrity: ContextIntegrityFact | null;
}

export interface AuthorityGrantConstraints {
  sessionId?: string;
  invocationDigest?: string;
  /**
   * Receiver build pinned by `version` scope. Ordinary grants deliberately
   * omit this so definition-stable provider rebuilds do not lapse authority.
   */
  providerExecutionDigest?: string;
  reviewedClosureSubject?: AuthorityGrantSubject;
  envelopeId?: string;
  lineageAtConsent?: readonly string[];
  taskRef?: string;
  taskAuthority?: TaskGrantPrincipal;
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
  /** Denormalized inventory/invalidation index for userland capabilities. */
  capabilityDefinitionDigest?: string;
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
  v: 2;
  service: string;
  method: string;
  capability: string;
  /** `-` for host capabilities. */
  capabilityDefinitionDigest: string;
  /** Capability domain for host receivers; declared resource type for userland. */
  resourceType: string;
  /** Provider repo path for userland receivers; `-` for host receivers. */
  provider: string;
  /** Live provider build digest for userland receivers; `-` for host receivers. */
  providerExecutionDigest: string;
  /** Additional live target-declaration requirement, composed with the method declaration. */
  targetRequirement?: AuthorityRequirement;
  targetCapability?: string;
  resourceKey: string;
  argsDigest: string;
  preparedStateDigest: string;
  callerPrincipal: Principal;
  sessionId: string;
  taskRef?: string;
  /** Host-attested task closure captured for exact retry authorization. */
  taskAuthority?: TaskGrantPrincipal;
  agentBindingId?: string;
  agentName?: string;
  lineageClasses?: readonly string[];
  irreversible?: boolean;
  agentScopeEligible?: boolean;
  executionMode?: AgentExecutionMode;
  testPolicyId?: string;
  reviewedClosureSubject: AuthorityGrantSubject | "-";
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
  cardType:
    | "permission.gated"
    | "permission.outside"
    | "confirm.critical"
    | "template.add"
    | "template.update"
    | "template.remove"
    | "template.suggest";
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
  | "eval-read-only"
  | "run-manifest-denied"
  | "run-pregranted-only"
  | "attached-route-ceiling-denied"
  // A review covering this exact unit version is open and unresolved. The call
  // gets one recoverable error instead of an acquisition entry, so an
  // unanswered review can never turn into a prompt per method
  // (docs/template-install-unit-approval-ux-plan.md U6).
  | "review-pending";

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
  | "broaden-run-manifest"
  | "use-prompt-enabled-run"
  | "restart-attached-run"
  | "retry-through-host"
  | "resolve-open-review";

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
    /** The open review this call is waiting on, so the UI can focus it. */
    review?: { approvalId: string; title: string };
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
    cardType:
      | "permission.gated"
      | "permission.outside"
      | "confirm.critical"
      | "template.add"
      | "template.update"
      | "template.remove"
      | "template.suggest";
    renderedAction: string;
  };
}

/** Fresh host mediation for one direct method/event and target object. */
export interface DirectAuthorityAttestation {
  audience: string;
  method: string;
  /** Exact sealed receiver effect resolved by the host for this invocation. */
  effect:
    | { kind: "open" }
    | {
        kind: "userland-capability";
        capability: string;
        resource: { kind: "receiver-object" } | { kind: "opaque-handle"; argument: number };
      }
    | {
        kind: "host-capability";
        capability: string;
        resource: { kind: "receiver-object" };
      };
  /** Host-resolved authority identity for this exact receiver invocation. */
  capability: string;
  capabilityDefinitionDigest: string;
  resourceType: string;
  provider: string;
  providerExecutionDigest: string;
  /** Host-bound opaque-handle consumption. The provider receives selector, never the handle id. */
  resourceHandle?: string;
  resourceSelector?: string;
  /** Sealed declaration allowing this exact receiver method to mint one handle. */
  handleProduction?: {
    capability: string;
    capabilityDefinitionDigest: string;
    resourceType: string;
    provider: string;
  };
  /** Live target-declaration requirement, composed with the receiver method policy. */
  targetRequirement?: AuthorityRequirement;
  /** Semantic capability naming the live target; distinct from a protected method effect. */
  targetCapability?: string;
  /** Tier of the live target declaration, evaluated independently of the method tier. */
  targetTier?: "open" | "gated" | "critical";
  /** Canonical protected invocation bound to a critical one-shot confirmation. */
  invocationDigest?: string;
  /** Invocation digest for the independently authorized live target leaf. */
  targetInvocationDigest?: string;
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

export interface OpaqueHandlePresentation {
  title: string;
  detail?: string;
}

export interface OpaqueHandlePreparation {
  __vibestudioOpaqueHandle: 1;
  selector: string;
  presentation: OpaqueHandlePresentation;
}

/** Return from a declared handle-producing RPC method. */
export function prepareOpaqueHandle(
  selector: string,
  presentation: OpaqueHandlePresentation
): OpaqueHandlePreparation {
  if (!selector || selector.length > 512) {
    throw new Error("Opaque resource selector must contain 1-512 characters");
  }
  if (!presentation.title || presentation.title.length > 160) {
    throw new Error("Opaque resource title must contain 1-160 characters");
  }
  if (presentation.detail !== undefined && presentation.detail.length > 500) {
    throw new Error("Opaque resource detail must contain at most 500 characters");
  }
  return {
    __vibestudioOpaqueHandle: 1,
    selector,
    presentation: { ...presentation },
  };
}

/**
 * Trusted workerd-router ingress time for direct authority evaluation.
 * The router always overwrites this transport fact after authenticating the
 * host dispatch, so userland cannot extend an attestation's validity.
 */
export const DIRECT_AUTHORITY_ACCEPTED_AT_HEADER = "X-Vibestudio-Authority-Accepted-At";
