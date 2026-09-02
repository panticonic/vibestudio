import type { AcquisitionInfo, InvocationSnapshot, ResourceScope } from "@vibestudio/rpc";
import { canonicalKey } from "@vibestudio/shared/canonicalKey";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { AuthorityChallengePresentation } from "@vibestudio/shared/serviceDispatcher";
import type { ApprovalTargetIdentity, OperationSubstance } from "@vibestudio/shared/approvals";
import type { AuthorityAcquisitionDecision } from "@vibestudio/shared/approvalContract";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import {
  authorityPromptCardType,
  type AuthorityPromptCardType,
} from "@vibestudio/shared/authority/promptRegistry";
import type {
  ApprovalQueue,
  ApprovalQueueDecision,
  ApprovalQueueResolution,
  AuthorityApprovalQueueDecision,
  CapabilityApprovalQueueRequest,
} from "./approvalQueue.js";
import {
  approvalScopeForAuthorityResource,
  type CapabilityGrantStore,
} from "./capabilityGrantStore.js";
import { createHash } from "node:crypto";
import { authorityRow } from "@vibestudio/shared/authority/authorityRows";
import { testPolicyAuthorityDecision } from "./authorityRuntime.js";
import type {
  DurableTargetAuthorityRequest,
  TargetAuthorityRequestStore,
} from "./targetAuthorityRequestStore.js";

export interface AcquisitionRequestInput {
  snapshot: InvocationSnapshot;
  snapshotDigest: string;
  tier: "gated" | "critical";
  caller: VerifiedCaller;
  renderedAction: string;
  resource: ResourceScope;
  presentation?: AuthorityChallengePresentation;
  target?: ApprovalTargetIdentity;
  substance?: OperationSubstance;
}

export interface AcquisitionOutcome {
  state: "decided" | "closed";
  decision?: AuthorityAcquisitionDecision;
  grantId?: string;
  info?: AcquisitionInfo;
}

interface PendingAcquisition {
  requestKey: string;
  info: AcquisitionInfo;
  sessionId: string;
  agentBindingId: string | null;
  /** The scope the request was made against, kept for the waiting-list projection. */
  resource: ResourceScope;
  /** When the request began waiting, so a reviewer can see what has been stuck. */
  requestedAt: number;
  outcome: Promise<AcquisitionOutcome>;
  settle: (outcome: AcquisitionOutcome) => void;
  continuation: "in-band" | "owner-redrive";
}

/**
 * A read-only view of one waiting acquisition, for the permissions surface.
 *
 * Deliberately narrower than `PendingAcquisition`: no promise, no settle
 * handle, no request key. Reading what is waiting must never be a way to
 * resolve it — that stays with the approval presentation that owns the
 * rendezvous.
 */
export interface PendingAcquisitionView {
  acquisitionId: string;
  ownerRuntimeId: string;
  capability: string;
  resource: ResourceScope;
  resourceKey: string;
  tier: "gated" | "critical";
  renderedAction: string;
  requestedAt: number;
  agentBindingId: string | null;
}

interface CompletedAcquisition {
  ownerRuntimeId: string;
  sessionId: string;
  info: AcquisitionInfo;
  outcome: AcquisitionOutcome;
  expiresAt: number;
}

interface TargetRequestJoin {
  info: AcquisitionInfo;
  sessionId: string;
  outcome: Promise<AcquisitionOutcome>;
  settle: (outcome: AcquisitionOutcome) => void;
  continuation: PendingAcquisition["continuation"];
}

/** One in-memory rendezvous per exact invocation ask; durable outcomes live in grants.db. */
export class AcquisitionCoordinator {
  private static readonly DISMISS_COOLDOWN_MS = 10 * 60 * 1_000;
  private static readonly FATIGUE_MEMORY_MS = 24 * 60 * 60 * 1_000;
  private static readonly INTERRUPT_WINDOW_MS = 60 * 1_000;
  private static readonly MAX_INTERRUPTS_PER_CONTEXT_WINDOW = 1;
  private static readonly COMPLETION_RETENTION_MS = 10 * 60 * 1_000;
  private static readonly MAX_COMPLETIONS = 512;
  private static readonly MAX_COOLDOWNS = 512;
  private readonly byRequestKey = new Map<string, PendingAcquisition>();
  private readonly byId = new Map<string, PendingAcquisition>();
  /**
   * A bounded race buffer for authority.awaitDecision calls that arrive just
   * after presentation settled. Durable grants remain the source of truth.
   */
  private readonly completedById = new Map<string, CompletedAcquisition>();
  private readonly cooldowns = new Map<
    string,
    { until: number; dismissals: number; lastDismissedAt: number }
  >();
  private readonly interruptions = new Map<string, number[]>();
  private readonly presentingTargetRequests = new Set<string>();
  private readonly targetJoins = new Map<string, Map<string, TargetRequestJoin>>();

  constructor(
    private readonly deps: {
      approvalQueue: ApprovalQueue;
      grantStore: CapabilityGrantStore;
      targetRequests?: TargetAuthorityRequestStore;
      notifyOwner?: (ownerRuntimeId: string, acquisitionId: string) => Promise<void> | void;
    }
  ) {}

  requestForTarget(input: {
    targetSubject: import("@vibestudio/rpc").AuthorityGrantSubject;
    authorityPlanDigest: string;
    operationKey: string;
    capability: string;
    capabilityDefinitionDigest: string;
    resource: ResourceScope;
    tier: "gated" | "critical";
    sourceUser: `user:${string}`;
    renderedAction: string;
    review: DurableTargetAuthorityRequest["review"];
  }): DurableTargetAuthorityRequest {
    const store = this.requireTargetRequests();
    const durable = store.ensure(input);
    if (durable.state === "pending") this.presentTargetRequest(durable, input.renderedAction);
    return durable;
  }

  resumeTargetRequests(): void {
    if (!this.deps.targetRequests) return;
    for (const request of this.deps.targetRequests.pending()) {
      this.presentTargetRequest(request, request.review.action);
    }
  }

  targetRequestsFor(
    subject: import("@vibestudio/rpc").AuthorityGrantSubject,
    authorityPlanDigest: string
  ): DurableTargetAuthorityRequest[] {
    return this.requireTargetRequests().forPlan(subject, authorityPlanDigest);
  }

  registerTargetSubject(
    subject: import("@vibestudio/rpc").AuthorityGrantSubject,
    authorityPlanDigest: string,
    ownerUser: `user:${string}`,
    controllerRuntimeId: string
  ): void {
    this.requireTargetRequests().registerSubject(
      subject,
      authorityPlanDigest,
      ownerUser,
      controllerRuntimeId
    );
  }

  targetSubject(subject: import("@vibestudio/rpc").AuthorityGrantSubject) {
    return this.requireTargetRequests().subject(subject);
  }

  retireTargetSubject(subject: import("@vibestudio/rpc").AuthorityGrantSubject) {
    const store = this.requireTargetRequests();
    const pending = store.pending().filter((request) => request.targetSubject === subject);
    const retired = store.retireSubject(subject);
    for (const request of pending) {
      this.deps.approvalQueue.cancelForCaller(targetRequestCallerId(request.requestId));
      this.settleTargetJoiners(request.requestId, { state: "closed" });
    }
    return retired;
  }

  private requireTargetRequests(): TargetAuthorityRequestStore {
    if (!this.deps.targetRequests)
      throw new Error("Durable target authority acquisition is unavailable in this host role");
    return this.deps.targetRequests;
  }

  private presentTargetRequest(
    request: DurableTargetAuthorityRequest,
    renderedAction: string
  ): void {
    if (this.presentingTargetRequests.has(request.requestId)) return;
    const missionSubject = request.targetSubject.startsWith("mission:")
      ? (request.targetSubject as `mission:${string}@${string}`)
      : null;
    const taskAuthority = request.targetSubject.startsWith("task:")
      ? (request.targetSubject as import("@vibestudio/rpc").TaskGrantPrincipal)
      : null;
    if (!missionSubject && !taskAuthority) {
      throw new Error(
        `Durable authority target ${request.targetSubject} is neither a mission nor a task`
      );
    }
    if (request.tier === "critical") {
      throw new Error(
        "Critical authority is invocation-specific and cannot target a standing subject"
      );
    }
    const expectedDecision = missionSubject ? "mission" : "task";
    const callerId = targetRequestCallerId(request.requestId);
    this.presentingTargetRequests.add(request.requestId);
    const presentation: CapabilityApprovalQueueRequest = {
      kind: "capability",
      callerId,
      callerKind: "system",
      repoPath: "vibestudio/authority",
      effectiveVersion: request.authorityPlanDigest,
      attention: "interrupt",
      requestedByUserId: request.sourceUser.slice("user:".length),
      requesterCategory: "agent",
      dedupKey: request.requestId,
      capability: request.capability,
      title: missionSubject ? "Allow an automation action" : "Allow an agent task action",
      description: missionSubject
        ? "Grant this exact operation to the installed automation revision."
        : "Grant this exact operation to the current agent task.",
      resource: {
        type: request.resource.kind,
        label: "Resource",
        value:
          request.resource.kind === "exact"
            ? request.resource.key
            : canonicalJson(request.resource),
      },
      resourceScope: approvalScopeForAuthorityResource(request.resource),
      grantResourceKey:
        request.resource.kind === "exact" ? request.resource.key : canonicalJson(request.resource),
      operation: {
        kind: "unknown",
        verb: "allow",
        object: { type: "automation-operation", label: "Operation", value: renderedAction },
      },
      cardType: authorityPromptCardType({
        tier: request.tier,
        capability: request.capability,
        outsideContent: false,
      }),
      allowedDecisions: [expectedDecision, "deny"],
      authorityRow: authorityRow({
        capability: request.capability,
        resource: request.resource,
        tier: request.tier,
        statement: "prospective",
        provenance: { source: "receiver", surface: `declared by ${request.review.declaredBy}` },
        flags: {},
        category: { domain: request.review.domain, verb: request.review.verb },
        reviewedAction: request.review.action,
      }),
    };
    const resolution: Promise<ApprovalQueueResolution<AuthorityApprovalQueueDecision>> = this.deps
      .approvalQueue.requestWithHandle
      ? this.deps.approvalQueue.requestWithHandle(presentation).resolution
      : this.deps.approvalQueue.request(presentation).then((decision) => ({ decision }));
    void resolution
      .then(({ decision, resolver }) => {
        const live = this.requireTargetRequests().get(request.requestId);
        if (!live || live.state !== "pending") {
          this.settleTargetJoiners(request.requestId, { state: "closed" });
          return;
        }
        if (decision === expectedDecision) {
          const grantId = this.persistTargetDecision(
            live,
            "allow",
            resolver ? `user:${resolver.subject.userId}` : live.sourceUser
          );
          this.requireTargetRequests().settle(request.requestId, "granted", grantId);
          this.settleTargetJoiners(request.requestId, {
            state: "decided",
            decision: expectedDecision,
            grantId,
          });
        } else if (decision === "deny") {
          this.persistTargetDecision(
            live,
            "deny",
            resolver ? `user:${resolver.subject.userId}` : live.sourceUser
          );
          this.requireTargetRequests().settle(request.requestId, "denied");
          this.settleTargetJoiners(request.requestId, { state: "decided", decision: "deny" });
        } else {
          this.requireTargetRequests().settle(request.requestId, "cancelled");
          this.settleTargetJoiners(request.requestId, { state: "closed" });
        }
      })
      .catch((error) => {
        console.error("[AuthorityAcquisition] target request presentation failed:", error);
      })
      .finally(() => {
        this.presentingTargetRequests.delete(request.requestId);
      });
  }

  private persistTargetDecision(
    request: DurableTargetAuthorityRequest,
    effect: "allow" | "deny",
    issuedBy: `user:${string}`
  ): string | undefined {
    const missionSubject = request.targetSubject.startsWith("mission:")
      ? (request.targetSubject as `mission:${string}@${string}`)
      : null;
    const scope = missionSubject ? ("mission" as const) : ("task" as const);
    const grant = this.deps.grantStore.issue({
      effect,
      capability: request.capability,
      resource: request.resource,
      subject: request.targetSubject,
      constraints: {
        ...(missionSubject ? { missionSubject } : {}),
        lineageAtConsent: [],
      },
      issuedBy,
      provenance: "acquisition",
      capabilityDefinitionDigest: request.capabilityDefinitionDigest,
      scope,
    });
    return effect === "allow" ? grant.id : undefined;
  }

  private matchingTargetRequest(
    input: AcquisitionRequestInput
  ): DurableTargetAuthorityRequest | null {
    if (input.tier !== "gated" || !this.deps.targetRequests) return null;
    const targetSubject =
      input.snapshot.missionSubject !== "-"
        ? input.snapshot.missionSubject
        : (input.snapshot.taskAuthority ?? null);
    if (!targetSubject) return null;
    return this.deps.targetRequests.pendingForInvocation({
      targetSubject,
      capability: input.snapshot.capability,
      capabilityDefinitionDigest: input.snapshot.capabilityDefinitionDigest,
      resource: input.resource,
    });
  }

  private joinTargetRequest(
    request: DurableTargetAuthorityRequest,
    input: AcquisitionRequestInput,
    continuation: PendingAcquisition["continuation"]
  ): AcquisitionInfo {
    let joins = this.targetJoins.get(request.requestId);
    if (!joins) {
      joins = new Map();
      this.targetJoins.set(request.requestId, joins);
    }
    const ownerRuntimeId = input.caller.runtime.id;
    const existing = joins.get(ownerRuntimeId);
    if (existing) {
      if (continuation === "in-band") existing.continuation = "in-band";
      return { ...existing.info, pending: true };
    }
    let settle!: (outcome: AcquisitionOutcome) => void;
    const outcome = new Promise<AcquisitionOutcome>((resolve) => {
      settle = resolve;
    });
    const info: AcquisitionInfo = {
      acquisitionId: request.requestId,
      ownerRuntimeId,
      snapshotDigest: input.snapshotDigest,
      capability: input.snapshot.capability,
      resourceKey: input.snapshot.resourceKey,
      tier: input.tier,
      cardType: cardTypeFor(input),
      renderedAction: input.renderedAction,
      pending: true,
    };
    const join: TargetRequestJoin = {
      info,
      sessionId: input.snapshot.sessionId,
      outcome,
      settle,
      continuation,
    };
    joins.set(ownerRuntimeId, join);
    const live = this.requireTargetRequests().get(request.requestId);
    if (!live || live.state !== "pending") {
      this.settleOneTargetJoin(request.requestId, ownerRuntimeId, join, targetOutcome(live));
    }
    return { ...info };
  }

  private settleTargetJoiners(requestId: string, outcome: AcquisitionOutcome): void {
    const joins = this.targetJoins.get(requestId);
    if (!joins) return;
    for (const [ownerRuntimeId, join] of joins) {
      this.settleOneTargetJoin(requestId, ownerRuntimeId, join, outcome);
    }
  }

  private settleOneTargetJoin(
    requestId: string,
    ownerRuntimeId: string,
    join: TargetRequestJoin,
    outcome: AcquisitionOutcome
  ): void {
    const joins = this.targetJoins.get(requestId);
    if (joins?.get(ownerRuntimeId) !== join) return;
    joins.delete(ownerRuntimeId);
    if (joins.size === 0) this.targetJoins.delete(requestId);
    join.info.pending = false;
    const settled = { ...outcome, info: { ...join.info } };
    join.settle(settled);
    if (join.continuation !== "owner-redrive") return;
    void Promise.resolve(this.deps.notifyOwner?.(ownerRuntimeId, requestId)).catch((error) => {
      console.warn(
        `[AuthorityAcquisition] target-request wake hint failed for ${ownerRuntimeId}:`,
        error instanceof Error ? error.message : String(error)
      );
    });
  }

  request(input: AcquisitionRequestInput, signal?: AbortSignal): AcquisitionInfo {
    return this.requestWithContinuation(input, "owner-redrive", signal);
  }

  private requestWithContinuation(
    input: AcquisitionRequestInput,
    continuation: PendingAcquisition["continuation"],
    signal?: AbortSignal
  ): AcquisitionInfo {
    // Validate the subject/operation decision intersection before publishing a
    // pending card. An unconsumable approval is a protocol error, not a prompt.
    intersectAllowedDecisions(decisionsForOrigin(input), input.presentation?.allowedDecisions);
    const now = Date.now();
    this.pruneTerminalCaches(now);
    const targetRequest = this.matchingTargetRequest(input);
    if (targetRequest) return this.joinTargetRequest(targetRequest, input, continuation);
    const requestKey = acquisitionRequestKey(input);
    const existing = this.byRequestKey.get(requestKey);
    if (existing) {
      // The continuation gate must reflect the LIVE waiters, not whichever call
      // happened to create the entry. An in-band requestAndWait joining a
      // request()-created ask settles the outcome inside its held call, so a
      // concurrent owner wake hint would drive the same effect a second time.
      if (continuation === "in-band") existing.continuation = "in-band";
      return { ...existing.info, pending: true };
    }
    const acquisitionId = acquisitionIdFor(requestKey);
    const completed = this.completedById.get(acquisitionId);
    if (completed?.ownerRuntimeId === input.caller.runtime.id) {
      return { ...completed.info };
    }

    const testPolicy = input.caller.testPolicy ?? input.caller.executionSession?.testPolicy ?? null;
    if (input.snapshot.executionMode === "test") {
      if (!testPolicy) {
        throw testPolicyIntegrityError(
          "ETESTPOLICYMISSING",
          "Test-mode authority acquisition has no host-resident test policy",
          input
        );
      }
      if (input.snapshot.testPolicyId !== testPolicy.policyId) {
        throw testPolicyIntegrityError(
          "ETESTPOLICYMISMATCH",
          `Test-mode authority snapshot policy ${input.snapshot.testPolicyId ?? "<missing>"} ` +
            `does not match resident policy ${testPolicy.policyId}`,
          input
        );
      }
      const rule = testPolicyAuthorityDecision(input.caller, undefined, {
        capability: input.snapshot.capability,
        resourceKey: input.snapshot.resourceKey,
        tier: input.tier,
        irreversible: input.snapshot.irreversible,
      });
      if (!rule && testPolicy.kind === "case" && testPolicy.case.unexpectedPrompts === "fail") {
        throw Object.assign(
          new Error(
            `Unexpected authority prompt in system test ${testPolicy.case.testId}: ` +
              `${input.snapshot.capability} on ${input.snapshot.resourceKey} (${input.tier})`
          ),
          {
            code: "EUNEXPECTEDTESTPROMPT",
            testId: testPolicy.case.testId,
            capability: input.snapshot.capability,
            resourceKey: input.snapshot.resourceKey,
            tier: input.tier,
          }
        );
      }
      if (!rule) {
        // Orchestrator policies intentionally cannot ratify critical or
        // irreversible work; those requests continue through the real queue.
      } else {
        this.deps.grantStore.issue({
          effect: rule.decision === "deny" ? "deny" : "allow",
          capability: input.snapshot.capability,
          resource: input.resource,
          // Test policy may be inherited by reviewed infrastructure code without
          // changing its authorizing origin into a session. Mint the invocation
          // grant to the exact principal the immutable snapshot evaluated; keep
          // the execution/session identity as a constraint, never as a substitute
          // principal.
          subject: input.snapshot.callerPrincipal,
          constraints: {
            sessionId: input.snapshot.sessionId,
            ...(input.snapshot.agentBindingId
              ? { agentBindingId: input.snapshot.agentBindingId }
              : {}),
            invocationDigest: input.snapshotDigest,
            lineageAtConsent: [...(input.snapshot.lineageClasses ?? ["none"])],
          },
          issuedBy: `host:${input.snapshot.testPolicyId}:${rule.ruleId}`,
          provenance:
            input.tier === "critical" && rule.decision === "once"
              ? "critical-confirmation"
              : "preauthorization",
          scope: "once",
        });
        const info: AcquisitionInfo = {
          acquisitionId,
          ownerRuntimeId: input.caller.runtime.id,
          snapshotDigest: input.snapshotDigest,
          capability: input.snapshot.capability,
          resourceKey: input.snapshot.resourceKey,
          tier: input.tier,
          cardType: cardTypeFor(input),
          renderedAction: input.renderedAction,
          pending: false,
          preauthorized: true,
        };
        return { ...info };
      }
    }

    const ruleKey = acquisitionRuleKey(input);
    const cooldown = this.cooldowns.get(ruleKey);
    if (cooldown && cooldown.until > now) {
      return {
        acquisitionId,
        ownerRuntimeId: input.caller.runtime.id,
        snapshotDigest: input.snapshotDigest,
        capability: input.snapshot.capability,
        resourceKey: input.snapshot.resourceKey,
        tier: input.tier,
        cardType: cardTypeFor(input),
        renderedAction: input.renderedAction,
        pending: true,
        cooldownUntil: cooldown.until,
      };
    }
    const attention = this.attentionFor(input, ruleKey, now);

    const cardType = cardTypeFor(input);
    let settle!: (outcome: AcquisitionOutcome) => void;
    const outcome = new Promise<AcquisitionOutcome>((resolve) => {
      settle = resolve;
    });
    const info: AcquisitionInfo = {
      acquisitionId,
      ownerRuntimeId: input.caller.runtime.id,
      snapshotDigest: input.snapshotDigest,
      capability: input.snapshot.capability,
      resourceKey: input.snapshot.resourceKey,
      tier: input.tier,
      cardType,
      renderedAction: input.renderedAction,
      pending: false,
    };
    const entry: PendingAcquisition = {
      requestKey,
      info,
      sessionId: input.snapshot.sessionId,
      agentBindingId: input.snapshot.agentBindingId ?? null,
      resource: input.resource,
      requestedAt: now,
      outcome,
      settle,
      continuation,
    };
    this.byRequestKey.set(requestKey, entry);
    this.byId.set(acquisitionId, entry);
    info.pending = true;
    void this.present(entry, input, attention, signal).catch((error) => {
      this.finish(entry, { state: "closed" });
      console.error("[AuthorityAcquisition] approval presentation failed:", error);
    });
    return { ...info };
  }

  async requestAndWait(
    input: AcquisitionRequestInput,
    signal?: AbortSignal
  ): Promise<AcquisitionOutcome> {
    const info = this.requestWithContinuation(input, "in-band", signal);
    if (info.cooldownUntil) return { state: "closed", info };
    // Host preauthorization is completed synchronously by request(). It mints
    // a fresh single-use grant for this invocation and has no presentation
    // waiter to rendezvous with. Keeping it in the terminal race buffer would
    // let a later identical invocation reuse the outcome after that grant was
    // consumed.
    if (info.preauthorized) {
      return { state: "decided", decision: "once", info };
    }
    const outcome = await this.awaitDecision({
      acquisitionId: info.acquisitionId,
      ownerRuntimeId: input.caller.runtime.id,
      ...(signal ? { signal } : {}),
    });
    return {
      ...outcome,
      info: this.completedById.get(info.acquisitionId)?.info ?? { ...info, pending: false },
    };
  }

  async awaitDecision(input: {
    acquisitionId: string;
    ownerRuntimeId: string;
    signal?: AbortSignal;
  }): Promise<AcquisitionOutcome> {
    const targetJoin = this.targetJoins.get(input.acquisitionId)?.get(input.ownerRuntimeId);
    if (targetJoin) {
      const signal = input.signal;
      if (!signal) return await targetJoin.outcome;
      if (signal.aborted) throw acquisitionWaitAbortError();
      return await new Promise<AcquisitionOutcome>((resolve, reject) => {
        const abort = () => reject(acquisitionWaitAbortError());
        signal.addEventListener("abort", abort, { once: true });
        void targetJoin.outcome.then(resolve, reject).finally(() => {
          signal.removeEventListener("abort", abort);
        });
      });
    }
    const entry = this.byId.get(input.acquisitionId);
    if (!entry) {
      this.pruneTerminalCaches(Date.now());
      const completed = this.completedById.get(input.acquisitionId);
      if (completed?.ownerRuntimeId === input.ownerRuntimeId) return completed.outcome;
      throw Object.assign(new Error("Acquisition is not owned by this task"), { code: "EACCES" });
    }
    if (entry.info.ownerRuntimeId !== input.ownerRuntimeId) {
      throw Object.assign(new Error("Acquisition is not owned by this task"), { code: "EACCES" });
    }
    const signal = input.signal;
    if (!signal) return await entry.outcome;
    if (signal.aborted) throw acquisitionWaitAbortError();
    return await new Promise<AcquisitionOutcome>((resolve, reject) => {
      const abort = () => reject(acquisitionWaitAbortError());
      signal.addEventListener("abort", abort, { once: true });
      void entry.outcome.then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", abort);
      });
    });
  }

  closeSession(sessionId: string): void {
    for (const [requestId, joins] of [...this.targetJoins]) {
      for (const [ownerRuntimeId, join] of [...joins]) {
        if (join.sessionId !== sessionId) continue;
        this.settleOneTargetJoin(requestId, ownerRuntimeId, join, { state: "closed" });
      }
    }
    for (const entry of [...this.byId.values()]) {
      if (entry.sessionId !== sessionId) continue;
      this.cancelPresentation(entry);
      this.finish(entry, { state: "closed" });
    }
    for (const [acquisitionId, completed] of this.completedById) {
      if (completed.sessionId === sessionId) this.completedById.delete(acquisitionId);
    }
    this.deps.grantStore.pruneSession(sessionId);
  }

  closeAgent(agentBindingId: string): number {
    let closed = 0;
    for (const entry of [...this.byId.values()]) {
      if (entry.agentBindingId !== agentBindingId) continue;
      this.cancelPresentation(entry);
      this.finish(entry, { state: "closed" });
      closed += 1;
    }
    return closed;
  }

  closeAll(): number {
    const pending = [...this.byId.values()];
    for (const entry of pending) {
      this.cancelPresentation(entry);
      this.finish(entry, { state: "closed" });
    }
    let joined = 0;
    for (const [requestId, joins] of [...this.targetJoins]) {
      for (const [ownerRuntimeId, join] of [...joins]) {
        joined += 1;
        this.settleOneTargetJoin(requestId, ownerRuntimeId, join, { state: "closed" });
      }
    }
    return pending.length + joined;
  }

  private cancelPresentation(entry: PendingAcquisition): void {
    this.deps.approvalQueue.resolveMatching?.(
      (approval) =>
        approval.kind === "capability" &&
        approval.callerId === entry.info.ownerRuntimeId &&
        approval.capability === entry.info.capability &&
        approval.grantResourceKey === entry.info.resourceKey,
      "deny"
    );
  }

  pending(): readonly AcquisitionInfo[] {
    return [...this.byId.values()].map((entry) => ({ ...entry.info, pending: true }));
  }

  /** What is waiting on a human right now, as data a review surface can render. */
  pendingViews(): readonly PendingAcquisitionView[] {
    return [...this.byId.values()].map((entry) => ({
      acquisitionId: entry.info.acquisitionId,
      ownerRuntimeId: entry.info.ownerRuntimeId,
      capability: entry.info.capability,
      resource: entry.resource,
      resourceKey: entry.info.resourceKey,
      tier: entry.info.tier,
      renderedAction: entry.info.renderedAction,
      requestedAt: entry.requestedAt,
      agentBindingId: entry.agentBindingId,
    }));
  }

  /** Consume a once/confirmation grant before its protected effect runs. */
  consume(grantId: string): boolean {
    return this.deps.grantStore.consume(grantId);
  }

  touch(grantId: string): boolean {
    return this.deps.grantStore.touch(grantId);
  }

  /** Forget a raced terminal observation before beginning a fresh acquisition cycle. */
  invalidate(snapshotDigest: string, ownerRuntimeId: string, callerPrincipal: string): void {
    const requestKey = exactAcquisitionRequestKey({
      snapshotDigest,
      caller: { runtime: { id: ownerRuntimeId } },
      snapshot: { callerPrincipal },
    });
    this.completedById.delete(acquisitionIdFor(requestKey));
  }

  private async present(
    entry: PendingAcquisition,
    input: AcquisitionRequestInput,
    attention: "interrupt" | "queue",
    invocationSignal?: AbortSignal
  ): Promise<void> {
    const presentation = input.presentation;
    const signal = combineAbortSignals(invocationSignal, presentation?.signal);
    const allowedDecisions = intersectAllowedDecisions(
      decisionsForOrigin(input),
      input.presentation?.allowedDecisions
    );
    const requestBase = {
      callerId: input.caller.runtime.id,
      callerKind: approvalCallerKind(input.caller.runtime.kind),
      repoPath: input.caller.code?.repoPath ?? "vibestudio/session",
      effectiveVersion: input.caller.code?.effectiveVersion ?? input.snapshot.snippetDigest,
      attention,
      ...(input.caller.subject ? { requestedByUserId: input.caller.subject.userId } : {}),
      requesterCategory: input.caller.agentBinding
        ? ("agent" as const)
        : input.snapshot.snippetDigest === "-"
          ? ("unknown" as const)
          : ("eval" as const),
      ...(presentation?.operation ? { operation: presentation.operation } : {}),
      ...((input.target ?? presentation?.target)
        ? { target: input.target ?? presentation?.target }
        : {}),
      ...(presentation?.diffReview ? { diffReview: [...presentation.diffReview] } : {}),
      ...(signal ? { signal } : {}),
    };
    const decision = presentation?.installReview
      ? await this.deps.approvalQueue.request({
          ...requestBase,
          kind: "unit-install-review",
          dedupKey: presentation.dedupKey ?? entry.info.acquisitionId,
          mode: presentation.installReview.mode,
          ...(presentation.installReview.reportsLanding ? { reportsLanding: true } : {}),
          ...(presentation.installReview.landingToken
            ? { landingToken: presentation.installReview.landingToken }
            : {}),
          title: presentation.title,
          description:
            presentation.description ?? `Requests permission to ${input.renderedAction}.`,
          units: [...presentation.installReview.units],
          ...(presentation.installReview.template
            ? { template: presentation.installReview.template }
            : {}),
          unchangedPartCount: presentation.installReview.unchangedPartCount ?? 0,
          ...(presentation.installReview.previousRequests
            ? { previousRequests: presentation.installReview.previousRequests }
            : {}),
          ...(presentation.installReview.previouslyCleared
            ? { previouslyCleared: presentation.installReview.previouslyCleared }
            : {}),
          ...(presentation.installReview.origins
            ? { origins: presentation.installReview.origins }
            : {}),
          ...(presentation.installReview.identityKeys
            ? { identityKeys: presentation.installReview.identityKeys }
            : {}),
          ...(installReviewSections(presentation.installReview)
            ? { sections: installReviewSections(presentation.installReview)! }
            : {}),
          configWrite: presentation.installReview.configWrite ?? null,
        })
      : await this.deps.approvalQueue.request({
          ...requestBase,
          kind: "capability",
          capability: input.snapshot.capability,
          dedupKey: presentation?.dedupKey ?? entry.info.acquisitionId,
          severity: presentation?.severity ?? (input.tier === "critical" ? "severe" : "standard"),
          title: presentation?.title ?? authorityActionTitle(input.renderedAction),
          description:
            presentation?.description ??
            (input.tier === "critical"
              ? "This action can't be undone. Check the details before confirming."
              : `Requests permission to ${input.renderedAction}.`),
          resource: presentation?.resource ?? {
            type: "authority-resource",
            label: "Where",
            value: input.snapshot.resourceKey,
          },
          grantResourceKey: input.snapshot.resourceKey,
          resourceScope: approvalScopeForAuthorityResource(input.resource),
          operation: presentation?.operation ?? {
            kind: "unknown",
            verb: input.renderedAction,
            groupKey:
              input.tier === "critical"
                ? `confirm:${input.snapshotDigest}`
                : `acquire:${input.snapshot.sessionId}`,
          },
          ...(presentation?.details ? { details: [...presentation.details] } : {}),
          snapshot: input.snapshot,
          cardType: entry.info.cardType,
          allowedDecisions: [...allowedDecisions],
          authorityRow: authorityRow({
            capability: input.snapshot.capability,
            resource: input.resource,
            resourcePhrase: presentation?.resource.value,
            tier: input.tier,
            statement: "prospective",
            provenance: {
              source: "receiver",
              ...(presentation?.authorityVocabulary
                ? { surface: `declared by ${presentation.authorityVocabulary.declaredBy}` }
                : {}),
            },
            flags: {
              lineageTainted:
                input.snapshot.lineageClasses?.some((lineage) => lineage !== "none") ?? false,
              irreversible: input.snapshot.irreversible === true,
            },
            ...(presentation?.authorityVocabulary
              ? {
                  category: {
                    domain: presentation.authorityVocabulary.domain,
                    verb: presentation.authorityVocabulary.verb,
                  },
                  reviewedAction: input.renderedAction,
                }
              : {}),
          }),
          ...(input.substance ? { operationSubstance: input.substance } : {}),
        });

    if (this.byId.get(entry.info.acquisitionId) !== entry) return;
    // ApprovalQueue resolves an aborted waiter as deny so callers are never
    // left parked. Cancellation is lifecycle, not a user verdict: close the
    // rendezvous without writing a durable deny or cooldown.
    if (signal?.aborted) {
      entry.info.pending = false;
      this.finish(entry, { state: "closed" });
      return;
    }
    if (decision === "dismiss") {
      const ruleKey = acquisitionRuleKey(input);
      const previous = this.cooldowns.get(ruleKey);
      const cooldown = {
        until: Date.now() + AcquisitionCoordinator.DISMISS_COOLDOWN_MS,
        dismissals: (previous?.dismissals ?? 0) + 1,
        lastDismissedAt: Date.now(),
      };
      this.setCooldown(ruleKey, cooldown);
      entry.info.pending = true;
      entry.info.cooldownUntil = cooldown.until;
      this.finish(entry, { state: "closed" });
      return;
    }
    const authorityDecision =
      decision === "accepted" && presentation?.installReview
        ? acceptedInstallReviewDecision(allowedDecisions)
        : decision;
    if (
      !isAuthorityAcquisitionDecision(authorityDecision) ||
      !allowedDecisions.includes(authorityDecision)
    ) {
      throw new Error(`Authority presentation returned disallowed decision '${decision}'`);
    }
    const grantId = this.persistDecision(input, authorityDecision);
    entry.info.pending = false;
    this.finish(entry, {
      state: "decided",
      decision: authorityDecision,
      ...(grantId ? { grantId } : {}),
    });
  }

  private finish(entry: PendingAcquisition, outcome: AcquisitionOutcome): void {
    if (this.byId.get(entry.info.acquisitionId) !== entry) return;
    this.byId.delete(entry.info.acquisitionId);
    this.byRequestKey.delete(entry.requestKey);
    if (!entry.info.cooldownUntil) entry.info.pending = false;
    const completed: CompletedAcquisition = {
      ownerRuntimeId: entry.info.ownerRuntimeId,
      sessionId: entry.sessionId,
      info: { ...entry.info },
      outcome,
      expiresAt: Date.now() + AcquisitionCoordinator.COMPLETION_RETENTION_MS,
    };
    this.completedById.delete(entry.info.acquisitionId);
    this.completedById.set(entry.info.acquisitionId, completed);
    this.trimOldest(this.completedById, AcquisitionCoordinator.MAX_COMPLETIONS);
    entry.settle(outcome);
    if (entry.continuation !== "owner-redrive") return;
    void Promise.resolve(
      this.deps.notifyOwner?.(entry.info.ownerRuntimeId, entry.info.acquisitionId)
    ).catch((error) => {
      console.warn(
        `[AuthorityAcquisition] wake hint failed for ${entry.info.ownerRuntimeId}:`,
        error instanceof Error ? error.message : String(error)
      );
    });
  }

  private setCooldown(
    ruleKey: string,
    value: { until: number; dismissals: number; lastDismissedAt: number }
  ): void {
    this.cooldowns.delete(ruleKey);
    this.cooldowns.set(ruleKey, value);
    this.trimOldest(this.cooldowns, AcquisitionCoordinator.MAX_COOLDOWNS);
  }

  private pruneTerminalCaches(now: number): void {
    for (const [acquisitionId, completed] of this.completedById) {
      if (completed.expiresAt <= now) this.completedById.delete(acquisitionId);
    }
    for (const [ruleKey, cooldown] of this.cooldowns) {
      if (cooldown.lastDismissedAt + AcquisitionCoordinator.FATIGUE_MEMORY_MS <= now) {
        this.cooldowns.delete(ruleKey);
      }
    }
    for (const [contextKey, timestamps] of this.interruptions) {
      const live = timestamps.filter(
        (timestamp) => timestamp + AcquisitionCoordinator.INTERRUPT_WINDOW_MS > now
      );
      if (live.length === 0) this.interruptions.delete(contextKey);
      else if (live.length !== timestamps.length) this.interruptions.set(contextKey, live);
    }
  }

  private attentionFor(
    input: AcquisitionRequestInput,
    ruleKey: string,
    now: number
  ): "interrupt" | "queue" {
    // Critical confirmations remain immediate. Ordinary requests share one
    // interruption slot per principal + execution context; concurrent asks
    // remain fully discoverable in the shell's waiting pill.
    if (input.tier === "critical") return "interrupt";
    if ((this.cooldowns.get(ruleKey)?.dismissals ?? 0) >= 2) return "queue";
    const contextKey = acquisitionAttentionContextKey(input);
    const recent = (this.interruptions.get(contextKey) ?? []).filter(
      (timestamp) => timestamp + AcquisitionCoordinator.INTERRUPT_WINDOW_MS > now
    );
    if (recent.length >= AcquisitionCoordinator.MAX_INTERRUPTS_PER_CONTEXT_WINDOW) {
      this.interruptions.set(contextKey, recent);
      return "queue";
    }
    recent.push(now);
    this.interruptions.delete(contextKey);
    this.interruptions.set(contextKey, recent);
    this.trimOldest(this.interruptions, AcquisitionCoordinator.MAX_COOLDOWNS);
    return "interrupt";
  }

  private trimOldest<K, V>(entries: Map<K, V>, maximum: number): void {
    while (entries.size > maximum) {
      const oldest = entries.keys().next();
      if (oldest.done) return;
      entries.delete(oldest.value);
    }
  }

  private persistDecision(
    input: AcquisitionRequestInput,
    decision: AuthorityAcquisitionDecision
  ): string | undefined {
    const capabilityDefinition =
      input.snapshot.capabilityDefinitionDigest === "-"
        ? {}
        : { capabilityDefinitionDigest: input.snapshot.capabilityDefinitionDigest };
    if (decision === "deny") {
      if (input.tier === "critical") return;
      this.deps.grantStore.issue({
        effect: "deny",
        capability: input.snapshot.capability,
        resource: input.resource,
        subject: input.snapshot.callerPrincipal,
        constraints: {
          ...(input.snapshot.missionSubject === "-"
            ? { sessionId: input.snapshot.sessionId }
            : { missionSubject: input.snapshot.missionSubject }),
          lineageAtConsent: [],
        },
        issuedBy: input.caller.subject ? `user:${input.caller.subject.userId}` : "user:system",
        provenance: "acquisition",
        ...capabilityDefinition,
      });
      return;
    }
    if (input.tier === "critical" && decision !== "once") {
      throw new Error("Critical confirmation can only be granted once");
    }
    const lineageAtConsent = [...(input.snapshot.lineageClasses ?? ["none"])];
    const sessionSubject = `session:${input.snapshot.sessionId}` as const;
    if (decision === "once") {
      this.deps.grantStore.issue({
        effect: "allow",
        capability: input.snapshot.capability,
        resource: input.resource,
        subject: sessionSubject,
        constraints: {
          sessionId: input.snapshot.sessionId,
          invocationDigest: input.snapshotDigest,
          ...(input.snapshot.agentBindingId
            ? { agentBindingId: input.snapshot.agentBindingId }
            : {}),
          ...(input.snapshot.missionSubject === "-"
            ? {}
            : { missionSubject: input.snapshot.missionSubject }),
          lineageAtConsent,
        },
        issuedBy: input.caller.subject ? `user:${input.caller.subject.userId}` : "user:system",
        provenance: input.tier === "critical" ? "critical-confirmation" : "acquisition",
        ...capabilityDefinition,
      });
      return;
    }
    if (decision === "session") {
      this.deps.grantStore.issue({
        effect: "allow",
        capability: input.snapshot.capability,
        resource: input.resource,
        subject: sessionSubject,
        constraints: {
          sessionId: input.snapshot.sessionId,
          ...(input.snapshot.agentBindingId
            ? { agentBindingId: input.snapshot.agentBindingId }
            : {}),
          ...(input.snapshot.missionSubject === "-"
            ? {}
            : { missionSubject: input.snapshot.missionSubject }),
          lineageAtConsent,
        },
        issuedBy: input.caller.subject ? `user:${input.caller.subject.userId}` : "user:system",
        provenance: "acquisition",
        ...capabilityDefinition,
        scope: "session",
        ...(input.presentation?.grantExpiresAt
          ? { expiresAt: input.presentation.grantExpiresAt }
          : {}),
      });
      return;
    }
    if (decision === "task") {
      if (!input.snapshot.taskAuthority) {
        throw new Error("Task approval requires an attested task authority");
      }
      this.deps.grantStore.issue({
        effect: "allow",
        capability: input.snapshot.capability,
        resource: input.resource,
        subject: input.snapshot.taskAuthority,
        constraints: {
          ...(input.snapshot.missionSubject === "-"
            ? {}
            : { missionSubject: input.snapshot.missionSubject }),
          lineageAtConsent,
        },
        issuedBy: input.caller.subject ? `user:${input.caller.subject.userId}` : "user:system",
        provenance: "acquisition",
        ...capabilityDefinition,
        scope: "task",
      });
      return;
    }
    if (decision === "agent") {
      if (
        !input.snapshot.agentBindingId ||
        input.snapshot.agentScopeEligible !== true ||
        input.snapshot.irreversible
      ) {
        throw new Error("Standing agent authority is not eligible for this invocation");
      }
      this.deps.grantStore.issue({
        effect: "allow",
        capability: input.snapshot.capability,
        resource: input.resource,
        subject: `agent:${input.snapshot.agentBindingId}`,
        constraints: {
          lineageAtConsent,
          agentBindingId: input.snapshot.agentBindingId,
        },
        issuedBy: input.caller.subject ? `user:${input.caller.subject.userId}` : "user:system",
        provenance: "acquisition",
        ...capabilityDefinition,
        scope: "agent",
        lastUsedAt: Date.now(),
        decidedBy: input.caller.subject ? `user:${input.caller.subject.userId}` : "user:system",
        decisionSurface: "card",
      });
      return;
    }
    if (decision === "mission") {
      if (input.snapshot.missionSubject === "-") {
        throw new Error("Mission approval requires an attested mission");
      }
      return this.deps.grantStore.issue({
        effect: "allow",
        capability: input.snapshot.capability,
        resource: input.resource,
        subject: input.snapshot.missionSubject,
        constraints: {
          missionSubject: input.snapshot.missionSubject,
          lineageAtConsent,
        },
        issuedBy: input.caller.subject ? `user:${input.caller.subject.userId}` : "user:system",
        provenance: "acquisition",
        scope: "mission",
        ...capabilityDefinition,
      }).id;
    }
    if (decision === "lock") {
      if (!input.snapshot.agentBindingId) {
        throw new Error("A standing lock requires an attested agent binding");
      }
      this.deps.grantStore.createLock({
        agentBindingId: input.snapshot.agentBindingId,
        level: "resource",
        capability: input.snapshot.capability,
        resource: input.resource,
        decidedBy: input.caller.subject ? `user:${input.caller.subject.userId}` : "user:system",
        surface: "card",
      });
      return;
    }
    if (!input.snapshot.callerPrincipal.startsWith("code:")) {
      throw new Error("Always-allow is only valid for an installed code identity");
    }
    this.deps.grantStore.issue({
      effect: "allow",
      capability: input.snapshot.capability,
      resource: input.resource,
      subject: input.snapshot.callerPrincipal,
      constraints: {
        lineageAtConsent: [],
        ...(decision === "version" && input.snapshot.providerExecutionDigest !== "-"
          ? { providerExecutionDigest: input.snapshot.providerExecutionDigest }
          : {}),
      },
      issuedBy: input.caller.subject ? `user:${input.caller.subject.userId}` : "user:system",
      provenance: "acquisition",
      scope: "version",
      ...capabilityDefinition,
      ...(input.presentation?.grantExpiresAt
        ? { expiresAt: input.presentation.grantExpiresAt }
        : {}),
    });
    return;
  }
}

/**
 * Which section each changed part belongs to, when the producer derived one
 * (§5.3 — a template's own parts, versus repairs the same publication makes to
 * parts already in the workspace).
 *
 * Absent for every producer that never classifies its parts, which is every one
 * of them except the template gate: only a publication that moves a template
 * root has a closure to be inside or outside of.
 */
function installReviewSections(
  installReview: NonNullable<AuthorityChallengePresentation["installReview"]>
): ReadonlyMap<string, "template" | "repair"> | null {
  const sections = installReview.sections;
  return sections && sections.size > 0 ? sections : null;
}

function testPolicyIntegrityError(
  code: "ETESTPOLICYMISSING" | "ETESTPOLICYMISMATCH",
  message: string,
  input: AcquisitionRequestInput
): Error {
  return Object.assign(new Error(message), {
    code,
    capability: input.snapshot.capability,
    resourceKey: input.snapshot.resourceKey,
    tier: input.tier,
    snapshotPolicyId: input.snapshot.testPolicyId ?? null,
    residentPolicyId:
      input.caller.testPolicy?.policyId ??
      input.caller.executionSession?.testPolicy?.policyId ??
      null,
  });
}

function combineAbortSignals(
  invocationSignal: AbortSignal | undefined,
  presentationSignal: AbortSignal | undefined
): AbortSignal | undefined {
  if (!invocationSignal) return presentationSignal;
  if (!presentationSignal || presentationSignal === invocationSignal) return invocationSignal;
  return AbortSignal.any([invocationSignal, presentationSignal]);
}

function acquisitionWaitAbortError(): Error {
  return Object.assign(new Error("Authority acquisition wait was aborted"), {
    name: "AbortError",
    code: "ABORT_ERR",
  });
}

function authorityActionTitle(action: string): string {
  const clean = action.trim().replace(/[?.!]+$/u, "");
  if (!clean) return "Review requested action";
  return `${clean.charAt(0).toUpperCase()}${clean.slice(1)}`;
}

function targetRequestCallerId(requestId: string): string {
  return `authority-subject-request:${requestId}`;
}

function targetOutcome(request: DurableTargetAuthorityRequest | null): AcquisitionOutcome {
  if (!request || request.state === "cancelled") return { state: "closed" };
  if (request.state === "denied") return { state: "decided", decision: "deny" };
  if (request.state === "granted") {
    const decision = request.targetSubject.startsWith("mission:") ? "mission" : "task";
    return {
      state: "decided",
      decision,
      ...(request.grantId ? { grantId: request.grantId } : {}),
    };
  }
  throw new Error(`Target request ${request.requestId} is still pending`);
}

function exactAcquisitionRequestKey(input: {
  snapshotDigest: string;
  caller: { runtime: { id: string } };
  snapshot: { callerPrincipal: string };
}): string {
  return canonicalKey([
    input.snapshotDigest,
    input.caller.runtime.id,
    input.snapshot.callerPrincipal,
  ]);
}

/**
 * Installed code cannot receive an invocation-scoped decision for a gated
 * request: the only positive choices are the current task (when attested) or
 * the installed version. Keeping a rendezvous per invocation in that case
 * creates several indistinguishable cards for concurrent calls, even though
 * every decision the card offers necessarily covers all of them.
 *
 * Coalesce only when the eventual grant and the user-visible operation are the
 * same. Critical effects and session-origin calls retain their exact invocation
 * identity because they can still be approved once.
 */
function acquisitionRequestKey(input: AcquisitionRequestInput): string {
  if (
    input.tier !== "gated" ||
    !input.snapshot.callerPrincipal.startsWith("code:") ||
    input.presentation?.installReview
  ) {
    return exactAcquisitionRequestKey(input);
  }
  return canonicalKey([
    "reusable-code-acquisition-v1",
    canonicalJson({
      ownerRuntimeId: input.caller.runtime.id,
      callerPrincipal: input.snapshot.callerPrincipal,
      capability: input.snapshot.capability,
      resource: input.resource,
      capabilityDefinitionDigest: input.snapshot.capabilityDefinitionDigest,
      providerExecutionDigest: input.snapshot.providerExecutionDigest,
      targetCapability: input.snapshot.targetCapability ?? null,
      targetRequirement: input.snapshot.targetRequirement ?? null,
      taskAuthority: input.snapshot.taskAuthority ?? null,
      taskRef: input.snapshot.taskRef ?? null,
      lineageClasses: [...(input.snapshot.lineageClasses ?? ["none"])].sort(),
      codeLineage: input.snapshot.codeLineage,
      contextLineage: input.snapshot.contextLineage,
      presentation: input.presentation ?? null,
      substance: input.substance ?? null,
    }),
  ]);
}

function acquisitionIdFor(requestKey: string): string {
  return `acq:${createHash("sha256").update(requestKey).digest("hex")}`;
}

function acquisitionRuleKey(input: AcquisitionRequestInput): string {
  return canonicalKey([
    input.snapshot.callerPrincipal,
    input.snapshot.taskAuthority ?? input.snapshot.taskRef ?? input.snapshot.sessionId,
    input.snapshot.capability,
    input.snapshot.resourceKey,
  ]);
}

function acquisitionAttentionContextKey(input: AcquisitionRequestInput): string {
  return canonicalKey([
    input.snapshot.callerPrincipal,
    input.snapshot.taskAuthority ?? input.snapshot.taskRef ?? input.snapshot.sessionId,
  ]);
}

function cardTypeFor(input: AcquisitionRequestInput): AuthorityPromptCardType {
  return authorityPromptCardType({
    tier: input.tier,
    capability: input.snapshot.capability,
    outsideContent: input.snapshot.contextLineage?.class === "external",
  });
}

function approvalCallerKind(
  kind: string
): "panel" | "app" | "worker" | "do" | "extension" | "system" {
  switch (kind) {
    case "panel":
    case "app":
    case "worker":
    case "do":
    case "extension":
      return kind;
    case "agent":
      return "do";
    default:
      return "system";
  }
}

function decisionsForOrigin(
  input: AcquisitionRequestInput
): readonly AuthorityAcquisitionDecision[] {
  if (input.tier === "critical") return ["once", "deny"];
  if (input.snapshot.callerPrincipal.startsWith("session:")) {
    return [
      "once",
      "session",
      "task",
      ...(input.snapshot.missionSubject === "-" ? [] : (["mission"] as const)),
      ...(input.snapshot.agentBindingId && input.snapshot.agentScopeEligible
        ? (["agent", "lock"] as const)
        : []),
      "deny",
    ];
  }
  if (input.snapshot.callerPrincipal.startsWith("code:")) {
    return [
      "once",
      ...(input.snapshot.taskAuthority ? (["task"] as const) : []),
      "version",
      "deny",
    ];
  }
  // Gated interactive acquisition is defined for session and installed-code
  // subjects. User/host principals reach these operations through their
  // authenticated session or host admission, not by minting an incompatible
  // subject that the evaluator could never consume.
  return ["deny"];
}

function intersectAllowedDecisions(
  origin: readonly AuthorityAcquisitionDecision[],
  operation: readonly import("@vibestudio/shared/approvals").ApprovalDecision[] | undefined
): AuthorityAcquisitionDecision[] {
  const allowed = operation
    ? origin.filter((decision) => operation.includes(decision))
    : [...origin];
  if (!allowed.includes("deny")) allowed.push("deny");
  if (!allowed.some((decision) => decision !== "deny")) {
    throw new Error(
      "Authority acquisition has no grant decision valid for this origin and operation"
    );
  }
  return allowed;
}

function isAuthorityAcquisitionDecision(
  decision: ApprovalQueueDecision
): decision is AuthorityAcquisitionDecision {
  return (
    decision === "once" ||
    decision === "session" ||
    decision === "task" ||
    decision === "mission" ||
    decision === "agent" ||
    decision === "lock" ||
    decision === "version" ||
    decision === "deny"
  );
}

/**
 * Accepting a unit review admits exact part versions, but the protected effect
 * that presented it still needs a grant in the caller's authority vocabulary.
 * A session authorizes only this invocation; installed code authorizes its
 * exact reviewed version. The intersection was validated before presentation,
 * so reaching the fallback is an internal contract violation.
 */
function acceptedInstallReviewDecision(
  allowed: readonly AuthorityAcquisitionDecision[]
): AuthorityAcquisitionDecision {
  if (allowed.includes("version")) return "version";
  if (allowed.includes("once")) return "once";
  throw new Error("Accepted install review has no compatible authority decision");
}
