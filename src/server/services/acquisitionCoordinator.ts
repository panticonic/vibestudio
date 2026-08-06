import type { AcquisitionInfo, InvocationSnapshot, ResourceScope } from "@vibestudio/rpc";
import { canonicalKey } from "@vibestudio/shared/canonicalKey";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { AuthorityChallengePresentation } from "@vibestudio/shared/serviceDispatcher";
import type { OperationSubstance } from "@vibestudio/shared/approvals";
import type { AuthorityAcquisitionDecision } from "@vibestudio/shared/approvalContract";
import {
  authorityPromptCardType,
  type AuthorityPromptCardType,
} from "@vibestudio/shared/authority/promptRegistry";
import type { ApprovalQueue, ApprovalQueueDecision } from "./approvalQueue.js";
import {
  approvalScopeForAuthorityResource,
  type CapabilityGrantStore,
} from "./capabilityGrantStore.js";
import { createHash } from "node:crypto";
import { authorityRow } from "@vibestudio/shared/authority/authorityRows";
import { testPolicyAuthorityDecision } from "./authorityRuntime.js";

export interface AcquisitionRequestInput {
  snapshot: InvocationSnapshot;
  snapshotDigest: string;
  tier: "gated" | "critical";
  caller: VerifiedCaller;
  renderedAction: string;
  resource: ResourceScope;
  presentation?: AuthorityChallengePresentation;
  substance?: OperationSubstance;
}

export interface AcquisitionOutcome {
  state: "decided" | "closed";
  decision?: AuthorityAcquisitionDecision;
  info?: AcquisitionInfo;
}

interface PendingAcquisition {
  requestKey: string;
  info: AcquisitionInfo;
  sessionId: string;
  agentBindingId: string | null;
  outcome: Promise<AcquisitionOutcome>;
  settle: (outcome: AcquisitionOutcome) => void;
  continuation: "in-band" | "owner-redrive";
}

interface CompletedAcquisition {
  ownerRuntimeId: string;
  sessionId: string;
  info: AcquisitionInfo;
  outcome: AcquisitionOutcome;
  expiresAt: number;
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

  constructor(
    private readonly deps: {
      approvalQueue: ApprovalQueue;
      grantStore: CapabilityGrantStore;
      notifyOwner?: (ownerRuntimeId: string, acquisitionId: string) => Promise<void> | void;
    }
  ) {}

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
    return pending.length;
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

  /** Consume a once/confirmation grant before its protected effect runs. */
  consume(grantId: string): boolean {
    return this.deps.grantStore.consume(grantId);
  }

  touch(grantId: string): boolean {
    return this.deps.grantStore.touch(grantId);
  }

  /** Forget a raced terminal observation before beginning a fresh acquisition cycle. */
  invalidate(snapshotDigest: string, ownerRuntimeId: string, callerPrincipal: string): void {
    const requestKey = acquisitionRequestKey({
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
          ...(presentation.installReview.charters
            ? { charters: presentation.installReview.charters }
            : {}),
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
    this.persistDecision(input, authorityDecision);
    entry.info.pending = false;
    this.finish(entry, { state: "decided", decision: authorityDecision });
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
  ): void {
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
          sessionId: input.snapshot.sessionId,
          ...(input.snapshot.reviewedClosureSubject === "-"
            ? {}
            : { reviewedClosureSubject: input.snapshot.reviewedClosureSubject }),
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
          ...(input.snapshot.reviewedClosureSubject === "-"
            ? {}
            : { reviewedClosureSubject: input.snapshot.reviewedClosureSubject }),
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
          ...(input.snapshot.reviewedClosureSubject === "-"
            ? {}
            : { reviewedClosureSubject: input.snapshot.reviewedClosureSubject }),
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
          ...(input.snapshot.reviewedClosureSubject === "-"
            ? {}
            : { reviewedClosureSubject: input.snapshot.reviewedClosureSubject }),
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
      if (input.snapshot.reviewedClosureSubject === "-") {
        throw new Error("Mission approval requires an attested mission");
      }
      this.deps.grantStore.issue({
        effect: "allow",
        capability: input.snapshot.capability,
        resource: input.resource,
        subject: input.snapshot.reviewedClosureSubject,
        constraints: {
          reviewedClosureSubject: input.snapshot.reviewedClosureSubject,
          lineageAtConsent,
        },
        issuedBy: input.caller.subject ? `user:${input.caller.subject.userId}` : "user:system",
        provenance: "acquisition",
        scope: "mission",
        ...capabilityDefinition,
      });
      return;
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

function acquisitionRequestKey(input: {
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
      ...(input.snapshot.reviewedClosureSubject === "-" ? [] : (["mission"] as const)),
      ...(input.snapshot.agentBindingId && input.snapshot.agentScopeEligible
        ? (["agent", "lock"] as const)
        : []),
      "deny",
    ];
  }
  if (input.snapshot.callerPrincipal.startsWith("code:")) {
    return ["version", ...(input.snapshot.taskAuthority ? (["task"] as const) : []), "deny"];
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
  if (allowed.includes("once")) return "once";
  if (allowed.includes("version")) return "version";
  throw new Error("Accepted install review has no compatible authority decision");
}
