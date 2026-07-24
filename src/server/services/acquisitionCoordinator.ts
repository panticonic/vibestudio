import type { AcquisitionInfo, InvocationSnapshot, ResourceScope } from "@vibestudio/rpc";
import { canonicalKey } from "@vibestudio/shared/canonicalKey";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { AuthorityChallengePresentation } from "@vibestudio/shared/serviceDispatcher";
import type { OperationSubstance } from "@vibestudio/shared/approvals";
import type { AuthorityPromptCardType } from "@vibestudio/shared/authority/promptRegistry";
import type { ApprovalQueue, GrantedDecision } from "./approvalQueue.js";
import {
  approvalScopeForAuthorityResource,
  type CapabilityGrantStore,
} from "./capabilityGrantStore.js";
import { createHash } from "node:crypto";
import { authorityRow } from "@vibestudio/shared/authority/authorityRows";
import { testPolicyAuthorityDecision } from "./authorityRuntime.js";

type AuthorityAcquisitionDecision = "once" | "task" | "agent" | "lock" | "version" | "deny";

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
  private readonly cooldowns = new Map<string, { until: number; dismissals: number }>();

  constructor(
    private readonly deps: {
      approvalQueue: ApprovalQueue;
      grantStore: CapabilityGrantStore;
      notifyOwner?: (ownerRuntimeId: string, acquisitionId: string) => Promise<void> | void;
    }
  ) {}

  request(input: AcquisitionRequestInput, signal?: AbortSignal): AcquisitionInfo {
    // Validate the subject/operation decision intersection before publishing a
    // pending card. An unconsumable approval is a protocol error, not a prompt.
    intersectAllowedDecisions(decisionsForOrigin(input), input.presentation?.allowedDecisions);
    const now = Date.now();
    this.pruneTerminalCaches(now);
    const requestKey = acquisitionRequestKey(input);
    const existing = this.byRequestKey.get(requestKey);
    if (existing) {
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
    if (cooldown) this.cooldowns.delete(ruleKey);

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
    };
    this.byRequestKey.set(requestKey, entry);
    this.byId.set(acquisitionId, entry);
    info.pending = true;
    void this.present(entry, input, signal).catch((error) => {
      this.finish(entry, { state: "closed" });
      console.error("[AuthorityAcquisition] approval presentation failed:", error);
    });
    return { ...info };
  }

  async requestAndWait(
    input: AcquisitionRequestInput,
    signal?: AbortSignal
  ): Promise<AcquisitionOutcome> {
    const info = this.request(input, signal);
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
    const decision = presentation?.unitBatch
      ? await this.deps.approvalQueue.request({
          ...requestBase,
          kind: "unit-batch",
          dedupKey: presentation.dedupKey ?? entry.info.acquisitionId,
          trigger: presentation.unitBatch.trigger,
          title: presentation.title,
          description:
            presentation.description ?? `Requests permission to ${input.renderedAction}.`,
          units: [...presentation.unitBatch.units],
          configWrite: presentation.unitBatch.configWrite ?? null,
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
      };
      this.setCooldown(ruleKey, cooldown);
      entry.info.pending = true;
      entry.info.cooldownUntil = cooldown.until;
      this.finish(entry, { state: "closed" });
      return;
    }
    if (!isAuthorityAcquisitionDecision(decision) || !allowedDecisions.includes(decision)) {
      throw new Error(`Authority presentation returned disallowed decision '${decision}'`);
    }
    this.persistDecision(input, decision);
    entry.info.pending = false;
    this.finish(entry, { state: "decided", decision });
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
    void Promise.resolve(
      this.deps.notifyOwner?.(entry.info.ownerRuntimeId, entry.info.acquisitionId)
    ).catch((error) => {
      console.warn(
        `[AuthorityAcquisition] wake hint failed for ${entry.info.ownerRuntimeId}:`,
        error instanceof Error ? error.message : String(error)
      );
    });
  }

  private setCooldown(ruleKey: string, value: { until: number; dismissals: number }): void {
    this.cooldowns.delete(ruleKey);
    this.cooldowns.set(ruleKey, value);
    this.trimOldest(this.cooldowns, AcquisitionCoordinator.MAX_COOLDOWNS);
  }

  private pruneTerminalCaches(now: number): void {
    for (const [acquisitionId, completed] of this.completedById) {
      if (completed.expiresAt <= now) this.completedById.delete(acquisitionId);
    }
    for (const [ruleKey, cooldown] of this.cooldowns) {
      if (cooldown.until <= now) this.cooldowns.delete(ruleKey);
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
  ): void {
    if (decision === "deny") {
      if (input.tier === "critical") return;
      this.deps.grantStore.issue({
        effect: "deny",
        capability: input.snapshot.capability,
        resource: input.resource,
        subject: input.snapshot.callerPrincipal,
        constraints: {
          sessionId: input.snapshot.sessionId,
          ...(input.snapshot.mission === "-" ? {} : { missionSubject: input.snapshot.mission }),
          lineageAtConsent: [],
        },
        issuedBy: input.caller.subject ? `user:${input.caller.subject.userId}` : "user:system",
        provenance: "acquisition",
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
          ...(input.snapshot.mission === "-" ? {} : { missionSubject: input.snapshot.mission }),
          lineageAtConsent,
        },
        issuedBy: input.caller.subject ? `user:${input.caller.subject.userId}` : "user:system",
        provenance: input.tier === "critical" ? "critical-confirmation" : "acquisition",
      });
      return;
    }
    if (decision === "task") {
      if (!input.snapshot.taskRef) {
        throw new Error("Task approval requires an attested task reference");
      }
      this.deps.grantStore.issue({
        effect: "allow",
        capability: input.snapshot.capability,
        resource: input.resource,
        subject: sessionSubject,
        constraints: {
          sessionId: input.snapshot.sessionId,
          taskRef: input.snapshot.taskRef,
          ...(input.snapshot.agentBindingId
            ? { agentBindingId: input.snapshot.agentBindingId }
            : {}),
          ...(input.snapshot.mission === "-" ? {} : { missionSubject: input.snapshot.mission }),
          lineageAtConsent,
        },
        issuedBy: input.caller.subject ? `user:${input.caller.subject.userId}` : "user:system",
        provenance: "acquisition",
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
        scope: "agent",
        lastUsedAt: Date.now(),
        decidedBy: input.caller.subject ? `user:${input.caller.subject.userId}` : "user:system",
        decisionSurface: "card",
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
      constraints: { lineageAtConsent: [] },
      issuedBy: input.caller.subject ? `user:${input.caller.subject.userId}` : "user:system",
      provenance: "acquisition",
    });
  }
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
  return canonicalKey([input.snapshot.capability, input.snapshot.resourceKey]);
}

function cardTypeFor(input: AcquisitionRequestInput): AuthorityPromptCardType {
  if (input.tier === "critical") return "confirm.critical";
  return input.snapshot.contextLineage?.class === "external"
    ? "permission.outside"
    : "permission.gated";
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
      "task",
      ...(input.snapshot.agentBindingId && input.snapshot.agentScopeEligible
        ? (["agent", "lock"] as const)
        : []),
      "deny",
    ];
  }
  if (input.snapshot.callerPrincipal.startsWith("code:")) return ["version", "deny"];
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
  decision: GrantedDecision | "dismiss"
): decision is AuthorityAcquisitionDecision {
  return (
    decision === "once" ||
    decision === "task" ||
    decision === "agent" ||
    decision === "lock" ||
    decision === "version" ||
    decision === "deny"
  );
}
