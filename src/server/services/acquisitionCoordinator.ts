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
    return this.requestWithContinuation([input], "owner-redrive", signal);
  }

  requestMany(inputs: readonly AcquisitionRequestInput[], signal?: AbortSignal): AcquisitionInfo {
    return this.requestWithContinuation(inputs, "owner-redrive", signal);
  }

  private requestWithContinuation(
    inputs: readonly AcquisitionRequestInput[],
    continuation: PendingAcquisition["continuation"],
    signal?: AbortSignal
  ): AcquisitionInfo {
    const input = validateAcquisitionGroup(inputs);
    // Validate the subject/operation decision intersection before publishing a
    // pending card. An unconsumable approval is a protocol error, not a prompt.
    allowedDecisionsForGroup(inputs);
    const now = Date.now();
    this.pruneTerminalCaches(now);
    const targetRequest = inputs.length === 1 ? this.matchingTargetRequest(input) : null;
    if (targetRequest) return this.joinTargetRequest(targetRequest, input, continuation);
    const requestKey = acquisitionRequestGroupKey(inputs);
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
      const rules = inputs.map((facet) =>
        testPolicyAuthorityDecision(facet.caller, undefined, {
          capability: facet.snapshot.capability,
          resourceKey: facet.snapshot.resourceKey,
          tier: facet.tier,
          irreversible: facet.snapshot.irreversible,
        })
      );
      const missingRuleIndex = rules.findIndex((rule) => !rule);
      if (
        missingRuleIndex >= 0 &&
        testPolicy.kind === "case" &&
        testPolicy.case.unexpectedPrompts === "fail"
      ) {
        const unexpected = inputs[missingRuleIndex]!;
        throw Object.assign(
          new Error(
            `Unexpected authority prompt in system test ${testPolicy.case.testId}: ` +
              `${unexpected.snapshot.capability} on ${unexpected.snapshot.resourceKey} (${unexpected.tier})`
          ),
          {
            code: "EUNEXPECTEDTESTPROMPT",
            testId: testPolicy.case.testId,
            capability: unexpected.snapshot.capability,
            resourceKey: unexpected.snapshot.resourceKey,
            tier: unexpected.tier,
          }
        );
      }
      if (missingRuleIndex >= 0) {
        // Orchestrator policies intentionally cannot ratify critical or
        // irreversible work; those requests continue through the real queue.
      } else {
        inputs.forEach((facet, index) => {
          const rule = rules[index]!;
          this.deps.grantStore.issue({
            effect: rule.decision === "deny" ? "deny" : "allow",
            capability: facet.snapshot.capability,
            resource: facet.resource,
            // Test policy may be inherited by reviewed infrastructure code without
            // changing its authorizing origin into a session. Mint the invocation
            // grant to the exact principal the immutable snapshot evaluated; keep
            // the execution/session identity as a constraint, never as a substitute
            // principal.
            subject: facet.snapshot.callerPrincipal,
            constraints: {
              sessionId: facet.snapshot.sessionId,
              ...(facet.snapshot.agentBindingId
                ? { agentBindingId: facet.snapshot.agentBindingId }
                : {}),
              invocationDigest: facet.snapshotDigest,
              lineageAtConsent: [...(facet.snapshot.lineageClasses ?? ["none"])],
            },
            issuedBy: `host:${facet.snapshot.testPolicyId}:${rule.ruleId}`,
            provenance:
              facet.tier === "critical" && rule.decision === "once"
                ? "critical-confirmation"
                : "preauthorization",
            scope: "once",
          });
        });
        const info: AcquisitionInfo = {
          acquisitionId,
          ownerRuntimeId: input.caller.runtime.id,
          snapshotDigest: input.snapshotDigest,
          capability: input.snapshot.capability,
          resourceKey: input.snapshot.resourceKey,
          tier: tierForGroup(inputs),
          cardType: cardTypeForGroup(inputs),
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
        tier: tierForGroup(inputs),
        cardType: cardTypeForGroup(inputs),
        renderedAction: input.renderedAction,
        pending: true,
        cooldownUntil: cooldown.until,
      };
    }
    // Every actionable acquisition is presented immediately. `attention` is
    // still carried by the approval protocol for producer-selected external
    // notification policy, but the coordinator no longer rate-limits prompts
    // by silently moving concurrent work into a background queue.
    const attention = "interrupt" as const;

    const cardType = cardTypeForGroup(inputs);
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
      tier: tierForGroup(inputs),
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
    void this.present(entry, inputs, attention, signal).catch((error) => {
      this.finish(entry, { state: "closed" });
      console.error("[AuthorityAcquisition] approval presentation failed:", error);
    });
    return { ...info };
  }

  async requestAndWait(
    input: AcquisitionRequestInput,
    signal?: AbortSignal
  ): Promise<AcquisitionOutcome> {
    return this.requestManyAndWait([input], signal);
  }

  async requestManyAndWait(
    inputs: readonly AcquisitionRequestInput[],
    signal?: AbortSignal
  ): Promise<AcquisitionOutcome> {
    const input = validateAcquisitionGroup(inputs);
    const info = this.requestWithContinuation(inputs, "in-band", signal);
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
      // `authority.awaitDecision` is the second half of the RPC client's
      // wait-mode protocol. Once that waiter has joined, settlement is already
      // delivered through the held call; waking the owner as well can restart
      // the runtime and tear down the transport carrying this response.
      targetJoin.continuation = "in-band";
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
    // A separately initiated await is just as in-band as requestAndWait().
    // Record the live continuation at the rendezvous, rather than retaining
    // the fire-and-forget classification from the original protected call.
    entry.continuation = "in-band";
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
    inputs: readonly AcquisitionRequestInput[],
    attention: "interrupt" | "queue",
    invocationSignal?: AbortSignal
  ): Promise<void> {
    const input = validateAcquisitionGroup(inputs);
    const presentation = input.presentation;
    const signal = combineAcquisitionSignals(invocationSignal, inputs);
    const allowedDecisions = allowedDecisionsForGroup(inputs);
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
          severity:
            inputs.some((facet) => facet.presentation?.severity === "severe") ||
            tierForGroup(inputs) === "critical"
              ? "severe"
              : (presentation?.severity ?? "standard"),
          title: presentation?.title ?? authorityActionTitle(input.renderedAction),
          description:
            presentation?.description ??
            (tierForGroup(inputs) === "critical"
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
              tierForGroup(inputs) === "critical"
                ? `confirm:${input.snapshotDigest}`
                : `acquire:${input.snapshot.sessionId}`,
          },
          ...(presentation?.details ? { details: [...presentation.details] } : {}),
          snapshot: input.snapshot,
          cardType: entry.info.cardType,
          allowedDecisions: [...allowedDecisions],
          authorityRow: authorityRowForAcquisition(input),
          ...(inputs.length > 1
            ? {
                authorityFacets: inputs.map((facet) => ({
                  capability: facet.snapshot.capability,
                  title: facet.presentation?.title ?? authorityActionTitle(facet.renderedAction),
                  ...(facet.presentation?.description
                    ? { description: facet.presentation.description }
                    : {}),
                  ...(facet.presentation?.resource
                    ? { resource: facet.presentation.resource }
                    : {}),
                  row: authorityRowForAcquisition(facet),
                })),
              }
            : {}),
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
    const grantIds = inputs
      .map((facet) => this.persistDecision(facet, authorityDecision))
      .filter((grantId): grantId is string => grantId !== undefined);
    entry.info.pending = false;
    this.finish(entry, {
      state: "decided",
      decision: authorityDecision,
      ...(grantIds[0] ? { grantId: grantIds[0] } : {}),
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
      // Critical confirmations are deliberately session facts, but an
      // ordinary gated grant must remain in the caller's authorizing subject
      // family. Installed code does not inherit ambient session grants; using
      // a session subject here made an approved exact code invocation
      // impossible to consume and left RPC clients retrying forever.
      const onceSubject =
        input.tier === "critical" ? sessionSubject : input.snapshot.callerPrincipal;
      this.deps.grantStore.issue({
        effect: "allow",
        capability: input.snapshot.capability,
        resource: input.resource,
        subject: onceSubject,
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
 * Installed code requests may be coalesced across invocations only when the
 * operation excludes invocation-scoped approval. If `once` is available, the
 * rendezvous must retain exact invocation identity so consuming one decision
 * cannot strand a later identical call behind a completed acquisition.
 *
 * Coalesce only when the eventual grant and the user-visible operation are the
 * same. Critical effects and session-origin calls retain their exact invocation
 * identity because they can still be approved once.
 */
function acquisitionRequestKey(input: AcquisitionRequestInput): string {
  const permitsInvocationDecision =
    decisionsForOrigin(input).includes("once") &&
    (input.presentation?.allowedDecisions === undefined ||
      input.presentation.allowedDecisions.includes("once"));
  if (
    input.tier !== "gated" ||
    !input.snapshot.callerPrincipal.startsWith("code:") ||
    permitsInvocationDecision ||
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

function validateAcquisitionGroup(
  inputs: readonly AcquisitionRequestInput[]
): AcquisitionRequestInput {
  const first = inputs[0];
  if (!first) throw new Error("Authority acquisition group cannot be empty");
  for (const input of inputs.slice(1)) {
    if (
      input.snapshot.sessionId !== first.snapshot.sessionId ||
      input.snapshot.service !== first.snapshot.service ||
      input.snapshot.method !== first.snapshot.method ||
      input.snapshot.argsDigest !== first.snapshot.argsDigest ||
      input.snapshot.preparedStateDigest !== first.snapshot.preparedStateDigest
    ) {
      throw new Error("Composed authority leaves must belong to one exact invocation");
    }
  }
  return first;
}

function acquisitionRequestGroupKey(inputs: readonly AcquisitionRequestInput[]): string {
  const first = validateAcquisitionGroup(inputs);
  if (inputs.length === 1) return acquisitionRequestKey(first);
  return canonicalKey([
    "composed-acquisition-v1",
    canonicalJson(
      inputs.map((input) => ({
        requestKey: acquisitionRequestKey(input),
        snapshotDigest: input.snapshotDigest,
        presentation: input.presentation ?? null,
        target: input.target ?? null,
        substance: input.substance ?? null,
      }))
    ),
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

function cardTypeFor(input: AcquisitionRequestInput): AuthorityPromptCardType {
  return authorityPromptCardType({
    tier: input.tier,
    capability: input.snapshot.capability,
    outsideContent: input.snapshot.contextLineage?.class === "external",
  });
}

function tierForGroup(inputs: readonly AcquisitionRequestInput[]): "gated" | "critical" {
  return inputs.some((input) => input.tier === "critical") ? "critical" : "gated";
}

function cardTypeForGroup(inputs: readonly AcquisitionRequestInput[]): AuthorityPromptCardType {
  if (tierForGroup(inputs) === "critical") return "confirm.critical";
  const outside = inputs.find((input) => input.snapshot.contextLineage?.class === "external");
  return cardTypeFor(outside ?? validateAcquisitionGroup(inputs));
}

function authorityRowForAcquisition(input: AcquisitionRequestInput) {
  const presentation = input.presentation;
  return authorityRow({
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
      lineageTainted: input.snapshot.lineageClasses?.some((lineage) => lineage !== "none") ?? false,
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
  });
}

function combineAcquisitionSignals(
  invocationSignal: AbortSignal | undefined,
  inputs: readonly AcquisitionRequestInput[]
): AbortSignal | undefined {
  const signals = [invocationSignal, ...inputs.map((input) => input.presentation?.signal)].filter(
    (signal): signal is AbortSignal => signal !== undefined
  );
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any([...new Set(signals)]);
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

function allowedDecisionsForGroup(
  inputs: readonly AcquisitionRequestInput[]
): AuthorityAcquisitionDecision[] {
  validateAcquisitionGroup(inputs);
  let allowed: AuthorityAcquisitionDecision[] | null = null;
  for (const input of inputs) {
    const current = intersectAllowedDecisions(
      decisionsForOrigin(input),
      input.presentation?.allowedDecisions
    );
    allowed = allowed ? allowed.filter((decision) => current.includes(decision)) : current;
  }
  if (!allowed || !allowed.some((decision) => decision !== "deny")) {
    throw new Error("Composed authority leaves have no common grant decision");
  }
  if (!allowed.includes("deny")) allowed.push("deny");
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
