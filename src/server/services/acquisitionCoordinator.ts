import { websiteAuthorityIdentity } from "@vibestudio/shared/serviceDispatcher";
import type {
  AcquisitionInfo,
  AuthorizationContext,
  InvocationSnapshot,
  ResourceScope,
} from "@vibestudio/rpc";
import { canonicalKey } from "@vibestudio/shared/canonicalKey";
import { callerAccountUserId } from "@vibestudio/shared/serviceDispatcher";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { AuthorityChallengePresentation } from "@vibestudio/shared/serviceDispatcher";
import type { ApprovalTargetIdentity, OperationSubstance } from "@vibestudio/shared/approvals";
import {
  AUTHORITY_ACQUISITION_DECISIONS,
  type AuthorityAcquisitionDecision,
} from "@vibestudio/shared/approvalContract";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import { matchingAuthorityGrants } from "@vibestudio/shared/authorization";
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
import type {
  AcquisitionContinuation,
  AcquisitionDeliveryCursor,
  AcquisitionOwner,
  AuthorityAcquisitionRecord,
} from "./authorityAcquisitionStore.js";
import type { JsonValue } from "@vibestudio/shared/wireValues";
import { RemoteRpcError, rpcErrorDataOf, rpcErrorKindOf } from "@vibestudio/rpc";
import {
  acquisitionJson,
  restoreAcquisitionInputs,
  storeAcquisitionInputs,
} from "./acquisitionRequestStorage.js";

export interface AcquisitionRequestInput {
  snapshot: InvocationSnapshot;
  snapshotDigest: string;
  tier: "gated" | "critical";
  caller: VerifiedCaller;
  /** Exact verified context from the denied invocation, retained for grant reconciliation. */
  authorizationContext?: AuthorizationContext;
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

/** Internal failures travel through the existing owner wait as RPC errors. */
type AcquisitionSettlement = AcquisitionOutcome | { state: "failed"; error: unknown };

/**
 * Who issued a grant. `user:<id>` names the account that consented. A decision
 * settled without one is the host's own — infrastructure has no account, and
 * writing `user:system` into the ledger would claim the account namespace for a
 * principal that can never appear in it.
 */
function grantIssuer(caller: Pick<VerifiedCaller, "subject">): string {
  const userId = callerAccountUserId(caller);
  return userId ? `user:${userId}` : "host:approval";
}

/**
 * The account an approval is requested on behalf of, when one is. A request
 * raised by workspace infrastructure belongs to no account, and recording the
 * synthetic system principal as its requester would name an id that can never
 * answer it.
 */
function requestedByAccount(caller: Pick<VerifiedCaller, "subject">): {
  requestedByUserId?: string;
} {
  const userId = callerAccountUserId(caller);
  return userId ? { requestedByUserId: userId } : {};
}

function acquisitionOutcome(settlement: AcquisitionSettlement): AcquisitionOutcome {
  if (settlement.state === "failed") throw settlement.error;
  return settlement;
}

/** Live response ownership; this does not replace the canonical approval outcome. */
interface AcquisitionDelivery {
  ownerRedrive: boolean;
  notifying?: boolean;
  waiters: Set<(settlement: AcquisitionSettlement) => void>;
  settlement?: AcquisitionSettlement;
  observed: boolean;
}

interface AwaitableAcquisition {
  sessionId: string;
  info: AcquisitionInfo;
  delivery: AcquisitionDelivery;
}

interface PendingAcquisition extends AwaitableAcquisition {
  presentationLifetime: AbortController;
  presentation?: Promise<void>;
  requestKey: string;
  bindingDigest: string;
  sessionId: string;
  agentBindingId: string | null;
  /** The scope the request was made against, kept for the waiting-list projection. */
  resource: ResourceScope;
  inputs: readonly AcquisitionRequestInput[];
  /** When the request began waiting, so a reviewer can see what has been stuck. */
  requestedAt: number;
  targetRequestId?: string;
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

interface StoredInvocationAcquisition {
  kind: "invocation";
  inputs: JsonValue;
  sourceDelta?: {
    grants: import("@vibestudio/rpc").AuthorityGrant[];
    lineage: string[];
    newSources: string[];
  };
}

interface StoredTargetAcquisition {
  kind: "target-join";
  targetRequestId: string;
  inputs: JsonValue;
}
type StoredAcquisition = StoredInvocationAcquisition | StoredTargetAcquisition;

/** Grants and invocation acquisitions are canonical; these maps own live presentation/observation. */
export class AcquisitionCoordinator {
  private static readonly DISMISS_COOLDOWN_MS = 10 * 60 * 1_000;
  private static readonly FATIGUE_MEMORY_MS = 24 * 60 * 60 * 1_000;
  private static readonly MAX_COOLDOWNS = 512;
  private readonly byRequestKey = new Map<string, PendingAcquisition>();
  private readonly byId = new Map<string, PendingAcquisition>();
  private readonly cooldowns = new Map<
    string,
    { until: number; dismissals: number; lastDismissedAt: number }
  >();
  private readonly presentingTargetRequests = new Map<string, { callerId: string }>();
  private readonly presentationLifetime = new AbortController();
  private readonly presentations = new Set<Promise<void>>();
  private readonly closingPresentations = new Map<PendingAcquisition, Promise<void>>();
  private readonly ownerDeliveryLifetime = new AbortController();
  private readonly ownerDeliveries = new Map<string, Promise<void>>();
  private ownerDeliveryRecovery: Promise<void> | undefined;
  constructor(
    private readonly deps: {
      approvalQueue: ApprovalQueue;
      grantStore: CapabilityGrantStore;
      notifyOwner?: (
        ownerRuntimeId: string,
        acquisitionId: string,
        signal: AbortSignal
      ) => Promise<void> | void;
      resolveTaskTitle?: (taskSubject: string, signal: AbortSignal) => Promise<string | null>;
      expandLineageKeys?: (keys: readonly string[]) => readonly string[];
    }
  ) {}

  /** Reproject canonical pending asks after host startup; never infer a decision from grants. */
  resumePending(): void {
    let after: { createdAt: number; acquisitionId: string } | undefined;
    for (;;) {
      const records = this.deps.grantStore.acquisitions.scan({ pendingOnly: true, after });
      if (records.length === 0) return;
      for (const record of records) {
        if (!this.byId.has(record.acquisitionId))
          this.startInvocation(record, record.deliveryOwner);
      }
      const last = records[records.length - 1]!;
      after = { createdAt: last.createdAt, acquisitionId: last.acquisitionId };
    }
  }

  /** Routing readiness and replacement events reproject debt until its exact receipt is acknowledged. */
  reprojectOwnerDelivery(): Promise<void> {
    if (this.ownerDeliveryRecovery) return this.ownerDeliveryRecovery;
    const recovery = this.reprojectCanonicalOwnerDelivery();
    this.ownerDeliveryRecovery = recovery;
    const release = () => {
      if (this.ownerDeliveryRecovery === recovery) this.ownerDeliveryRecovery = undefined;
    };
    void recovery.then(release, release);
    return recovery;
  }

  private async reprojectCanonicalOwnerDelivery(): Promise<void> {
    let after: AcquisitionDeliveryCursor | undefined;
    let failureCount = 0;
    let firstFailure: unknown;
    for (;;) {
      this.ownerDeliveryLifetime.signal.throwIfAborted();
      const records = this.deps.grantStore.acquisitions.scanOutstandingTerminal(after);
      if (records.length === 0) break;
      for (const record of records) {
        this.ownerDeliveryLifetime.signal.throwIfAborted();
        try {
          await this.deliverOwner(record.admission.ownerRuntimeId, record.acquisitionId);
        } catch (error) {
          this.ownerDeliveryLifetime.signal.throwIfAborted();
          if (failureCount === 0) firstFailure = error;
          failureCount++;
          console.warn(
            `[AuthorityAcquisition] delivery recovery failed for ${record.admission.ownerRuntimeId}:`,
            error
          );
        }
      }
      const last = records.at(-1)!;
      after = {
        ownerRuntimeId: last.admission.ownerRuntimeId,
        sessionId: last.admission.sessionId,
        createdAt: last.createdAt,
        acquisitionId: last.acquisitionId,
      };
    }
    if (failureCount > 0)
      throw new AggregateError(
        [firstFailure],
        `Acquisition owner delivery recovery failed for ${failureCount} receipt(s)`,
        { cause: firstFailure }
      );
  }

  /** Shutdown cancels and joins transport delivery; canonical asks and receipts remain durable. */
  async quiesceOwnerDelivery(): Promise<void> {
    this.ownerDeliveryLifetime.abort(new Error("Acquisition owner delivery stopped"));
    await Promise.allSettled([
      ...this.ownerDeliveries.values(),
      ...(this.ownerDeliveryRecovery ? [this.ownerDeliveryRecovery] : []),
    ]);
  }

  private trackPresentation(presentation: Promise<void>): void {
    this.presentations.add(presentation);
    void presentation.then(
      () => this.presentations.delete(presentation),
      () => this.presentations.delete(presentation)
    );
  }

  /** Join complete presentation continuations, including canonical settlement and release. */
  async joinPresentations(): Promise<void> {
    while (this.presentations.size > 0) await Promise.allSettled([...this.presentations]);
  }

  /** Host shutdown withdraws transport waiters without deciding durable asks. */
  async quiescePresentations(): Promise<void> {
    this.presentationLifetime.abort(new Error("Authority presentation stopped"));
    for (const entry of this.byId.values()) this.cancelPresentation(entry);
    for (const callerId of new Set(
      [...this.presentingTargetRequests.values()].map((owner) => owner.callerId)
    ))
      this.deps.approvalQueue.cancelForCaller(callerId);
    await this.joinPresentations();
    for (const entry of this.byId.values()) {
      entry.delivery.ownerRedrive = false;
      this.settleAcquisition(entry, {
        state: "failed",
        error: this.presentationLifetime.signal.reason,
      });
    }
    this.byId.clear();
    this.byRequestKey.clear();
  }

  private deliverOwner(ownerRuntimeId: string, acquisitionId: string): Promise<void> {
    const existing = this.ownerDeliveries.get(acquisitionId);
    if (existing) return existing;
    const delivery = Promise.resolve().then(async () => {
      this.ownerDeliveryLifetime.signal.throwIfAborted();
      if (!this.deps.notifyOwner) throw new Error("Acquisition owner delivery is not configured");
      await this.deps.notifyOwner(ownerRuntimeId, acquisitionId, this.ownerDeliveryLifetime.signal);
    });
    this.ownerDeliveries.set(acquisitionId, delivery);
    const release = () => {
      if (this.ownerDeliveries.get(acquisitionId) === delivery)
        this.ownerDeliveries.delete(acquisitionId);
    };
    void delivery.then(release, release);
    return delivery;
  }

  private startInvocation(
    record: AuthorityAcquisitionRecord,
    continuation: AcquisitionContinuation,
    signal?: AbortSignal
  ): AcquisitionInfo {
    this.presentationLifetime.signal.throwIfAborted();
    if (continuation === "owner-redrive")
      this.deps.grantStore.acquisitions.setDeliveryOwner(
        record.acquisitionId,
        record.admission,
        continuation
      );
    const facts = record.admission.facts as unknown as StoredAcquisition;
    const inputs = restoreInvocationInputs(record);
    const input = validateAcquisitionGroup(inputs);
    const info = invocationAcquisitionInfo(record, inputs);
    const attention =
      info.tier === "critical" ||
      ![...this.byId.values()].some((pending) => pending.info.tier === "gated")
        ? "interrupt"
        : "queue";
    const entry: PendingAcquisition = {
      presentationLifetime: new AbortController(),
      requestKey: record.admission.requestKey,
      bindingDigest: record.bindingDigest,
      info,
      sessionId: record.admission.sessionId,
      agentBindingId: input.snapshot.agentBindingId ?? null,
      resource: input.resource,
      inputs,
      requestedAt: record.createdAt,
      delivery: acquisitionDelivery(
        continuation === "owner-redrive" ? continuation : record.deliveryOwner
      ),
      ...(facts.kind === "target-join" ? { targetRequestId: facts.targetRequestId } : {}),
    };
    this.byRequestKey.set(entry.requestKey, entry);
    this.byId.set(record.acquisitionId, entry);
    if (facts.kind === "target-join") {
      entry.presentation = this.presentTargetJoin(entry, facts.targetRequestId).catch((error) => {
        if (this.presentationLifetime.signal.aborted) return;
        this.targetPresentationFailed(facts.targetRequestId, error);
        console.error("[AuthorityAcquisition] target join projection failed:", error);
      });
      this.trackPresentation(entry.presentation);
      return { ...entry.info };
    }
    const presentationSignal = signal
      ? AbortSignal.any([signal, entry.presentationLifetime.signal])
      : entry.presentationLifetime.signal;
    const presentation = facts.sourceDelta
      ? this.presentSourceDelta(entry, facts.sourceDelta, presentationSignal)
      : this.present(entry, inputs, attention, presentationSignal);
    entry.presentation = presentation.catch((error) => this.presentationFailed(entry, error));
    this.trackPresentation(entry.presentation);
    return { ...info };
  }

  private async presentTargetJoin(entry: PendingAcquisition, requestId: string): Promise<void> {
    const store = this.requireTargetRequests();
    const target = store.get(requestId);
    const input = entry.inputs[0]!;
    const subject =
      input.snapshot.missionSubject !== "-"
        ? input.snapshot.missionSubject
        : input.snapshot.taskAuthority;
    if (
      !target ||
      entry.inputs.length !== 1 ||
      target.targetSubject !== subject ||
      target.capability !== input.snapshot.capability ||
      target.capabilityDefinitionDigest !== input.snapshot.capabilityDefinitionDigest ||
      canonicalJson(target.resource) !== canonicalJson(input.resource)
    )
      throw new Error("Stored target acquisition disagrees with its standing request");
    store.reconcile(requestId);
    const retained = this.deps.grantStore.acquisitions.get(entry.info.acquisitionId, {
      ownerRuntimeId: entry.info.ownerRuntimeId,
      sessionId: entry.sessionId,
    })!;
    if (retained.state !== "pending")
      this.releaseInvocation(entry, retained, invocationAcquisitionSettlement(retained));
    else this.presentTargetRequest(target, target.review.action);
  }

  private presentationFailed(entry: PendingAcquisition, error: unknown): void {
    if (this.presentationLifetime.signal.aborted) return;
    try {
      this.finish(entry, { state: "failed", error });
    } catch (storageError) {
      // The canonical request remains pending when its failure cannot commit.
      // Release no owned entry and propagate both failures to current observers.
      this.settleAcquisition(entry, {
        state: "failed",
        error: new AggregateError(
          [error, storageError],
          "Authority failure could not be committed",
          { cause: error }
        ),
      });
    }
    console.error("[AuthorityAcquisition] approval presentation failed:", error);
  }

  private async taskTitleFor(
    taskSubject: string,
    signal: AbortSignal = this.presentationLifetime.signal
  ): Promise<string | undefined> {
    signal.throwIfAborted();
    if (!this.deps.resolveTaskTitle || !taskSubject.startsWith("task:")) return undefined;
    try {
      const title = (await this.deps.resolveTaskTitle(taskSubject, signal))?.trim();
      signal.throwIfAborted();
      return title ? title.slice(0, 120) : undefined;
    } catch (error) {
      signal.throwIfAborted();
      console.warn(`[AuthorityAcquisition] could not resolve title for ${taskSubject}:`, error);
      return undefined;
    }
  }

  private async invocationTaskTitle(
    entry: PendingAcquisition,
    taskSubject: string,
    signal: AbortSignal
  ): Promise<{ title?: string } | null> {
    try {
      const title = await this.taskTitleFor(taskSubject, signal);
      return title ? { title } : {};
    } catch (error) {
      if (this.presentationLifetime.signal.aborted) return null;
      if (!signal.aborted) throw error;
      if (this.byId.get(entry.info.acquisitionId) === entry)
        this.finish(entry, { state: "closed" });
      return null;
    }
  }

  private expandSourceLineage(lineage: readonly string[]): string[] {
    const keys = lineage
      .filter((item) => item.startsWith("source:"))
      .map((item) => item.slice("source:".length));
    try {
      return [...new Set(this.deps.expandLineageKeys?.(keys) ?? keys)].sort();
    } catch (error) {
      console.warn("[AuthorityAcquisition] could not expand outside-content lineage:", error);
      return keys.filter((key) => !key.startsWith("lineage-set:")).sort();
    }
  }

  private sourceDeltaKeys(
    grants: readonly import("@vibestudio/rpc").AuthorityGrant[],
    lineage: readonly string[]
  ): string[] {
    const currentSources = this.expandSourceLineage(lineage);
    return currentSources.filter((source) =>
      grants.some(
        (grant) =>
          !this.expandSourceLineage(grant.constraints?.lineageAtConsent ?? []).includes(source)
      )
    );
  }

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
    this.presentationLifetime.signal.throwIfAborted();
    const store = this.requireTargetRequests();
    const durable = store.ensure(input);
    if (durable.state === "pending") this.presentTargetRequest(durable, input.renderedAction);
    return durable;
  }

  requestTaskRulesForTarget(
    inputs: readonly Parameters<AcquisitionCoordinator["requestForTarget"]>[0][]
  ): DurableTargetAuthorityRequest[] {
    this.presentationLifetime.signal.throwIfAborted();
    const first = inputs[0];
    if (!first) return [];
    if (
      inputs.some(
        (input) =>
          input.targetSubject !== first.targetSubject ||
          input.authorityPlanDigest !== first.authorityPlanDigest ||
          input.tier === "critical"
      )
    ) {
      throw new Error("A task rules card requires one target, one plan, and no critical rows");
    }
    const requests = this.deps.grantStore.transaction(() =>
      inputs.map((input) => this.requireTargetRequests().ensure(input))
    );
    this.trackPresentation(
      this.presentTaskRuleRequests(
        requests.filter((request) => request.state === "pending"),
        first.sourceUser,
        first.authorityPlanDigest
      ).catch((error) => {
        if (!this.presentationLifetime.signal.aborted)
          console.error("[AuthorityAcquisition] task rules presentation failed:", error);
      })
    );
    return requests;
  }

  private async presentTaskRuleRequests(
    candidates: readonly DurableTargetAuthorityRequest[],
    sourceUser: `user:${string}`,
    authorityPlanDigest: string
  ): Promise<void> {
    const taskTitle =
      this.deps.resolveTaskTitle && candidates[0]
        ? await this.taskTitleFor(candidates[0].targetSubject)
        : undefined;
    // Preparation may yield. Only claim prompts for requests that are still
    // pending and have no presenter when preparation finishes.
    this.presentationLifetime.signal.throwIfAborted();
    const requests = candidates.filter(
      (request) =>
        this.requireTargetRequests().get(request.requestId)?.state === "pending" &&
        !this.presentingTargetRequests.has(request.requestId)
    );
    const first = requests[0];
    if (!first) return;
    const groupKey = createHash("sha256")
      .update(
        canonicalJson([
          first.targetSubject,
          authorityPlanDigest,
          requests.map((request) => request.requestId).sort(),
        ])
      )
      .digest("hex");
    const requestWithHandle = this.deps.approvalQueue.requestWithHandle;
    if (!requestWithHandle) {
      const error = new Error("Task rules require typed approval resolution support");
      for (const request of requests) this.targetPresentationFailed(request.requestId, error);
      throw error;
    }
    const presentationOwner = { callerId: targetRequestCallerId(groupKey) };
    for (const request of requests)
      this.presentingTargetRequests.set(request.requestId, presentationOwner);
    const releasePresentation = () => {
      for (const request of requests)
        if (this.presentingTargetRequests.get(request.requestId) === presentationOwner)
          this.presentingTargetRequests.delete(request.requestId);
    };
    const taskName = taskTitle ? `“${taskTitle}”` : "this task";
    const singleRule = requests.length === 1 ? requests[0] : undefined;
    const handle = (() => {
      try {
        return requestWithHandle.call(this.deps.approvalQueue, {
          kind: "capability",
          callerId: targetRequestCallerId(groupKey),
          signal: this.presentationLifetime.signal,
          callerKind: "system",
          repoPath: "vibestudio/authority",
          effectiveVersion: authorityPlanDigest,
          attention: "interrupt",
          operationId: `preflight:${groupKey}`,
          taskSubject: first.targetSubject,
          ...(taskTitle ? { taskTitle } : {}),
          securityIdentity: groupKey,
          semanticFamily: "task.rules",
          sourcesShown: [],
          repeatReason: "none",
          requestedByUserId: sourceUser.slice("user:".length),
          requesterCategory: "agent",
          dedupKey: `task-rules:${groupKey}`,
          capability: first.capability,
          title: singleRule
            ? `Allow ${taskName} to ${singleRule.review.action}?`
            : `Allow these planned actions for ${taskName}?`,
          description: singleRule
            ? "This action is part of the task's current plan. Allowing it now avoids an interruption when it is needed."
            : "These actions are part of the task's current plan. Choose the ones it may use without interrupting you later.",
          resource: { type: "chat", label: "Chat", value: first.targetSubject },
          grantResourceKey: first.targetSubject,
          operation: {
            kind: "unknown",
            verb: "allow planned actions",
            object: { type: "chat", label: "Chat", value: first.targetSubject },
          },
          cardType: "task.rules",
          allowedDecisions: ["task", "deny"],
          authorityRow: targetRequestAuthorityRow(first),
          authorityFacets: requests.map((request) => ({
            selectionKey: request.requestId,
            defaultSelected: true,
            capability: request.capability,
            title: request.review.action,
            resource: {
              type: request.resource.kind,
              label: "Where",
              value:
                request.resource.kind === "exact"
                  ? request.resource.key
                  : canonicalJson(request.resource),
            },
            row: targetRequestAuthorityRow(request),
          })),
        });
      } catch (error) {
        releasePresentation();
        for (const request of requests) this.targetPresentationFailed(request.requestId, error);
        throw error;
      }
    })();
    await handle.resolution
      .then(({ decision, selectedAuthorityFacetKeys, resolver }) => {
        if (this.presentationLifetime.signal.aborted) return;
        const selected = new Set(selectedAuthorityFacetKeys ?? []);
        const settled = this.deps.grantStore.transaction(() =>
          requests.map((request) =>
            decision === "task" && selected.has(request.requestId)
              ? this.requireTargetRequests().settle(request.requestId, "granted", () =>
                  this.persistTargetDecision(
                    request,
                    "allow",
                    resolver ? `user:${resolver.subject.userId}` : sourceUser
                  )
                )
              : this.requireTargetRequests().settle(request.requestId, "cancelled")
          )
        );
        for (const request of settled)
          this.settleTargetJoiners(request.requestId, targetOutcome(request));
      })
      .catch((error) => {
        releasePresentation();
        if (this.presentationLifetime.signal.aborted) return;
        for (const request of requests) this.targetPresentationFailed(request.requestId, error);
        console.error("[AuthorityAcquisition] task rules presentation failed:", error);
      })
      .finally(releasePresentation);
  }

  resumeTargetRequests(): void {
    for (const request of this.requireTargetRequests().pending()) {
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
    const callers = new Set(
      pending.map(
        (request) =>
          this.presentingTargetRequests.get(request.requestId)?.callerId ??
          targetRequestCallerId(request.requestId)
      )
    );
    const retired = store.retireSubject(subject);
    for (const caller of callers) this.deps.approvalQueue.cancelForCaller(caller);
    for (const request of pending) this.settleTargetJoiners(request.requestId, { state: "closed" });
    return retired;
  }

  private requireTargetRequests(): TargetAuthorityRequestStore {
    return this.deps.grantStore.targetRequests;
  }

  private presentTargetRequest(
    request: DurableTargetAuthorityRequest,
    renderedAction: string
  ): void {
    this.presentationLifetime.signal.throwIfAborted();
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
    const presentationOwner = { callerId };
    this.presentingTargetRequests.set(request.requestId, presentationOwner);
    const releasePresentation = () => {
      if (this.presentingTargetRequests.get(request.requestId) === presentationOwner)
        this.presentingTargetRequests.delete(request.requestId);
    };
    const presentation: CapabilityApprovalQueueRequest = {
      kind: "capability",
      callerId,
      signal: this.presentationLifetime.signal,
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
    let resolution: Promise<ApprovalQueueResolution<AuthorityApprovalQueueDecision>>;
    try {
      resolution = this.deps.approvalQueue.requestWithHandle
        ? this.deps.approvalQueue.requestWithHandle(presentation).resolution
        : this.deps.approvalQueue.request(presentation).then((decision) => ({ decision }));
    } catch (error) {
      releasePresentation();
      throw error;
    }
    this.trackPresentation(
      resolution
        .then(({ decision, resolver }) => {
          if (this.presentationLifetime.signal.aborted) return;
          const store = this.requireTargetRequests();
          let settled: DurableTargetAuthorityRequest;
          if (decision === expectedDecision) {
            settled = store.settle(request.requestId, "granted", () =>
              this.persistTargetDecision(
                request,
                "allow",
                resolver ? `user:${resolver.subject.userId}` : request.sourceUser
              )
            );
          } else if (decision === "deny") {
            settled = store.settle(request.requestId, "denied", () =>
              this.persistTargetDecision(
                request,
                "deny",
                resolver ? `user:${resolver.subject.userId}` : request.sourceUser
              )
            );
          } else {
            settled = store.settle(request.requestId, "cancelled");
          }
          this.settleTargetJoiners(request.requestId, targetOutcome(settled));
        })
        .catch((error) => {
          releasePresentation();
          if (this.presentationLifetime.signal.aborted) return;
          this.targetPresentationFailed(request.requestId, error);
          console.error("[AuthorityAcquisition] target request presentation failed:", error);
        })
        .finally(releasePresentation)
    );
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
    if (input.tier !== "gated") return null;
    const targetSubject =
      input.snapshot.missionSubject !== "-"
        ? input.snapshot.missionSubject
        : (input.snapshot.taskAuthority ?? null);
    if (!targetSubject) return null;
    return this.requireTargetRequests().pendingForInvocation({
      targetSubject,
      capability: input.snapshot.capability,
      capabilityDefinitionDigest: input.snapshot.capabilityDefinitionDigest,
      resource: input.resource,
    });
  }

  private joinTargetRequest(
    request: DurableTargetAuthorityRequest,
    input: AcquisitionRequestInput,
    continuation: AcquisitionContinuation
  ): AcquisitionInfo {
    const owner = { ownerRuntimeId: input.caller.runtime.id, sessionId: input.snapshot.sessionId };
    const requestKey = targetJoinRequestKey(
      request.requestId,
      owner.ownerRuntimeId,
      owner.sessionId,
      input.snapshot.causalParent
    );
    const retained = this.deps.grantStore.acquisitions.current(requestKey, owner);
    if (retained && continuation === "owner-redrive")
      this.deps.grantStore.acquisitions.setDeliveryOwner(
        retained.acquisitionId,
        owner,
        continuation
      );
    const record =
      retained ??
      this.deps.grantStore.acquisitions.admit(
        {
          ...owner,
          requestKey,
          facts: acquisitionJson({
            kind: "target-join",
            targetRequestId: request.requestId,
            inputs: storeAcquisitionInputs([input]),
          }),
        },
        Date.now(),
        continuation
      );
    const existing = this.byId.get(record.acquisitionId);
    if (existing) {
      if (continuation === "owner-redrive") {
        existing.delivery.ownerRedrive = true;
        existing.delivery.observed = false;
        this.deps.grantStore.acquisitions.setDeliveryOwner(
          existing.info.acquisitionId,
          { ownerRuntimeId: existing.info.ownerRuntimeId, sessionId: existing.sessionId },
          continuation
        );
      }
      return { ...existing.info };
    }
    if (record.state !== "pending")
      return invocationAcquisitionInfo(record, restoreInvocationInputs(record));
    return this.startInvocation(record, continuation);
  }

  private targetPresentationFailed(requestId: string, error: unknown): void {
    try {
      this.settleTargetJoiners(requestId, { state: "failed", error });
    } catch (storageError) {
      for (const entry of this.byId.values()) {
        if (entry.targetRequestId !== requestId) continue;
        this.settleAcquisition(entry, {
          state: "failed",
          error: new AggregateError(
            [error, storageError],
            "Target acquisition failure could not be committed",
            { cause: error }
          ),
        });
      }
    }
  }

  private settleTargetJoiners(requestId: string, outcome: AcquisitionSettlement): void {
    if (outcome.state === "failed")
      this.deps.grantStore.acquisitions.resolveTarget(
        requestId,
        acquisitionJson({
          kind: "target-presentation-failed",
          error: storeAcquisitionSettlement(outcome),
        }),
        { state: "failed", value: storeAcquisitionSettlement(outcome) }
      );
    for (const entry of [...this.byId.values()]) {
      if (entry.targetRequestId !== requestId) continue;
      const record = this.deps.grantStore.acquisitions.get(entry.info.acquisitionId, {
        ownerRuntimeId: entry.info.ownerRuntimeId,
        sessionId: entry.sessionId,
      })!;
      if (record.state === "pending")
        throw new Error("Target decision did not settle its acquisition");
      this.releaseInvocation(
        entry,
        record,
        record.state === "failed" && outcome.state === "failed"
          ? outcome
          : invocationAcquisitionSettlement(record)
      );
    }
  }

  request(input: AcquisitionRequestInput, signal?: AbortSignal): AcquisitionInfo {
    return this.requestWithContinuation([input], "owner-redrive", signal);
  }

  requestMany(inputs: readonly AcquisitionRequestInput[], signal?: AbortSignal): AcquisitionInfo {
    return this.requestWithContinuation(inputs, "owner-redrive", signal);
  }

  private requestWithContinuation(
    inputs: readonly AcquisitionRequestInput[],
    continuation: AcquisitionContinuation,
    signal?: AbortSignal
  ): AcquisitionInfo {
    this.presentationLifetime.signal.throwIfAborted();
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
      // A returned acquisition requires owner delivery unless a live observer
      // receives its outcome. Joining an in-band call registers that observer
      // in awaitDecision, rather than permanently disabling the owner.
      if (continuation === "owner-redrive") {
        existing.delivery.ownerRedrive = true;
        existing.delivery.observed = false;
        this.deps.grantStore.acquisitions.setDeliveryOwner(
          existing.info.acquisitionId,
          { ownerRuntimeId: existing.info.ownerRuntimeId, sessionId: existing.sessionId },
          continuation
        );
      }
      return { ...existing.info, pending: true };
    }
    const owner = { ownerRuntimeId: input.caller.runtime.id, sessionId: input.snapshot.sessionId };
    const retained = this.deps.grantStore.acquisitions.current(requestKey, owner);
    if (retained && continuation === "owner-redrive")
      this.deps.grantStore.acquisitions.setDeliveryOwner(
        retained.acquisitionId,
        owner,
        continuation
      );
    if (retained) {
      const retainedInputs = restoreInvocationInputs(retained);
      const info = invocationAcquisitionInfo(retained, retainedInputs);
      if (retained.state === "pending")
        return this.startInvocation(
          retained,
          continuation,
          combineAcquisitionSignals(signal, inputs)
        );
      // A new attempt after the existing dismissal policy's cooldown starts a
      // fresh cycle, retaining the closed receipt. Time alone never deletes it.
      if (!info.cooldownUntil || info.cooldownUntil > now) return info;
      this.deps.grantStore.acquisitions.supersede(requestKey, owner);
    }
    const acquisitionId = acquisitionIdFor(requestKey);

    const sourceDelta = this.sourceDeltaFor(input);
    if (sourceDelta) {
      return this.requestSourceDelta(
        input,
        sourceDelta.grants,
        sourceDelta.lineage,
        sourceDelta.newSources,
        continuation
      );
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
        this.deps.grantStore.transaction(() => {
          inputs.forEach((facet, index) => {
            const rule = rules[index]!;
            const taskSubject = rule.decision === "task" ? facet.snapshot.taskAuthority : null;
            if (rule.decision === "task" && (!taskSubject || facet.tier === "critical")) {
              throw testPolicyIntegrityError(
                "ETESTPOLICYMISMATCH",
                "Task-scoped test authority requires a gated invocation with attested task authority",
                facet
              );
            }
            this.deps.grantStore.issue({
              effect: rule.decision === "deny" ? "deny" : "allow",
              capability: facet.snapshot.capability,
              resource: facet.resource,
              // Test policy may be inherited by reviewed infrastructure code without
              // changing its authorizing origin into a session. Mint the invocation
              // grant to the exact principal the immutable snapshot evaluated; keep
              // the execution/session identity as a constraint, never as a substitute
              // principal.
              subject: taskSubject ?? facet.snapshot.callerPrincipal,
              constraints:
                rule.decision === "task"
                  ? {
                      lineageAtConsent: [...(facet.snapshot.lineageClasses ?? ["none"])],
                    }
                  : {
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
              scope: rule.decision === "task" ? "task" : "once",
            });
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
    const record = this.deps.grantStore.acquisitions.admit(
      {
        requestKey,
        ...owner,
        facts: acquisitionJson({ kind: "invocation", inputs: storeAcquisitionInputs(inputs) }),
      },
      now,
      continuation
    );
    return this.startInvocation(record, continuation, combineAcquisitionSignals(signal, inputs));
  }

  private sourceDeltaFor(input: AcquisitionRequestInput): {
    grants: import("@vibestudio/rpc").AuthorityGrant[];
    lineage: string[];
    newSources: string[];
  } | null {
    const subject = input.snapshot.taskAuthority;
    const lineage = [...(input.snapshot.lineageClasses ?? [])];
    if (!subject || !lineage.some((entry) => entry.startsWith("source:"))) return null;
    const candidates = this.deps.grantStore
      .listActiveAuthorityGrants()
      .filter(
        (grant) => grant.subject === subject && grant.effect === "allow" && grant.scope === "task"
      );
    const exactSources = this.expandSourceLineage(lineage);
    const affectedFacetKeys = new Set(
      candidates
        .filter((grant) => {
          const consentSources = this.expandSourceLineage(
            grant.constraints?.lineageAtConsent ?? []
          );
          return exactSources.length > 0
            ? exactSources.some((source) => !consentSources.includes(source))
            : lineage.some((entry) => !(grant.constraints?.lineageAtConsent ?? []).includes(entry));
        })
        .map((grant) => canonicalKey([grant.capability, resourceKeyOfScope(grant.resource)]))
    );
    const grants = candidates.filter((grant) =>
      affectedFacetKeys.has(canonicalKey([grant.capability, resourceKeyOfScope(grant.resource)]))
    );
    return grants.length > 0
      ? { grants, lineage, newSources: this.sourceDeltaKeys(grants, lineage) }
      : null;
  }

  private requestSourceDelta(
    input: AcquisitionRequestInput,
    grants: readonly import("@vibestudio/rpc").AuthorityGrant[],
    lineage: readonly string[],
    newSources: readonly string[],
    continuation: AcquisitionContinuation
  ): AcquisitionInfo {
    const requestKey = sourceDeltaRequestKey(input, grants, lineage);
    const existing = this.byRequestKey.get(requestKey);
    if (existing) {
      if (continuation === "owner-redrive") {
        existing.delivery.ownerRedrive = true;
        existing.delivery.observed = false;
        this.deps.grantStore.acquisitions.setDeliveryOwner(
          existing.info.acquisitionId,
          { ownerRuntimeId: existing.info.ownerRuntimeId, sessionId: existing.sessionId },
          continuation
        );
      }
      return { ...existing.info, pending: true };
    }
    const owner = { ownerRuntimeId: input.caller.runtime.id, sessionId: input.snapshot.sessionId };
    const retained = this.deps.grantStore.acquisitions.current(requestKey, owner);
    if (retained && continuation === "owner-redrive")
      this.deps.grantStore.acquisitions.setDeliveryOwner(
        retained.acquisitionId,
        owner,
        continuation
      );
    if (retained)
      return retained.state === "pending"
        ? this.startInvocation(
            retained,
            continuation,
            combineAcquisitionSignals(undefined, [input])
          )
        : invocationAcquisitionInfo(retained, restoreInvocationInputs(retained));
    const record = this.deps.grantStore.acquisitions.admit(
      {
        requestKey,
        ...owner,
        facts: acquisitionJson({
          kind: "invocation",
          inputs: storeAcquisitionInputs([input]),
          sourceDelta: { grants, lineage, newSources },
        }),
      },
      Date.now(),
      continuation
    );
    return this.startInvocation(
      record,
      continuation,
      combineAcquisitionSignals(undefined, [input])
    );
  }

  private async presentSourceDelta(
    entry: PendingAcquisition,
    sourceDelta: NonNullable<StoredInvocationAcquisition["sourceDelta"]>,
    invocationSignal?: AbortSignal
  ): Promise<void> {
    const input = validateAcquisitionGroup(entry.inputs);
    const { grants, lineage, newSources } = sourceDelta;
    const { currentGrant, facets } = sourceDeltaFacets(input, grants);
    const acquisitionId = entry.info.acquisitionId;
    const requestKey = entry.requestKey;
    const signal = combineAcquisitionSignals(invocationSignal, entry.inputs, [
      this.presentationLifetime.signal,
      ...entry.inputs.flatMap((facet) =>
        facet.snapshot.subjectBinding?.documentId
          ? [this.deps.grantStore.subjectExecutionSignal(facet.snapshot.subjectBinding)]
          : []
      ),
    ]);
    const requestWithHandle = this.deps.approvalQueue.requestWithHandle;
    if (!requestWithHandle)
      throw new Error("Source deltas require typed approval resolution support");
    const taskSubject =
      input.snapshot.taskAuthority ?? input.snapshot.taskRef ?? input.snapshot.sessionId;
    const sourceSummary = outsideSourceSummary(newSources);
    const preparation = this.deps.resolveTaskTitle
      ? await this.invocationTaskTitle(entry, taskSubject, signal!)
      : {};
    if (!preparation) return;
    const taskTitle = preparation.title;
    const resolution = await (async () => {
      const taskName = taskTitle ? `“${taskTitle}”` : "this task";
      const currentFacet = facets.find(
        (facet) =>
          facet.capability === input.snapshot.capability &&
          resourceKeyOfScope(facet.resource) === input.snapshot.resourceKey
      );
      const currentRow = currentFacet ? authorityRowForAcquisition(input) : facets[0]?.row;
      const handle = requestWithHandle.call(this.deps.approvalQueue, {
        kind: "capability",
        callerId: input.caller.runtime.id,
        callerKind: approvalCallerKind(input.caller.runtime.kind),
        repoPath: input.caller.code?.repoPath ?? "vibestudio/session",
        effectiveVersion: input.caller.code?.effectiveVersion ?? input.snapshot.snippetDigest,
        attention: "interrupt",
        operationId: acquisitionId,
        ...(signal ? { signal } : {}),
        taskSubject,
        ...(taskTitle ? { taskTitle } : {}),
        securityIdentity: requestKey,
        semanticFamily: "task.rules",
        sourcesShown: [...newSources],
        repeatReason: "new-source",
        ...requestedByAccount(input.caller),
        requesterCategory: "agent",
        dedupKey: requestKey,
        capability: input.snapshot.capability,
        title: `Allow ${taskName} to use content from ${sourceSummary}?`,
        description:
          !currentGrant && currentRow
            ? `${taskName} is waiting to ${currentRow.action}. That action has not been allowed for this task yet; the other listed actions were allowed before it read content from ${sourceSummary}.`
            : facets.length === 1 && currentRow
              ? `${taskName} is waiting to ${currentRow.action}. That action was allowed before it read this outside content.`
              : `${taskName} has read content from ${sourceSummary} since these actions were allowed. Choose which actions may use it.`,
        resource: {
          type: "outside-source",
          label: "New outside content",
          value: sourceSummary,
        },
        grantResourceKey: newSources.join("\n") || "outside-content",
        operation: {
          kind: "unknown",
          verb: "use new outside content",
          object: {
            type: "outside-source",
            label: "New outside content",
            value: sourceSummary,
          },
        },
        cardType: "task.rules",
        allowedDecisions: ["task", "deny"],
        authorityRow: currentGrant
          ? authorityRowForAcquisition(input)
          : (facets[0]?.row ?? authorityRowForAcquisition(input)),
        authorityFacets: facets.map((facet) => {
          const isCurrent =
            facet.capability === input.snapshot.capability &&
            resourceKeyOfScope(facet.resource) === input.snapshot.resourceKey;
          const row = isCurrent ? authorityRowForAcquisition(input) : facet.row;
          return {
            selectionKey: facet.selectionKey,
            defaultSelected: isCurrent,
            capability: facet.capability,
            title: row.action,
            resource: { type: facet.resource.kind, label: "Where", value: row.resource },
            row,
          };
        }),
      });
      return handle.resolution;
    })();
    if (this.presentationLifetime.signal.aborted) return;
    if (this.byId.get(acquisitionId) !== entry) return;
    if (signal?.aborted) {
      this.finish(entry, { state: "closed" });
      return;
    }
    const { decision, selectedAuthorityFacetKeys, resolver } = resolution;
    const selected = new Set(selectedAuthorityFacetKeys ?? []);
    const currentSelectionKey = facets.find(
      (facet) =>
        facet.capability === input.snapshot.capability &&
        resourceKeyOfScope(facet.resource) === input.snapshot.resourceKey
    )?.selectionKey;
    const currentCovered = currentSelectionKey ? selected.has(currentSelectionKey) : false;
    entry.info.pending = false;
    this.finish(
      entry,
      {
        state: "decided",
        decision: decision === "task" && currentCovered ? "task" : "deny",
      },
      acquisitionJson(resolution),
      () => {
        if (decision === "task") {
          for (const facet of facets) {
            if (!selected.has(facet.selectionKey)) continue;
            const grant = facet.grants[0];
            for (const duplicate of facet.grants) {
              if (duplicate.id) this.deps.grantStore.revoke(duplicate.id);
            }
            this.deps.grantStore.issue({
              effect: "allow",
              capability: facet.capability,
              resource: facet.resource,
              subject: grant?.subject ?? input.snapshot.taskAuthority!,
              constraints: {
                ...(grant?.constraints ?? {}),
                lineageAtConsent: [
                  ...new Set([
                    ...facet.grants.flatMap(
                      (duplicate) => duplicate.constraints?.lineageAtConsent ?? []
                    ),
                    ...lineage,
                  ]),
                ],
              },
              issuedBy: resolver
                ? `user:${resolver.subject.userId}`
                : (grant?.issuedBy ??
                  (input.caller.subject ? `user:${input.caller.subject.userId}` : "host:approval")),
              provenance: "acquisition",
              scope: "task",
            });
          }
        }
      }
    );
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
      sessionId: input.snapshot.sessionId,
      ...(signal ? { signal } : {}),
    });
    const retained = this.deps.grantStore.acquisitions.get(info.acquisitionId, {
      ownerRuntimeId: input.caller.runtime.id,
      sessionId: input.snapshot.sessionId,
    });
    return {
      ...outcome,
      info: retained
        ? invocationAcquisitionInfo(retained, restoreInvocationInputs(retained))
        : (outcome.info ?? { ...info, pending: false }),
    };
  }

  async awaitDecision(
    input: AcquisitionOwner & {
      acquisitionId: string;
      signal?: AbortSignal;
    }
  ): Promise<AcquisitionOutcome> {
    if (input.signal?.aborted) throw acquisitionWaitAbortError();
    const entry = this.byId.get(input.acquisitionId);
    if (!entry) {
      const retained = this.deps.grantStore.acquisitions.get(input.acquisitionId, input);
      if (retained?.state === "pending") {
        this.startInvocation(retained, retained.deliveryOwner);
        const active = this.byId.get(retained.acquisitionId);
        if (active) return this.waitOnAcquisition(active, input.signal);
        // Restoring a join can consume an already committed standing result
        // synchronously. Its canonical receipt then owns the answer.
        const settled = this.deps.grantStore.acquisitions.get(retained.acquisitionId, input);
        if (!settled || settled.state === "pending")
          throw new Error("Restored acquisition has neither an active projection nor a receipt");
        this.handoffInBand(settled.acquisitionId, settled.admission);
        return acquisitionOutcome(invocationAcquisitionSettlement(settled));
      }
      if (retained) {
        this.handoffInBand(retained.acquisitionId, retained.admission);
        return acquisitionOutcome(invocationAcquisitionSettlement(retained));
      }
      throw Object.assign(new Error("Acquisition is not owned by this task"), { code: "EACCES" });
    }
    if (entry.info.ownerRuntimeId !== input.ownerRuntimeId || entry.sessionId !== input.sessionId) {
      throw Object.assign(new Error("Acquisition is not owned by this task"), { code: "EACCES" });
    }
    return this.waitOnAcquisition(entry, input.signal);
  }

  private async waitOnAcquisition(
    entry: AwaitableAcquisition,
    signal?: AbortSignal
  ): Promise<AcquisitionOutcome> {
    if (signal?.aborted) throw acquisitionWaitAbortError();
    const delivery = entry.delivery;
    let receive!: (settlement: AcquisitionSettlement) => void;
    let abort: (() => void) | undefined;
    try {
      const settlement = await new Promise<AcquisitionSettlement>((resolve, reject) => {
        receive = resolve;
        delivery.waiters.add(receive);
        if (signal) {
          abort = () => reject(acquisitionWaitAbortError());
          signal.addEventListener("abort", abort, { once: true });
        }
        if (delivery.settlement) receive(delivery.settlement);
      });
      if (signal?.aborted) throw acquisitionWaitAbortError();
      // Receiving a failed settlement also delivers the original failure to
      // this observer; classification must not trigger a concurrent owner wake.
      this.handoffInBand(entry.info.acquisitionId, {
        ownerRuntimeId: entry.info.ownerRuntimeId,
        sessionId: entry.sessionId,
      });
      delivery.observed = true;
      return acquisitionOutcome(settlement);
    } finally {
      if (signal && abort) signal.removeEventListener("abort", abort);
      delivery.waiters.delete(receive);
      // A decision can settle just before transport cancellation wins the
      // response race. The final departing observer then owns the handover.
      void this.notifyUnobservedOwner(entry);
    }
  }

  private handoffInBand(acquisitionId: string, owner?: AcquisitionOwner): void {
    const active = this.byId.get(acquisitionId);
    const boundOwner =
      owner ??
      (active && {
        ownerRuntimeId: active.info.ownerRuntimeId,
        sessionId: active.sessionId,
      });
    if (!boundOwner) throw new Error("Acquisition response has no bound delivery owner");
    const retained = this.deps.grantStore.acquisitions.get(acquisitionId, boundOwner);
    // Failed canonical writes still propagate their original live failure; they
    // did not establish a receipt whose delivery ownership can be transferred.
    if (retained?.state !== "pending")
      this.deps.grantStore.acquisitions.setDeliveryOwner(acquisitionId, boundOwner, "in-band");
  }

  private settleAcquisition(entry: AwaitableAcquisition, settlement: AcquisitionSettlement): void {
    entry.delivery.settlement = settlement;
    for (const receive of entry.delivery.waiters) receive(settlement);
    void this.notifyUnobservedOwner(entry);
  }

  private async notifyUnobservedOwner(entry: AwaitableAcquisition): Promise<void> {
    const delivery = entry.delivery;
    if (
      !delivery.settlement ||
      !delivery.ownerRedrive ||
      !this.deps.notifyOwner ||
      delivery.notifying ||
      delivery.waiters.size !== 0 ||
      delivery.observed
    )
      return;
    delivery.notifying = true;
    try {
      await this.deliverOwner(entry.info.ownerRuntimeId, entry.info.acquisitionId);
      delivery.ownerRedrive = false;
    } catch (error) {
      console.warn(
        `[AuthorityAcquisition] wake hint failed for ${entry.info.ownerRuntimeId}:`,
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      delivery.notifying = false;
    }
  }

  /** Retire and join one captured activation lifetime without touching a later reattach. */
  async closeOwner(owner: AcquisitionOwner): Promise<void> {
    this.deps.grantStore.acquisitions.retire(owner);
    const entries = this.presentationEntries().filter(
      (entry) =>
        entry.info.ownerRuntimeId === owner.ownerRuntimeId && entry.sessionId === owner.sessionId
    );
    await this.closePresentations(entries);
  }

  /** Commit canonical retirement before withdrawing its live approval presentation. */
  async closeRuntime(ownerRuntimeId: string): Promise<void> {
    this.deps.grantStore.acquisitions.retireRuntime(ownerRuntimeId);
    await this.closePresentations(
      this.presentationEntries().filter((entry) => entry.info.ownerRuntimeId === ownerRuntimeId)
    );
  }

  /** Commit exact operation closure, then join only its live approval presentation. */
  async withdrawAcquisition(
    input: AcquisitionOwner & {
      acquisitionId: string;
      bindingDigest: string;
    }
  ): Promise<AuthorityAcquisitionRecord> {
    const record = this.deps.grantStore.acquisitions.withdraw(
      input.acquisitionId,
      input,
      input.bindingDigest
    );
    await this.closePresentations(
      this.presentationEntries().filter(
        (entry) =>
          entry.info.acquisitionId === record.acquisitionId &&
          entry.info.ownerRuntimeId === input.ownerRuntimeId &&
          entry.sessionId === input.sessionId
      )
    );
    return record;
  }

  async closeSession(sessionId: string): Promise<void> {
    this.deps.grantStore.acquisitions.retireSession(sessionId);
    await this.closePresentations(
      this.presentationEntries().filter((entry) => entry.sessionId === sessionId),
      () => this.deps.grantStore.pruneSession(sessionId)
    );
  }

  async closeAgent(agentBindingId: string): Promise<number> {
    const entries = this.presentationEntries().filter(
      (entry) => entry.agentBindingId === agentBindingId
    );
    await this.closePresentations(entries);
    return entries.length;
  }

  async closeAll(): Promise<number> {
    const pending = this.presentationEntries();
    await this.closePresentations(pending);
    return pending.length;
  }

  /** A terminal owner holds its whole presentation flight through cancellation and settlement. */
  private async closePresentations(
    entries: readonly PendingAcquisition[],
    releaseAuthority?: () => void
  ): Promise<void> {
    const failures: unknown[] = [];
    const attempt = (operation: () => void) => {
      try {
        operation();
      } catch (error) {
        failures.push(error);
      }
    };
    const flights = entries.map((entry) => {
      const existing = this.closingPresentations.get(entry);
      if (existing) return existing;
      const flight = (async () => {
        const errors: unknown[] = [];
        const close = (operation: () => void) => {
          try {
            operation();
          } catch (error) {
            errors.push(error);
          }
        };
        entry.delivery.ownerRedrive = false;
        close(() => entry.presentationLifetime.abort(new Error("Acquisition lifecycle closed")));
        // Each presentation owns its queue waiter through this signal. A
        // matching capability/resource may also belong to another operation;
        // withdrawing this lifetime must leave those waiters actionable.
        close(() => this.finish(entry, { state: "closed" }));
        if (entry.presentation) {
          try {
            await entry.presentation;
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1)
          throw new AggregateError(errors, "Acquisition presentation closure failed", {
            cause: errors[0],
          });
      })();
      this.closingPresentations.set(entry, flight);
      void flight.then(
        () => this.closingPresentations.delete(entry),
        () => this.closingPresentations.delete(entry)
      );
      return flight;
    });
    if (releaseAuthority) attempt(releaseAuthority);
    for (const result of await Promise.allSettled(flights))
      if (result.status === "rejected") failures.push(result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "Acquisition lifecycle closure failed", {
        cause: failures[0],
      });
  }

  private presentationEntries(): PendingAcquisition[] {
    return [...new Set([...this.byId.values(), ...this.closingPresentations.keys()])];
  }

  private cancelPresentation(entry: PendingAcquisition, exactSnapshot = false): void {
    if (entry.targetRequestId) return;
    this.deps.approvalQueue.resolveMatching?.(
      (approval) =>
        approval.kind === "capability" &&
        approval.callerId === entry.info.ownerRuntimeId &&
        approval.capability === entry.info.capability &&
        approval.grantResourceKey === entry.info.resourceKey &&
        (!exactSnapshot ||
          (approval.snapshot !== undefined &&
            canonicalJson(approval.snapshot) === canonicalJson(entry.inputs[0]?.snapshot))),
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

  /** A fresh ask supersedes only its exact current cycle; retained history is never scanned or forgotten. */
  invalidate(inputs: readonly AcquisitionRequestInput[]): void {
    const input = validateAcquisitionGroup(inputs);
    const target = inputs.length === 1 ? this.matchingTargetRequest(input) : null;
    const delta = this.sourceDeltaFor(input);
    const requestKey = target
      ? targetJoinRequestKey(
          target.requestId,
          input.caller.runtime.id,
          input.snapshot.sessionId,
          input.snapshot.causalParent
        )
      : delta
        ? sourceDeltaRequestKey(input, delta.grants, delta.lineage)
        : acquisitionRequestGroupKey(inputs);
    const owner = { ownerRuntimeId: input.caller.runtime.id, sessionId: input.snapshot.sessionId };
    const record = this.deps.grantStore.acquisitions.current(requestKey, owner);
    if (record) {
      const info = invocationAcquisitionInfo(record, restoreInvocationInputs(record));
      if (info.cooldownUntil && info.cooldownUntil > Date.now()) return;
      this.deps.grantStore.acquisitions.supersede(requestKey, owner);
    }
  }

  private async present(
    entry: PendingAcquisition,
    inputs: readonly AcquisitionRequestInput[],
    attention: "interrupt" | "queue",
    invocationSignal?: AbortSignal
  ): Promise<void> {
    const input = validateAcquisitionGroup(inputs);
    const presentation = input.presentation;
    const subjectLifetimes = inputs.flatMap((input) =>
      input.snapshot.subjectBinding?.documentId
        ? [this.deps.grantStore.subjectExecutionSignal(input.snapshot.subjectBinding)]
        : []
    );
    const signal = combineAcquisitionSignals(invocationSignal, inputs, [
      this.presentationLifetime.signal,
      ...subjectLifetimes,
    ]);
    const allowedDecisions = allowedDecisionsForGroup(inputs);
    const taskSubject =
      input.snapshot.taskAuthority ?? input.snapshot.taskRef ?? input.snapshot.sessionId;
    const preparation = this.deps.resolveTaskTitle
      ? await this.invocationTaskTitle(entry, taskSubject, signal!)
      : {};
    if (!preparation) return;
    const taskTitle = preparation.title;
    const displayedWebsite =
      websiteAuthorityIdentity(input.caller) ?? input.snapshot.initiatingWebsite;
    const requestBase = {
      authoritySubject: {
        principal: input.snapshot.callerPrincipal,
        ...(input.snapshot.callerPrincipal.startsWith("code:") && input.caller.code
          ? { reviewedVersion: input.caller.code.effectiveVersion }
          : {}),
        ...(displayedWebsite
          ? {
              website: {
                origin: displayedWebsite.origin,
                workspaceId: displayedWebsite.workspaceId,
                documentId: displayedWebsite.binding.documentId,
              },
            }
          : {}),
      },
      callerId: input.caller.runtime.id,
      callerKind: approvalCallerKind(input.caller.runtime.kind),
      repoPath: input.caller.code?.repoPath ?? "vibestudio/session",
      effectiveVersion: input.caller.code?.effectiveVersion ?? input.snapshot.snippetDigest,
      attention,
      operationId: entry.info.acquisitionId,
      taskSubject,
      ...(taskTitle ? { taskTitle } : {}),
      securityIdentity: entry.requestKey,
      semanticFamily:
        input.presentation?.operation?.kind && input.presentation.operation.kind !== "unknown"
          ? input.presentation.operation.kind
          : entry.info.cardType,
      sourcesShown: (input.snapshot.lineageClasses ?? [])
        .filter((item) => item.startsWith("source:"))
        .map((item) => item.slice("source:".length))
        .sort(),
      repeatReason: "none" as const,
      ...requestedByAccount(input.caller),
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
    const queueResolution = presentation?.installReview
      ? {
          decision: await this.deps.approvalQueue.request({
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
            ...(presentation.installReview.originallyInstalledFrom
              ? { originallyInstalledFrom: presentation.installReview.originallyInstalledFrom }
              : {}),
            ...(installReviewSections(presentation.installReview)
              ? { sections: installReviewSections(presentation.installReview)! }
              : {}),
            configWrite: presentation.installReview.configWrite ?? null,
          }),
          selectedAuthorityFacetKeys: undefined,
        }
      : await (() => {
          const request = {
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
                    selectionKey: acquisitionFacetSelectionKey(facet),
                    defaultSelected: facet.snapshot.capability !== "context.boundary",
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
          } satisfies CapabilityApprovalQueueRequest;
          return this.deps.approvalQueue.requestWithHandle
            ? this.deps.approvalQueue.requestWithHandle(request).resolution
            : this.deps.approvalQueue.request(request).then((decision) => ({
                decision,
                selectedAuthorityFacetKeys: undefined,
              }));
        })();
    const decision = queueResolution.decision;

    if (this.presentationLifetime.signal.aborted) return;
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
      this.finish(entry, { state: "closed" }, acquisitionJson(queueResolution));
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
    const selectedFacetKeys = queueResolution.selectedAuthorityFacetKeys
      ? new Set(queueResolution.selectedAuthorityFacetKeys)
      : null;
    let grantIds: string[] = [];
    this.finish(
      entry,
      () => {
        grantIds = inputs
          .filter(
            (facet) =>
              !selectedFacetKeys || selectedFacetKeys.has(acquisitionFacetSelectionKey(facet))
          )
          .map((facet) => this.persistDecision(facet, authorityDecision))
          .filter((grantId): grantId is string => grantId !== undefined);
        return {
          state: "decided",
          decision: authorityDecision,
          ...(grantIds[0] ? { grantId: grantIds[0] } : {}),
        };
      },
      acquisitionJson(queueResolution)
    );
    if (authorityDecision === "version" && grantIds.length > 0)
      this.settlePendingCoveredByVersionGrants(new Set(grantIds));
  }

  private settlePendingCoveredByVersionGrants(issuedIds: ReadonlySet<string>): void {
    for (const pending of [...this.byId.values()]) {
      if (pending.info.tier !== "gated") continue;
      const covering = pending.inputs.map((facet) => {
        const snapshot = facet.snapshot;
        if (!facet.authorizationContext) return undefined;
        return matchingAuthorityGrants({
          grants: this.deps.grantStore.grantsForSubjects(
            [snapshot.callerPrincipal],
            snapshot.capability
          ),
          context: facet.authorizationContext,
          subjects: new Set([snapshot.callerPrincipal]),
          capability: snapshot.capability,
          resourceKey: snapshot.resourceKey,
          resource: facet.resource,
          invocationDigest: facet.snapshotDigest,
          providerExecutionDigest: snapshot.providerExecutionDigest,
        }).find((grant) => grant.id && issuedIds.has(grant.id) && grant.effect === "allow");
      });
      if (covering.some((grant) => !grant)) continue;
      this.finish(pending, {
        state: "decided",
        decision: "version",
        ...(covering[0]?.id ? { grantId: covering[0].id } : {}),
      });
      this.cancelPresentation(pending, true);
    }
  }

  private finish(
    entry: PendingAcquisition,
    outcome: AcquisitionSettlement | (() => AcquisitionSettlement),
    decision?: JsonValue,
    write?: () => void
  ): void {
    if (this.presentationLifetime.signal.aborted) return;
    if (this.byId.get(entry.info.acquisitionId) !== entry) return;
    const retained = this.deps.grantStore.acquisitions.get(entry.info.acquisitionId, {
      ownerRuntimeId: entry.info.ownerRuntimeId,
      sessionId: entry.sessionId,
    });
    if (retained && retained.state !== "pending") {
      this.releaseInvocation(entry, retained, invocationAcquisitionSettlement(retained));
      return;
    }
    let committed: AcquisitionSettlement | undefined;
    const record = this.deps.grantStore.acquisitions.resolve(
      entry.info.acquisitionId,
      { ownerRuntimeId: entry.info.ownerRuntimeId, sessionId: entry.sessionId },
      entry.bindingDigest,
      decision ??
        acquisitionJson({
          kind: "settlement",
          outcome: typeof outcome === "function" ? null : storeAcquisitionSettlement(outcome),
        }),
      () => {
        write?.();
        const settled = typeof outcome === "function" ? outcome() : outcome;
        const info = { ...entry.info, pending: Boolean(entry.info.cooldownUntil) };
        committed = settled;
        return {
          state: settled.state,
          value: storeAcquisitionSettlement(
            settled.state === "failed" ? settled : { ...settled, info }
          ),
        };
      }
    );
    this.releaseInvocation(entry, record, committed ?? invocationAcquisitionSettlement(record));
  }

  private releaseInvocation(
    entry: PendingAcquisition,
    record: AuthorityAcquisitionRecord,
    outcome: AcquisitionSettlement
  ): void {
    this.byId.delete(entry.info.acquisitionId);
    this.byRequestKey.delete(entry.requestKey);
    entry.info = invocationAcquisitionInfo(record, entry.inputs);
    this.settleAcquisition(entry, outcome);
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
    const binding = input.snapshot.subjectBinding;
    if (
      binding &&
      (this.deps.grantStore.getAuthoritySubject(binding.subject)?.generation !==
        binding.generation ||
        (binding.documentId && !this.deps.grantStore.isSubjectExecutionCurrent(binding)))
    )
      throw new Error("The authorizing subject retired before approval completed");
    if (binding && binding.subject !== input.snapshot.callerPrincipal) {
      throw new Error("Approval subject binding does not match its sealed authorizing principal");
    }
    const subjectConstraints = binding
      ? {
          subjectGeneration: binding.generation,
          ...(binding.documentId ? { documentId: binding.documentId } : {}),
        }
      : {};
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
          ...subjectConstraints,
          ...(input.snapshot.sourceWorkspaceId
            ? { sourceWorkspaceId: input.snapshot.sourceWorkspaceId }
            : {}),
          ...(input.snapshot.missionSubject === "-"
            ? { sessionId: input.snapshot.sessionId }
            : { missionSubject: input.snapshot.missionSubject }),
        },
        issuedBy: grantIssuer(input.caller),
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
          ...(onceSubject === input.snapshot.callerPrincipal ? subjectConstraints : {}),
          ...(input.snapshot.sourceWorkspaceId
            ? { sourceWorkspaceId: input.snapshot.sourceWorkspaceId }
            : {}),
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
        issuedBy: grantIssuer(input.caller),
        provenance: input.tier === "critical" ? "critical-confirmation" : "acquisition",
        ...capabilityDefinition,
      });
      return;
    }
    if (decision === "session" || decision === "always") {
      if (!binding || (decision === "session" && !binding.documentId)) {
        throw new Error(
          "Continuing approval requires an authenticated subject and lifetime binding"
        );
      }
      return this.deps.grantStore.issue({
        effect: "allow",
        capability: input.snapshot.capability,
        resource: input.resource,
        subject: binding.subject,
        constraints: {
          subjectGeneration: binding.generation,
          ...(decision === "session" ? { documentId: binding.documentId } : {}),
          ...(input.snapshot.sourceWorkspaceId
            ? { sourceWorkspaceId: input.snapshot.sourceWorkspaceId }
            : {}),
          lineageAtConsent,
        },
        issuedBy: grantIssuer(input.caller),
        provenance: "acquisition",
        ...capabilityDefinition,
        scope: decision === "session" ? "session" : "system",
        ...(input.presentation?.grantExpiresAt
          ? { expiresAt: input.presentation.grantExpiresAt }
          : {}),
      }).id;
    }
    if (decision === "task") {
      if (!input.snapshot.taskAuthority) {
        throw new Error("Task approval requires an attested task authority");
      }
      this.deps.grantStore.issue({
        effect: "allow",
        capability: input.snapshot.capability,
        resource: input.resource,
        subject: binding?.subject ?? input.snapshot.taskAuthority,
        constraints: {
          ...subjectConstraints,
          ...(binding ? { taskAuthority: input.snapshot.taskAuthority } : {}),
          ...(input.snapshot.sourceWorkspaceId
            ? { sourceWorkspaceId: input.snapshot.sourceWorkspaceId }
            : {}),
          ...(input.snapshot.missionSubject === "-"
            ? {}
            : { missionSubject: input.snapshot.missionSubject }),
          lineageAtConsent,
        },
        issuedBy: grantIssuer(input.caller),
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
          ...(input.snapshot.sourceWorkspaceId
            ? { sourceWorkspaceId: input.snapshot.sourceWorkspaceId }
            : {}),
          lineageAtConsent,
          agentBindingId: input.snapshot.agentBindingId,
        },
        issuedBy: grantIssuer(input.caller),
        provenance: "acquisition",
        ...capabilityDefinition,
        scope: "agent",
        lastUsedAt: Date.now(),
        decidedBy: grantIssuer(input.caller),
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
          ...(input.snapshot.sourceWorkspaceId
            ? { sourceWorkspaceId: input.snapshot.sourceWorkspaceId }
            : {}),
          missionSubject: input.snapshot.missionSubject,
          lineageAtConsent,
        },
        issuedBy: grantIssuer(input.caller),
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
        decidedBy: grantIssuer(input.caller),
        surface: "card",
      });
      return;
    }
    if (!input.snapshot.callerPrincipal.startsWith("code:")) {
      throw new Error("Always-allow is only valid for an installed code identity");
    }
    return this.deps.grantStore.issue({
      effect: "allow",
      capability: input.snapshot.capability,
      resource: input.resource,
      subject: input.snapshot.callerPrincipal,
      constraints: {
        ...(input.snapshot.sourceWorkspaceId
          ? { sourceWorkspaceId: input.snapshot.sourceWorkspaceId }
          : {}),
        ...(decision === "version" && input.snapshot.providerExecutionDigest !== "-"
          ? { providerExecutionDigest: input.snapshot.providerExecutionDigest }
          : {}),
      },
      issuedBy: grantIssuer(input.caller),
      provenance: "acquisition",
      scope: "version",
      ...capabilityDefinition,
      ...(input.presentation?.grantExpiresAt
        ? { expiresAt: input.presentation.grantExpiresAt }
        : {}),
    }).id;
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

function acquisitionDelivery(continuation: AcquisitionContinuation): AcquisitionDelivery {
  return {
    ownerRedrive: continuation === "owner-redrive",
    waiters: new Set(),
    observed: false,
  };
}

function restoreInvocationInputs(
  record: AuthorityAcquisitionRecord
): readonly AcquisitionRequestInput[] {
  const facts = record.admission.facts as unknown as StoredAcquisition;
  if (!["invocation", "target-join"].includes(facts.kind))
    throw new Error("Unknown stored acquisition kind");
  const inputs = restoreAcquisitionInputs(facts.inputs);
  if (
    inputs.some(
      (input) =>
        input.caller.runtime.id !== record.admission.ownerRuntimeId ||
        input.snapshot.sessionId !== record.admission.sessionId
    )
  )
    throw new Error("Stored acquisition facts disagree with their owner binding");
  return inputs;
}

function invocationAcquisitionInfo(
  record: AuthorityAcquisitionRecord,
  inputs: readonly AcquisitionRequestInput[]
): AcquisitionInfo {
  const input = validateAcquisitionGroup(inputs);
  const facts = record.admission.facts as unknown as StoredAcquisition;
  if (
    record.resolution?.value &&
    typeof record.resolution.value === "object" &&
    !Array.isArray(record.resolution.value)
  ) {
    const info = record.resolution.value["info"];
    if (info) return { ...(info as unknown as AcquisitionInfo) };
  }
  return {
    acquisitionId: record.acquisitionId,
    ownerRuntimeId: record.admission.ownerRuntimeId,
    snapshotDigest: input.snapshotDigest,
    capability: input.snapshot.capability,
    resourceKey: input.snapshot.resourceKey,
    tier: facts.kind === "invocation" && facts.sourceDelta ? "gated" : tierForGroup(inputs),
    cardType:
      facts.kind === "invocation" && facts.sourceDelta ? "task.rules" : cardTypeForGroup(inputs),
    renderedAction: input.renderedAction,
    pending: record.state === "pending",
  };
}

function storeAcquisitionSettlement(outcome: AcquisitionSettlement): JsonValue {
  if (outcome.state !== "failed") return acquisitionJson(outcome);
  const error = outcome.error;
  return acquisitionJson({
    state: "failed",
    error: {
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : "Error",
      stack: error instanceof Error ? error.stack : undefined,
      code:
        error && typeof error === "object" && "code" in error && typeof error.code === "string"
          ? error.code
          : undefined,
      errorKind: rpcErrorKindOf(error, "internal"),
      errorData: rpcErrorDataOf(error),
    },
  });
}

function invocationAcquisitionSettlement(
  record: AuthorityAcquisitionRecord
): AcquisitionSettlement {
  if (!record.resolution) throw new Error("Acquisition has not settled");
  if (record.state === "failed") {
    const value = record.resolution.value as unknown as {
      error: {
        message: string;
        name: string;
        stack?: string;
        code?: string;
        errorKind: import("@vibestudio/rpc").RpcErrorKind;
        errorData?: import("@vibestudio/rpc").RpcErrorData;
      };
    };
    const error = new RemoteRpcError(
      value.error.message,
      value.error.errorKind,
      value.error.code,
      value.error.errorData
    );
    error.name = value.error.name;
    if (value.error.stack) error.stack = value.error.stack;
    return { state: "failed", error };
  }
  const outcome = record.resolution.value as unknown as AcquisitionOutcome;
  return {
    state: record.state as AcquisitionOutcome["state"],
    ...(outcome.decision ? { decision: outcome.decision } : {}),
    ...(outcome.grantId ? { grantId: outcome.grantId } : {}),
  };
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
      causalParent: input.snapshot.causalParent ?? null,
      taskRef: input.snapshot.taskRef ?? null,
      lineageClasses: [...(input.snapshot.lineageClasses ?? ["none"])].sort(),
      codeLineage: input.snapshot.codeLineage,
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
      input.caller.runtime.id !== first.caller.runtime.id ||
      input.snapshot.sessionId !== first.snapshot.sessionId ||
      input.snapshot.service !== first.snapshot.service ||
      input.snapshot.method !== first.snapshot.method ||
      input.snapshot.argsDigest !== first.snapshot.argsDigest ||
      input.snapshot.preparedStateDigest !== first.snapshot.preparedStateDigest ||
      canonicalJson(input.snapshot.causalParent ?? null) !==
        canonicalJson(first.snapshot.causalParent ?? null)
    ) {
      throw new Error("Composed authority leaves must belong to one exact invocation");
    }
  }
  return first;
}

function acquisitionRequestGroupKey(inputs: readonly AcquisitionRequestInput[]): string {
  const first = validateAcquisitionGroup(inputs);
  if (inputs.length === 1)
    return canonicalJson([
      "invocation-acquisition-v2",
      canonicalJson({
        sessionId: first.snapshot.sessionId,
        requestKey: acquisitionRequestKey(first),
      }),
    ]);
  return canonicalJson([
    "composed-acquisition-v2",
    first.caller.runtime.id,
    first.snapshot.sessionId,
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
    outsideContent: false,
  });
}

function tierForGroup(inputs: readonly AcquisitionRequestInput[]): "gated" | "critical" {
  return inputs.some((input) => input.tier === "critical") ? "critical" : "gated";
}

function cardTypeForGroup(inputs: readonly AcquisitionRequestInput[]): AuthorityPromptCardType {
  if (tierForGroup(inputs) === "critical") return "confirm.critical";
  return cardTypeFor(validateAcquisitionGroup(inputs));
}

function authorityRowForAcquisition(input: AcquisitionRequestInput) {
  const presentation = input.presentation;
  return authorityRow({
    capability: input.snapshot.capability,
    resource: input.resource,
    resourcePhrase: input.target?.title ?? presentation?.resource.value,
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

function targetRequestAuthorityRow(request: DurableTargetAuthorityRequest) {
  return authorityRow({
    capability: request.capability,
    resource: request.resource,
    tier: request.tier,
    statement: "prospective",
    provenance: { source: "receiver", surface: `declared by ${request.review.declaredBy}` },
    flags: {},
    category: { domain: request.review.domain, verb: request.review.verb },
    reviewedAction: request.review.action,
  });
}

function resourceKeyOfScope(resource: ResourceScope): string {
  switch (resource.kind) {
    case "exact":
      return resource.key;
    case "prefix":
      return resource.prefix;
    case "origin":
      return resource.origin;
    case "domain":
      return resource.domain;
    case "network":
      return resource.value;
  }
}

function sourceDeltaRequestKey(
  input: AcquisitionRequestInput,
  grants: readonly import("@vibestudio/rpc").AuthorityGrant[],
  lineage: readonly string[]
): string {
  const { facets } = sourceDeltaFacets(input, grants);
  return canonicalJson([
    "task-source-delta-v2",
    input.caller.runtime.id,
    input.snapshot.sessionId,
    input.snapshot.taskAuthority ?? "",
    input.snapshot.causalParent ?? null,
    ...lineage.filter((entry) => entry.startsWith("source:")).sort(),
    ...facets.map((facet) => facet.selectionKey).sort(),
  ]);
}

function sourceDeltaFacets(
  input: AcquisitionRequestInput,
  grants: readonly import("@vibestudio/rpc").AuthorityGrant[]
) {
  const currentGrant = grants.find(
    (grant) =>
      grant.capability === input.snapshot.capability &&
      resourceKeyOfScope(grant.resource) === input.snapshot.resourceKey
  );
  const facets: Array<{
    selectionKey: string;
    grants: import("@vibestudio/rpc").AuthorityGrant[];
    capability: string;
    resource: ResourceScope;
    row: ReturnType<typeof authorityRowForAcquisition>;
  }> = [];
  for (const grant of grants) {
    const existing = facets.find(
      (facet) =>
        facet.capability === grant.capability &&
        resourceKeyOfScope(facet.resource) === resourceKeyOfScope(grant.resource)
    );
    if (existing) {
      existing.grants.push(grant);
    } else {
      facets.push({
        selectionKey: grantSelectionKey(grant),
        grants: [grant],
        capability: grant.capability,
        resource: grant.resource,
        row: grantAuthorityRow(grant),
      });
    }
  }
  if (!currentGrant) {
    facets.push({
      selectionKey: acquisitionFacetSelectionKey(input),
      grants: [],
      capability: input.snapshot.capability,
      resource: input.resource,
      row: authorityRowForAcquisition(input),
    });
  }
  return { currentGrant, facets };
}

function grantAuthorityRow(grant: import("@vibestudio/rpc").AuthorityGrant) {
  return authorityRow({
    capability: grant.capability,
    resource: grant.resource,
    tier: "gated",
    statement: "allowed",
    provenance: {
      source: "approval",
      decidedAt: grant.createdAt,
      decidedBy: grant.issuedBy,
      lineageClasses: grant.constraints?.lineageAtConsent,
    },
    flags: {},
    degradeUnknown: true,
  });
}

function outsideSourceLabel(key: string): string {
  const separator = key.indexOf(":");
  const kind = separator < 0 ? "" : key.slice(0, separator);
  const value = separator < 0 ? key : key.slice(separator + 1);
  if (kind === "web") return value || "a website";
  if (kind === "email") return value ? `email from ${value}` : "email";
  if (kind === "channel") return "another conversation";
  if (kind === "api") return value ? `${value} data` : "outside service data";
  return "an outside source";
}

function outsideSourceSummary(keys: readonly string[]): string {
  const labels = [...new Set(keys.map(outsideSourceLabel))];
  if (labels.length === 0) return "new outside content";
  if (labels.length === 1) return labels[0]!;
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, 2).join(", ")}, and ${labels.length - 2} other ${
    labels.length - 2 === 1 ? "source" : "sources"
  }`;
}

function grantSelectionKey(grant: import("@vibestudio/rpc").AuthorityGrant): string {
  return (
    grant.id ??
    canonicalJson({
      subject: grant.subject,
      capability: grant.capability,
      resource: grant.resource,
      createdAt: grant.createdAt,
    })
  );
}

function acquisitionFacetSelectionKey(input: AcquisitionRequestInput): string {
  return canonicalJson({
    capability: input.snapshot.capability,
    resource: input.resource,
    capabilityDefinitionDigest: input.snapshot.capabilityDefinitionDigest,
  });
}

function combineAcquisitionSignals(
  invocationSignal: AbortSignal | undefined,
  inputs: readonly AcquisitionRequestInput[],
  executionSignals: readonly AbortSignal[] = []
): AbortSignal | undefined {
  const signals = [
    invocationSignal,
    ...executionSignals,
    ...inputs.map((input) => input.presentation?.signal),
  ].filter((signal): signal is AbortSignal => signal !== undefined);
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
  if (input.snapshot.subjectBinding?.subject === input.snapshot.callerPrincipal) {
    return [
      "once",
      ...(input.snapshot.subjectBinding.documentId
        ? ["session" as const]
        : input.snapshot.taskAuthority
          ? ["task" as const]
          : []),
      "always",
      "deny",
    ];
  }
  if (input.snapshot.callerPrincipal.startsWith("session:")) {
    return [
      "once",
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
  return (AUTHORITY_ACQUISITION_DECISIONS as readonly string[]).includes(decision);
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

function targetJoinRequestKey(
  requestId: string,
  ownerRuntimeId: string,
  sessionId: string,
  causalParent: InvocationSnapshot["causalParent"]
): string {
  return canonicalJson([
    "target-join-v1",
    requestId,
    ownerRuntimeId,
    sessionId,
    causalParent ?? null,
  ]);
}
