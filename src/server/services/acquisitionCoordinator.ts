import type { AcquisitionInfo, InvocationSnapshot, ResourceScope } from "@vibestudio/rpc";
import { canonicalKey } from "@vibestudio/shared/canonicalKey";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { AuthorityChallengePresentation } from "@vibestudio/shared/serviceDispatcher";
import type { AuthorityPromptCardType } from "@vibestudio/shared/authority/promptRegistry";
import type { ApprovalQueue, GrantedDecision } from "./approvalQueue.js";
import {
  approvalScopeForAuthorityResource,
  type CapabilityGrantStore,
} from "./capabilityGrantStore.js";
import { createHash } from "node:crypto";

type AuthorityAcquisitionDecision = Exclude<GrantedDecision, "always" | "block">;

export interface AcquisitionRequestInput {
  snapshot: InvocationSnapshot;
  snapshotDigest: string;
  tier: "gated" | "critical";
  caller: VerifiedCaller;
  renderedAction: string;
  resource: ResourceScope;
  presentation?: AuthorityChallengePresentation;
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
    private readonly deps: { approvalQueue: ApprovalQueue; grantStore: CapabilityGrantStore }
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

    const ruleKey = acquisitionRuleKey(input);
    const cooldown = this.cooldowns.get(ruleKey);
    if (cooldown && cooldown.until > now) {
      return {
        acquisitionId: acquisitionIdFor(requestKey),
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
    const acquisitionId = acquisitionIdFor(requestKey);
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
      this.finish(entry, { state: "closed" });
    }
    for (const [acquisitionId, completed] of this.completedById) {
      if (completed.sessionId === sessionId) this.completedById.delete(acquisitionId);
    }
    this.deps.grantStore.pruneSession(sessionId);
  }

  pending(): readonly AcquisitionInfo[] {
    return [...this.byId.values()].map((entry) => ({ ...entry.info, pending: true }));
  }

  /** Consume a once/confirmation grant before its protected effect runs. */
  consume(grantId: string): boolean {
    return this.deps.grantStore.consume(grantId);
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
    const decision = await this.deps.approvalQueue.request({
      kind: "capability",
      callerId: input.caller.runtime.id,
      callerKind: approvalCallerKind(input.caller.runtime.kind),
      repoPath: input.caller.code?.repoPath ?? "vibestudio/session",
      effectiveVersion: input.caller.code?.effectiveVersion ?? input.snapshot.snippetDigest,
      ...(input.caller.subject ? { requestedByUserId: input.caller.subject.userId } : {}),
      requesterCategory: input.caller.agentBinding
        ? "agent"
        : input.snapshot.snippetDigest === "-"
          ? "unknown"
          : "eval",
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
      ...(presentation?.diffReview ? { diffReview: [...presentation.diffReview] } : {}),
      ...(signal ? { signal } : {}),
      snapshot: input.snapshot,
      cardType: entry.info.cardType,
      allowedDecisions: [...allowedDecisions],
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
    const contextLineage = input.snapshot.contextLineage;
    const lineageAtConsent =
      contextLineage?.class === "external" ? [...contextLineage.externalKeys] : [];
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
          ...(input.snapshot.mission === "-" ? {} : { missionSubject: input.snapshot.mission }),
          lineageAtConsent,
        },
        issuedBy: input.caller.subject ? `user:${input.caller.subject.userId}` : "user:system",
        provenance: input.tier === "critical" ? "critical-confirmation" : "acquisition",
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
          ...(input.snapshot.mission === "-" ? {} : { missionSubject: input.snapshot.mission }),
          lineageAtConsent,
        },
        issuedBy: input.caller.subject ? `user:${input.caller.subject.userId}` : "user:system",
        provenance: "acquisition",
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
    return ["once", "session", "deny"];
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
    decision === "once" || decision === "session" || decision === "version" || decision === "deny"
  );
}
