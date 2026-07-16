import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  AuthorizationContext,
  AuthorityGrant,
  CapabilityScope,
  Principal,
  ResourceScope,
  VerifiedDelegation,
} from "@vibestudio/rpc";
import type { EvalAuthorityIntent } from "@vibestudio/service-schemas/eval";
import type { EvalCapabilityAcquisition } from "@vibestudio/shared/typedServiceClient";
import type { AuthorityChallengePresentation } from "@vibestudio/shared/serviceDispatcher";
import { createVerifiedCaller, type VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { isCodeIdentityCallerKind } from "@vibestudio/shared/principalKinds";
import { capabilityPatternCovers } from "@vibestudio/shared/authorityManifest";
import type {
  CapabilityPermissionDeps,
  CapabilityPermissionResult,
} from "./capabilityPermission.js";
import {
  capabilityGrantSubject,
  constrainApprovalDecisions,
  requestCapabilityPermission,
} from "./capabilityPermission.js";
import { isApprovalExpiredError } from "./approvalQueue.js";
import {
  EVAL_CAPABILITY_ACQUISITION_LEDGER,
  EVAL_INVOCATION_EXPOSURE_CAPABILITIES,
} from "./evalInvocationExposure.generated.js";

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MAX_ACTIVATIONS = 256;
const DEFAULT_MAX_CHALLENGES = 64;
const MAX_RESOURCE_KEY_CHARS = 16 * 1024;
const MAX_CLEANUP_LEASE_MS = 30_000;

export type ResolvedEvalPolicy = {
  mode: "adaptive" | "strict";
  effects: "read-only" | "mutable";
  approvals: "prompt" | "pregranted-only";
  requests: readonly CapabilityScope[];
};

interface EvalInvocationRecord {
  runId: string;
  runDigest: string;
  objectKey: string;
  contextId: string;
  credentialHash: string;
  executor: Principal;
  invocation: Principal;
  initiator: VerifiedCaller;
  initiatorPrincipal: Principal;
  policy: ResolvedEvalPolicy;
  ceiling: readonly CapabilityScope[];
  active: Map<string, CapabilityScope>;
  runPermits: Map<string, AuthorityGrant>;
  /** Approval scope selected during this run, including up-front review. */
  approvalDecisions: Map<string, "once" | "run" | "session" | "version">;
  denied: Set<string>;
  reused: Set<string>;
  externalAuthorizations: Set<string>;
  challenges: number;
  constraintFailures: number;
  createdAt: number;
  leaseExpiresAt: number;
  maxEndsAt: number | null;
  cleanupEndsAt: number | null;
  terminal: boolean;
  phase: "preparation" | "run";
  manifestDigest: string | null;
}

export interface EvalInvocationLease {
  runId: string;
  runDigest: string;
  credential: string;
  invocationPrincipal: Principal;
  policy: ResolvedEvalPolicy;
  manifestDigest: string;
}

export interface EvalPreparationLease {
  runId: string;
  credential: string;
  policy: ResolvedEvalPolicy;
}

export interface EvalInvocationResolution {
  context: AuthorizationContext;
  grants: readonly AuthorityGrant[];
  /** Host-attested evaluated-code identity presented to domain handlers. */
  effectiveCaller?: VerifiedCaller;
  /** Root user/agent/code sponsor retained for prompts and attribution. */
  authorizingCaller: VerifiedCaller;
  /** Host-resolved eval owner context; never accepted from runtime code. */
  contextId: string;
  readOnly: boolean;
  decision?: "once" | "run" | "session" | "version";
}

export type RootAuthorityResolver = (input: {
  caller: VerifiedCaller;
  capability: string;
  resourceKey: string;
  audience: string;
  sessionId: string;
}) => {
  context: AuthorizationContext;
  grants: readonly AuthorityGrant[];
  /** A target-specific host policy may refuse to sponsor evaluated code even
   * when the initiator otherwise owns the requested capability. */
  evalSponsorshipAllowed?: boolean;
};

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function scopeKey(scope: CapabilityScope): string {
  return `${scope.capability}\0${JSON.stringify(scope.resource)}`;
}

function scopeCovers(scope: ResourceScope, resourceKey: string): boolean {
  switch (scope.kind) {
    case "exact":
      return scope.key === resourceKey;
    case "prefix":
      return (
        scope.prefix === "" ||
        scope.prefix === resourceKey ||
        resourceKey.startsWith(`${scope.prefix}/`)
      );
    case "origin":
      return scope.origin === resourceKey;
    case "domain": {
      try {
        const hostname = new URL(resourceKey).hostname;
        return hostname === scope.domain || hostname.endsWith(`.${scope.domain}`);
      } catch {
        return false;
      }
    }
    case "network":
      return true;
  }
}

function capabilityIsExposed(capability: string): boolean {
  return (EVAL_INVOCATION_EXPOSURE_CAPABILITIES as readonly string[]).some((pattern) =>
    capabilityPatternCovers(pattern, capability)
  );
}

function capabilityAcquisition(
  capability: string,
  surfaceId: string | undefined,
  declared: EvalCapabilityAcquisition | undefined
): EvalCapabilityAcquisition {
  if (declared) return declared;
  const rows = EVAL_CAPABILITY_ACQUISITION_LEDGER.filter(
    (row) =>
      capabilityPatternCovers(row.capability, capability) &&
      (surfaceId === undefined || row.id === surfaceId)
  );
  if (rows.length === 1) return rows[0]!.acquisition as EvalCapabilityAcquisition;
  if (rows.length > 1) {
    const kinds = new Set(rows.map((row) => row.acquisition.kind));
    if (kinds.size === 1) return rows[0]!.acquisition as EvalCapabilityAcquisition;
  }
  return { kind: "closed", reason: "capability leaf is absent from the reviewed eval catalog" };
}

function principalForCaller(caller: VerifiedCaller): Principal {
  if (caller.code) {
    return `code:${caller.code.repoPath}@${caller.code.executionDigest}`;
  }
  if (caller.hostOriginated) return `host:interactive-eval`;
  if (caller.subject && caller.subject.userId !== "system") {
    return `user:${caller.subject.userId}`;
  }
  if (caller.agentBinding) return `entity:${caller.agentBinding.entityId}`;
  throw evalAuthorityError(
    "EVAL_CAPABILITY_NOT_DELEGATED",
    "Eval initiator has no verified authority principal"
  );
}

function normalizedPolicy(intent: EvalAuthorityIntent | undefined): ResolvedEvalPolicy {
  const mode = intent?.mode ?? "adaptive";
  const requests = intent?.requests ?? [];
  return {
    mode,
    effects: intent?.effects ?? "mutable",
    approvals: intent?.approvals ?? "prompt",
    requests: mode === "strict" ? requests : [],
  };
}

function evalAuthorityError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error;
}

function effectiveEvalCaller(
  record: EvalInvocationRecord,
  transport: VerifiedCaller
): VerifiedCaller {
  if (!isCodeIdentityCallerKind(transport.runtime.kind) || !transport.code) {
    throw evalAuthorityError(
      "EVAL_INVOCATION_INVALID",
      "Eval invocation was not transported by a verified code runtime"
    );
  }
  const transportExecutor = `code:${transport.code.repoPath}@${transport.code.executionDigest}`;
  if (transportExecutor !== record.executor) {
    throw evalAuthorityError(
      "EVAL_INVOCATION_INVALID",
      "Eval invocation transport does not match the trusted executor"
    );
  }
  return createVerifiedCaller(
    transport.runtime.id,
    transport.runtime.kind,
    {
      callerId: transport.runtime.id,
      callerKind: transport.runtime.kind,
      repoPath: `eval/${record.runId}`,
      executionDigest: record.runDigest,
      requested:
        record.phase === "run" && record.policy.mode === "strict"
          ? record.policy.requests
          : [...record.active.values()],
      delegations: [],
    },
    record.initiator.agentBinding ?? null,
    record.initiator.subject ?? null
  );
}

/**
 * Process-local authority coordinator for live eval continuations. Durable run
 * rows intentionally contain only hashes/digests. Losing this coordinator
 * invalidates every lease; EvalDO reconciliation then marks the run interrupted
 * and never replays JavaScript.
 */
export class EvalInvocationCoordinator {
  private readonly byRun = new Map<string, EvalInvocationRecord>();
  private readonly permission: CapabilityPermissionDeps;
  private readonly now: () => number;
  private readonly onChallenge?: (input: {
    runId: string;
    objectKey: string;
    phase: "preparation" | "run";
    waiting: boolean;
    capability: string;
    resourceKey: string;
  }) => Promise<void>;

  constructor(
    input: CapabilityPermissionDeps & {
      now?: () => number;
      onChallenge?: (input: {
        runId: string;
        objectKey: string;
        phase: "preparation" | "run";
        waiting: boolean;
        capability: string;
        resourceKey: string;
      }) => Promise<void>;
    }
  ) {
    this.permission = input;
    this.now = input.now ?? Date.now;
    this.onChallenge = input.onChallenge;
  }

  issuePreparation(input: {
    runId: string;
    startIntentDigest: string;
    objectKey: string;
    contextId: string;
    executor: Principal;
    initiator: VerifiedCaller;
    authority?: EvalAuthorityIntent;
    maxEndsAt: number | null;
  }): EvalPreparationLease {
    const existing = this.byRun.get(input.runId);
    if (existing) {
      if (
        existing.runDigest !== input.startIntentDigest ||
        existing.objectKey !== input.objectKey
      ) {
        throw evalAuthorityError(
          "EVAL_IDEMPOTENCY_CONFLICT",
          `Run ${input.runId} is already bound to different normalized input`
        );
      }
      throw evalAuthorityError(
        "EVAL_INVOCATION_INVALID",
        `Run ${input.runId} already has a live invocation lease`
      );
    }
    const policy = normalizedPolicy(input.authority);
    const initiatorPrincipal = principalForCaller(input.initiator);
    const fullCeiling = input.initiator.code
      ? input.initiator.code.delegations
          .filter((delegation) => delegation.audience === "eval")
          .flatMap((delegation) => delegation.capabilities)
          .filter((scope) => capabilityIsExposed(scope.capability))
      : (EVAL_INVOCATION_EXPOSURE_CAPABILITIES as readonly string[])
          .filter(capabilityIsExposed)
          .map((capability) => ({
            capability,
            resource: { kind: "prefix", prefix: "" } as const,
          }));
    const ceiling = fullCeiling.filter(
      (scope) =>
        scope.capability.startsWith("service:fs.") ||
        scope.capability.startsWith("service:build.") ||
        scope.capability.startsWith("service:blobstore.")
    );
    const credential = randomBytes(32).toString("base64url");
    const invocationDigest = digest({
      runDigest: input.startIntentDigest,
      initiator: initiatorPrincipal,
      objectKey: input.objectKey,
      contextId: input.contextId,
      policy,
      ceiling,
    });
    const invocation = `code:eval-preparation/${input.runId}@${invocationDigest}` as Principal;
    const createdAt = this.now();
    const record: EvalInvocationRecord = {
      runId: input.runId,
      runDigest: input.startIntentDigest,
      objectKey: input.objectKey,
      contextId: input.contextId,
      credentialHash: tokenHash(credential),
      executor: input.executor,
      invocation,
      initiator: input.initiator,
      initiatorPrincipal,
      policy,
      ceiling,
      active: new Map(),
      runPermits: new Map(),
      approvalDecisions: new Map(),
      denied: new Set(),
      reused: new Set(),
      externalAuthorizations: new Set(),
      challenges: 0,
      constraintFailures: 0,
      createdAt,
      leaseExpiresAt: createdAt + DEFAULT_LEASE_MS,
      maxEndsAt: input.maxEndsAt,
      cleanupEndsAt: null,
      terminal: false,
      phase: "preparation",
      manifestDigest: null,
    };
    this.byRun.set(input.runId, record);
    return {
      runId: input.runId,
      credential,
      policy,
    };
  }

  finalize(input: {
    runId: string;
    startIntentDigest: string;
    sourceDigest: string;
    executionProvenanceDigest: string;
    scopeInputRevision: string;
  }): EvalInvocationLease {
    const record = this.byRun.get(input.runId);
    if (!record || record.terminal || record.phase !== "preparation") {
      throw evalAuthorityError("EVAL_INVOCATION_INVALID", "Eval preparation lease is unavailable");
    }
    if (record.runDigest !== input.startIntentDigest) {
      throw evalAuthorityError("EVAL_IDEMPOTENCY_CONFLICT", "Eval preparation intent changed");
    }
    const fullCeiling = record.initiator.code
      ? record.initiator.code.delegations
          .filter((delegation) => delegation.audience === "eval")
          .flatMap((delegation) => delegation.capabilities)
          .filter((scope) => capabilityIsExposed(scope.capability))
      : (EVAL_INVOCATION_EXPOSURE_CAPABILITIES as readonly string[])
          .filter(capabilityIsExposed)
          .map((capability) => ({
            capability,
            resource: { kind: "prefix", prefix: "" } as const,
          }));
    for (const request of record.policy.requests) {
      if (
        !this.covered(fullCeiling, request.capability, resourceRepresentative(request.resource))
      ) {
        throw evalAuthorityError(
          "EVAL_CAPABILITY_NOT_DELEGATED",
          `Strict request ${request.capability} is outside the verified eval delegation ceiling`
        );
      }
    }
    const runDigest = digest({
      version: 1,
      runId: record.runId,
      startIntentDigest: input.startIntentDigest,
      sourceDigest: input.sourceDigest,
      executionProvenanceDigest: input.executionProvenanceDigest,
      scopeInputRevision: input.scopeInputRevision,
      objectKey: record.objectKey,
      initiator: record.initiatorPrincipal,
      executor: record.executor,
      policy: record.policy,
      ceiling: fullCeiling,
    });
    const invocation = `code:eval/${record.runId}@${runDigest}` as Principal;
    const credential = randomBytes(32).toString("base64url");
    record.runDigest = runDigest;
    record.invocation = invocation;
    record.credentialHash = tokenHash(credential);
    record.ceiling = fullCeiling;
    // Preparation activations describe source/import materialization, not the
    // JavaScript invocation's effective manifest. Rotate the ledger with the
    // principal so strict runs begin with exactly their declared requests and
    // adaptive runs begin empty.
    record.active.clear();
    if (record.policy.mode === "strict") {
      for (const request of record.policy.requests) record.active.set(scopeKey(request), request);
    }
    record.phase = "run";
    record.leaseExpiresAt = this.now() + DEFAULT_LEASE_MS;
    const manifestDigest = digest({
      version: 1,
      policy: record.policy,
      ceiling: fullCeiling,
      invocation,
      executor: record.executor,
      contextId: record.contextId,
      sourceDigest: input.sourceDigest,
      executionProvenanceDigest: input.executionProvenanceDigest,
      scopeInputRevision: input.scopeInputRevision,
    });
    record.manifestDigest = manifestDigest;
    return {
      runId: record.runId,
      runDigest,
      credential,
      invocationPrincipal: invocation,
      policy: record.policy,
      manifestDigest,
    };
  }

  async resolve(input: {
    runId: string;
    credential: string;
    objectKey: string;
    capability: string;
    resourceKey: string;
    surfaceId?: string;
    acquisition?: EvalCapabilityAcquisition;
    challenge?: AuthorityChallengePresentation;
    sensitivity?: "read" | "write" | "admin" | "destructive";
    audience: string;
    root: RootAuthorityResolver;
    /** Verified deputy carrying this live dispatch. Absent only for preauthorization. */
    transportCaller?: VerifiedCaller;
    preauthorization?: boolean;
    signal?: AbortSignal;
  }): Promise<EvalInvocationResolution> {
    if (input.resourceKey.length > MAX_RESOURCE_KEY_CHARS) {
      throw evalAuthorityError("EVAL_RESOURCE_LIMIT", "Eval authority resource key is too large");
    }
    const record = this.requireLive(input);
    const acquisition = capabilityAcquisition(input.capability, input.surfaceId, input.acquisition);
    if (!capabilityIsExposed(input.capability) || acquisition.kind === "closed") {
      throw evalAuthorityError(
        "EVAL_CAPABILITY_CLOSED",
        acquisition.kind === "closed"
          ? acquisition.reason
          : `${input.capability} is not exposed to evaluated code`
      );
    }
    if (
      record.phase === "run" &&
      record.policy.effects === "read-only" &&
      input.sensitivity !== "read"
    ) {
      record.constraintFailures += 1;
      throw evalAuthorityError(
        "EVAL_READ_ONLY",
        `${input.capability} is ${input.sensitivity ?? "unclassified"} and cannot run read-only`
      );
    }
    if (!this.covered(record.ceiling, input.capability, input.resourceKey)) {
      throw evalAuthorityError(
        "EVAL_CAPABILITY_NOT_DELEGATED",
        `${input.capability} is outside this run's verified delegation ceiling`
      );
    }
    if (
      record.phase === "run" &&
      record.policy.mode === "strict" &&
      !this.covered(record.policy.requests, input.capability, input.resourceKey)
    ) {
      record.constraintFailures += 1;
      throw evalAuthorityError(
        "EVAL_AUTHORITY_CONSTRAINT",
        `${input.capability} is absent from the strict eval manifest`
      );
    }
    const activation: CapabilityScope = {
      capability: input.capability,
      resource: { kind: "exact", key: input.resourceKey },
    };
    const activationKey = scopeKey(activation);
    if (!record.active.has(activationKey)) {
      if (record.active.size >= DEFAULT_MAX_ACTIVATIONS) {
        throw evalAuthorityError("EVAL_RESOURCE_LIMIT", "Eval activation limit exceeded");
      }
      record.active.set(activationKey, activation);
    }
    if (record.denied.has(activationKey)) {
      throw evalAuthorityError(
        "EVAL_APPROVAL_DENIED",
        `${input.capability} was denied for this run`
      );
    }

    // Preauthorization has no handler dispatch of its own. Preserve its chosen
    // scope so the eventual matching call can report the decision that made it
    // possible instead of looking indistinguishable from ambient authority.
    let approvalDecision = record.approvalDecisions.get(activationKey);
    const authoritySessionId = record.initiator.runtime.id;
    let root = input.root({
      caller: record.initiator,
      capability: input.capability,
      resourceKey: input.resourceKey,
      audience: input.audience,
      sessionId: authoritySessionId,
    });
    if (root.evalSponsorshipAllowed === false) {
      throw evalAuthorityError(
        "EVAL_CAPABILITY_CLOSED",
        `${input.capability} is not sponsored for this direct target`
      );
    }
    const existingPermit = record.runPermits.get(activationKey);
    const sponsorGrants = (resolvedRoot: ReturnType<RootAuthorityResolver>): AuthorityGrant[] => {
      const grants = [...resolvedRoot.grants];
      if (record.initiator.code) return grants;
      const now = this.now();
      const grant = (effect: "allow" | "deny", provenance: string): AuthorityGrant => ({
        subject: record.initiatorPrincipal,
        capability: input.capability,
        resource: { kind: "exact", key: input.resourceKey },
        effect,
        issuedBy: "host:product",
        createdAt: now,
        binding: { kind: "principal" },
        provenance,
      });
      const subject = capabilityGrantSubject(record.initiator, authoritySessionId);
      if (
        subject &&
        this.permission.grantStore.hasGrant(input.capability, input.resourceKey, subject)
      ) {
        grants.push(grant("allow", "interactive-eval-capability-grant"));
      }
      if (
        subject &&
        this.permission.grantStore.hasDenial(input.capability, input.resourceKey, subject)
      ) {
        grants.push(grant("deny", "interactive-eval-capability-denial"));
      }
      // Authenticated workspace members using the reviewed interactive eval
      // sponsor receive the same baseline leaves as first-class agent eval.
      // This is a host policy grant for this exact dispatch, not ambient EvalDO
      // authority and not a reusable permission minted by code.
      if (acquisition.kind === "baseline" && resolvedRoot.context.workspace?.member) {
        grants.push(grant("allow", "interactive-eval-baseline-policy-v1"));
      }
      return grants;
    };
    let grants = sponsorGrants(root);
    if (existingPermit) grants.push(existingPermit);
    let hasAllow = grants.some(
      (grant) =>
        grant.effect === "allow" &&
        grant.subject === record.initiatorPrincipal &&
        capabilityPatternCovers(grant.capability, input.capability) &&
        scopeCovers(grant.resource, input.resourceKey)
    );
    const hasDeny = grants.some(
      (grant) =>
        grant.effect === "deny" &&
        grant.subject === record.initiatorPrincipal &&
        capabilityPatternCovers(grant.capability, input.capability) &&
        scopeCovers(grant.resource, input.resourceKey)
    );
    if (hasDeny) {
      record.denied.add(activationKey);
      throw evalAuthorityError("EVAL_APPROVAL_DENIED", `${input.capability} is blocked`);
    }
    if (!hasAllow && !existingPermit && record.externalAuthorizations.has(activationKey)) {
      throw evalAuthorityError(
        "EVAL_GRANT_REVOKED",
        `${input.capability} grant was revoked before the next dispatch`
      );
    }
    if (hasAllow && acquisition.kind === "approval") {
      record.reused.add(activationKey);
    } else if (!hasAllow) {
      if (acquisition.kind === "baseline") {
        throw evalAuthorityError(
          "EVAL_APPROVAL_REQUIRED",
          `${input.capability} is baseline-exposed but the verified initiator has no covering grant`
        );
      }
      if (record.policy.approvals === "pregranted-only") {
        throw evalAuthorityError(
          "EVAL_APPROVAL_REQUIRED",
          `${input.capability} requires an external grant for ${input.resourceKey}`
        );
      }
      if (record.cleanupEndsAt !== null) {
        throw evalAuthorityError(
          "EVAL_APPROVAL_REQUIRED",
          `${input.capability} is not preauthorized for terminal cleanup`
        );
      }
      if (record.challenges >= DEFAULT_MAX_CHALLENGES) {
        throw evalAuthorityError("EVAL_RESOURCE_LIMIT", "Eval challenge limit exceeded");
      }
      record.challenges += 1;
      if (!input.preauthorization) {
        await this.onChallenge?.({
          runId: record.runId,
          objectKey: record.objectKey,
          phase: record.phase,
          waiting: true,
          capability: input.capability,
          resourceKey: input.resourceKey,
        });
      }
      let permission: CapabilityPermissionResult;
      const challengeOperation = input.challenge?.operation;
      const operation = challengeOperation
        ? {
            ...challengeOperation,
            groupKey: `${record.runId}:${
              challengeOperation.groupKey ?? digest([input.capability, input.resourceKey])
            }`,
          }
        : {
            kind:
              acquisition.kind === "approval"
                ? (acquisition.operation
                    .kind as import("@vibestudio/shared/approvals").ApprovalOperationDescriptor["kind"])
                : "unknown",
            verb: acquisition.kind === "approval" ? acquisition.operation.verb : input.capability,
            object: {
              type: "authority-resource",
              label: "Resource",
              value: input.resourceKey,
            },
            groupKey: `${record.runId}:${digest([input.capability, input.resourceKey])}`,
          };
      const challengeDedupKey = input.challenge?.dedupKey;
      try {
        permission = await requestCapabilityPermission(this.permission, {
          caller: record.initiator,
          capability: input.capability,
          requesterCategory: "eval",
          dedupKey:
            typeof challengeDedupKey === "string" ? `${record.runId}:${challengeDedupKey}` : null,
          operation,
          signal: input.challenge?.signal ?? input.signal,
          authoritySessionId: record.initiator.runtime.id,
          resource: {
            type: input.challenge?.resource.type ?? "authority-resource",
            label: input.challenge?.resource.label ?? "Resource",
            value: input.challenge?.resource.value ?? input.resourceKey,
            key: input.resourceKey,
          },
          title:
            input.challenge?.title ??
            (acquisition.kind === "approval"
              ? acquisition.title
              : `Allow eval to use ${input.capability}`),
          description:
            input.challenge?.description ??
            (acquisition.kind === "approval"
              ? acquisition.description
              : `Run ${record.runId} is waiting to continue this exact operation.`),
          severity:
            input.challenge?.severity ??
            (acquisition.kind === "approval" ? acquisition.severity : undefined),
          details: input.challenge?.details
            ? [...input.challenge.details]
            : [{ label: "Capability", value: input.capability }],
          deniedReason:
            input.challenge?.deniedReason ?? `Eval access to ${input.capability} was denied`,
          allowedDecisions: constrainApprovalDecisions(
            [
              ...(input.preauthorization ? [] : (["once"] as const)),
              ...(acquisition.kind === "approval"
                ? acquisition.grantScopes
                : (["run", "session", "version"] as const)),
              "deny",
              "dismiss",
            ],
            input.challenge?.allowedDecisions
          ),
        });
      } catch (error) {
        if (isApprovalExpiredError(error)) {
          throw evalAuthorityError(
            "EVAL_CHALLENGE_EXPIRED",
            `Approval challenge for ${input.capability} expired`
          );
        }
        throw error;
      } finally {
        if (!input.preauthorization) {
          await this.onChallenge?.({
            runId: record.runId,
            objectKey: record.objectKey,
            phase: record.phase,
            waiting: false,
            capability: input.capability,
            resourceKey: input.resourceKey,
          });
        }
      }
      if (!permission.allowed) {
        if (permission.decision !== "dismiss") record.denied.add(activationKey);
        throw evalAuthorityError(
          permission.decision === "dismiss" ? "EVAL_APPROVAL_REQUIRED" : "EVAL_APPROVAL_DENIED",
          permission.reason ?? `${input.capability} was denied`
        );
      }
      if (input.preauthorization && permission.decision === "once") {
        throw evalAuthorityError(
          "EVAL_INVOCATION_INVALID",
          "Exact-dispatch approval cannot satisfy up-front preauthorization"
        );
      }
      approvalDecision = permission.decision;
      if (approvalDecision) record.approvalDecisions.set(activationKey, approvalDecision);
      root = input.root({
        caller: record.initiator,
        capability: input.capability,
        resourceKey: input.resourceKey,
        audience: input.audience,
        sessionId: authoritySessionId,
      });
      if (root.evalSponsorshipAllowed === false) {
        throw evalAuthorityError(
          "EVAL_CAPABILITY_CLOSED",
          `${input.capability} is no longer sponsored for this direct target`
        );
      }
      grants = sponsorGrants(root);
      if (permission.decision === "once") {
        grants.push(this.permit(record, activation, "eval-once-permit"));
      } else if (permission.decision === "run") {
        const permit = this.permit(record, activation, "eval-run-permit");
        record.runPermits.set(activationKey, permit);
        grants.push(permit);
      }
      hasAllow = grants.some(
        (grant) =>
          grant.effect === "allow" &&
          grant.subject === record.initiatorPrincipal &&
          capabilityPatternCovers(grant.capability, input.capability) &&
          scopeCovers(grant.resource, input.resourceKey)
      );
      if (!hasAllow) {
        throw evalAuthorityError(
          "EVAL_INVOCATION_INVALID",
          "Approval decision did not produce authority for the suspended dispatch"
        );
      }
    }

    const runPermit = record.runPermits.get(activationKey);
    const hasExternalAllow = grants.some(
      (grant) =>
        grant.effect === "allow" &&
        grant.subject === record.initiatorPrincipal &&
        grant !== runPermit &&
        !grant.provenance.startsWith("eval-once-permit") &&
        !grant.provenance.startsWith("eval-run-permit") &&
        capabilityPatternCovers(grant.capability, input.capability) &&
        scopeCovers(grant.resource, input.resourceKey)
    );
    if (hasExternalAllow) record.externalAuthorizations.add(activationKey);

    const now = this.now();
    record.leaseExpiresAt = Math.min(
      record.cleanupEndsAt ?? record.maxEndsAt ?? Number.POSITIVE_INFINITY,
      now + DEFAULT_LEASE_MS
    );
    const delegation: VerifiedDelegation = {
      id: randomUUID(),
      issuer: record.initiatorPrincipal,
      subject: record.invocation,
      audience: `eval:${record.runId}`,
      purpose: "agentic-code-execution",
      capabilities: [activation],
      notBefore: record.createdAt,
      expiresAt: record.leaseExpiresAt,
    };
    const context: AuthorizationContext = {
      ...root.context,
      authorizingOrigin: { kind: "code", principal: record.invocation },
      codeAuthority: {
        executor: { principal: record.executor, requested: record.ceiling },
        execution: {
          phase: record.phase,
          principal: record.invocation,
          runId: record.runId,
          runDigest: record.runDigest,
          requested:
            record.phase === "run" && record.policy.mode === "strict"
              ? record.policy.requests
              : [...record.active.values()],
        },
        initiator: {
          kind: record.initiator.code
            ? "code"
            : record.initiator.hostOriginated
              ? "host"
              : "interactive-user",
          principal: record.initiatorPrincipal,
        },
        delegations: [delegation],
      },
    };
    const effectiveCaller = input.preauthorization
      ? undefined
      : input.transportCaller
        ? effectiveEvalCaller(record, input.transportCaller)
        : (() => {
            throw evalAuthorityError(
              "EVAL_INVOCATION_INVALID",
              "Live eval dispatch has no verified transport caller"
            );
          })();
    return {
      context,
      grants,
      ...(effectiveCaller ? { effectiveCaller } : {}),
      authorizingCaller: record.initiator,
      contextId: record.contextId,
      readOnly: record.phase === "run" && record.policy.effects === "read-only",
      ...(approvalDecision ? { decision: approvalDecision } : {}),
    };
  }

  /** Terminate a lease only when both opaque run id and deterministic owner
   * scope agree. A run id learned from another owner is never a cancellation
   * capability by itself. */
  invalidate(runId: string, objectKey: string): void {
    const record = this.byRun.get(runId);
    if (!record || record.objectKey !== objectKey) return;
    record.terminal = true;
    record.credentialHash = "";
    record.runPermits.clear();
    record.approvalDecisions.clear();
  }

  /**
   * Rotate an execution lease into its final bounded cleanup phase. The
   * credential and delegation ceiling do not change, approval prompts are no
   * longer allowed, and the phase cannot be exited. Identity is checked even
   * when the execution deadline has just elapsed because that deadline is one
   * of the reasons structured cleanup begins.
   */
  beginCleanup(input: { runId: string; credential: string; objectKey: string }): {
    expiresAt: number;
  } {
    const record = this.byRun.get(input.runId);
    if (
      !record ||
      record.terminal ||
      record.phase !== "run" ||
      record.objectKey !== input.objectKey ||
      record.credentialHash !== tokenHash(input.credential)
    ) {
      throw evalAuthorityError("EVAL_INVOCATION_INVALID", "Eval invocation lease is invalid");
    }
    const now = this.now();
    record.cleanupEndsAt ??= now + MAX_CLEANUP_LEASE_MS;
    record.leaseExpiresAt = record.cleanupEndsAt;
    return { expiresAt: record.cleanupEndsAt };
  }

  /** Invalidate every live lease for one deterministic EvalDO scope before a
   * reset/force-reset can cross its safe boundary. */
  invalidateObject(objectKey: string): void {
    for (const record of this.byRun.values()) {
      if (record.objectKey === objectKey) this.invalidate(record.runId, objectKey);
    }
  }

  /** Extend the short live credential lease without changing authority. Every
   * actual dispatch still re-evaluates grants, delegation, and relationships. */
  renew(input: { runId: string; credential: string; objectKey: string }): { expiresAt: number } {
    const record = this.requireLive(input);
    const now = this.now();
    record.leaseExpiresAt = Math.min(
      record.cleanupEndsAt ?? record.maxEndsAt ?? Number.POSITIVE_INFINITY,
      now + DEFAULT_LEASE_MS
    );
    return { expiresAt: record.leaseExpiresAt };
  }

  authoritySummary(runId: string): {
    activated: CapabilityScope[];
    approvalsRequested: number;
    approvalsReused: number;
    approvalsDenied: number;
    constraintFailures: number;
    manifestDigest: string;
  } | null {
    const record = this.byRun.get(runId);
    if (!record) return null;
    if (!record.manifestDigest) return null;
    return {
      activated: [...record.active.values()],
      approvalsRequested: record.challenges,
      approvalsReused: record.reused.size,
      approvalsDenied: record.denied.size,
      constraintFailures: record.constraintFailures,
      manifestDigest: record.manifestDigest,
    };
  }

  private requireLive(input: {
    runId: string;
    credential: string;
    objectKey: string;
  }): EvalInvocationRecord {
    const record = this.byRun.get(input.runId);
    const now = this.now();
    if (
      !record ||
      record.terminal ||
      record.objectKey !== input.objectKey ||
      record.credentialHash !== tokenHash(input.credential)
    ) {
      throw evalAuthorityError("EVAL_INVOCATION_INVALID", "Eval invocation lease is invalid");
    }
    if (
      record.leaseExpiresAt <= now ||
      (record.cleanupEndsAt === null && record.maxEndsAt !== null && record.maxEndsAt <= now)
    ) {
      this.invalidate(record.runId, record.objectKey);
      throw evalAuthorityError("EVAL_INVOCATION_EXPIRED", "Eval invocation lease expired");
    }
    return record;
  }

  private covered(
    scopes: readonly CapabilityScope[],
    capability: string,
    resourceKey: string
  ): boolean {
    return scopes.some(
      (scope) =>
        capabilityPatternCovers(scope.capability, capability) &&
        scopeCovers(scope.resource, resourceKey)
    );
  }

  private permit(
    record: EvalInvocationRecord,
    scope: CapabilityScope,
    provenance: string
  ): AuthorityGrant {
    return {
      subject: record.initiatorPrincipal,
      capability: scope.capability,
      resource: scope.resource,
      effect: "allow",
      issuedBy: "host:eval-authority-broker",
      createdAt: this.now(),
      ...(record.maxEndsAt === null ? {} : { expiresAt: record.maxEndsAt }),
      binding: { kind: "principal" },
      provenance,
    };
  }
}

function resourceRepresentative(scope: ResourceScope): string {
  switch (scope.kind) {
    case "exact":
      return scope.key;
    case "prefix":
      return scope.prefix;
    case "origin":
      return scope.origin;
    case "domain":
      return `https://${scope.domain}`;
    case "network":
      return "https://eval.invalid";
  }
}
