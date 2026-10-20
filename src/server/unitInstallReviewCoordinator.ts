import type { UnitApprovalCoordinator } from "@vibestudio/unit-host";
import type {
  PendingApproval,
  PendingUnitInstallReviewApproval,
  ReviewedUnit,
} from "@vibestudio/shared/approvals";
import type { InstallReviewOrigin } from "@vibestudio/shared/authority/unitInstallReview";
import type {
  ApprovalQueue,
  ApprovalQueueDecision,
  ApprovalRequesterRef,
  InstallLandingReport,
} from "./services/approvalQueue.js";

export interface UnitApprovalQueueLike {
  requestWithHandle(req: {
    kind: "unit-install-review";
    callerId: string;
    callerKind: "system";
    repoPath: string;
    effectiveVersion: string;
    dedupKey?: string | null;
    mode: PendingUnitInstallReviewApproval["mode"];
    title: string;
    description: string;
    units: ReviewedUnit[];
    origins?: ReadonlyMap<string, InstallReviewOrigin>;
    identityKeys?: ReadonlyMap<string, string>;
    reportsLanding?: boolean;
    configWrite?: PendingUnitInstallReviewApproval["configWrite"];
  }): { approvalId: string; decision: Promise<ApprovalQueueDecision> };
  listPending(): PendingApproval[];
  holdForUnitReview: ApprovalQueue["holdForUnitReview"];
  reportInstallLanding?(approvalId: string, report: InstallLandingReport): void;
}

interface PendingRequest {
  entries: ReviewedUnit[];
  origins?: ReadonlyMap<string, InstallReviewOrigin>;
  identityKeys?: ReadonlyMap<string, string>;
  presentation?: ReviewPresentation;
  opened?(asked: boolean): void;
  applyApproved(): Promise<void>;
  applyDenied(): void;
  resolve(): void;
  reject(error: unknown): void;
  settleReview(decision: "accepted" | "deny" | "dismiss"): void;
  failReview(error: unknown): void;
}

interface ReviewPresentation {
  callerId: string;
  title: string;
  description: string;
  dedupKey?: string;
  onPublished?(review: { approvalId: string; partCount: number }): void;
}

interface PendingBatch {
  trigger: "startup" | "meta-change";
  requests: PendingRequest[];
  timer: ReturnType<typeof setTimeout> | null;
}

interface ActiveRequest {
  entries: ReviewedUnit[];
  settlement: Promise<void>;
}

type UnitApprovalEntrySelector = (entry: ReviewedUnit) => boolean;

export class UnitInstallReviewCoordinator implements UnitApprovalCoordinator<ReviewedUnit> {
  private pending = new Map<string, PendingBatch>();
  private active = new Map<string, Set<ActiveRequest>>();
  /**
   * Triggers whose staging barrier has already been released.
   *
   * A `startup` batch has no timer, because the whole point of the barrier is
   * that every unit shares one prompt. That leaves anything enqueued after the
   * barrier with nothing that would ever publish it: the request sat in a fresh
   * batch forever and its `enqueue()` promise never settled, so the unit never
   * activated and no gate ever appeared. Once the barrier is released the
   * trigger is latched open and a late arrival publishes on its own.
   */
  private released = new Set<"startup" | "meta-change">();
  private readonly unitApplications = new Map<
    string,
    Set<{
      settlement: Promise<"accepted" | "deny" | "dismiss">;
      pending: boolean;
    }>
  >();
  private readonly unitApplicationObservers = new Map<string, Set<() => void>>();
  private startupReviewsStaged = false;
  private reviewStagingFailure: { error: unknown } | undefined;

  /** Startup classification is authoritative: a missing exact unit will not
   * acquire an application later in this staging operation. */
  finishStartupReviewStaging(error?: unknown): void {
    this.startupReviewsStaged = true;
    if (error !== undefined) this.reviewStagingFailure = { error };
    for (const observers of this.unitApplicationObservers.values())
      for (const observer of [...observers]) observer();
  }

  /**
   * Startup staging failed and its review will never be published. Everything
   * that joined it (a launch among them) receives that failure instead of
   * waiting on a barrier nobody will release; later reviews publish on their own.
   */
  abandonStartupReview(error: unknown): void {
    this.released.add("startup");
    const batch = this.pending.get(batchKey("startup"));
    if (!batch) return;
    this.pending.delete(batchKey("startup"));
    for (const request of batch.requests) {
      request.reject(error);
      request.failReview(error);
    }
  }

  private isStagingStartup(): boolean {
    return this.deps.autoPublishStartup === false && !this.released.has("startup");
  }

  /** Join this exact unit's review and committed application. An observer may
   * arrive before startup has staged the review; cancellation removes only the
   * observer and leaves the shared human question actionable. While it waits,
   * `waiter` is listed on the review so surfaces can attribute it to the work
   * it blocks. */
  whenUnitReviewSettled(
    code: { repoPath: string; effectiveVersion: string },
    signal: AbortSignal,
    waiter: ApprovalRequesterRef
  ): Promise<"accepted" | "deny" | "dismiss"> {
    signal.throwIfAborted();
    const key = `${code.repoPath}@${code.effectiveVersion}`;
    return new Promise((resolve, reject) => {
      let observing = false;
      const release = this.deps.approvalQueue.holdForUnitReview(code, waiter, signal);
      const cleanup = () => {
        release();
        signal.removeEventListener("abort", aborted);
        const observers = this.unitApplicationObservers.get(key);
        observers?.delete(observe);
        if (observers?.size === 0) this.unitApplicationObservers.delete(key);
      };
      const aborted = () => {
        cleanup();
        reject(signal.reason);
      };
      const observe = () => {
        const applications = this.unitApplications.get(key);
        if (observing) return;
        if (!applications?.size) {
          if (this.startupReviewsStaged) {
            cleanup();
            reject(
              this.reviewStagingFailure?.error ??
                new Error(
                  `The reviewed unit ${code.repoPath} no longer has an exact review application`
                )
            );
          }
          return;
        }
        observing = true;
        void Promise.all([...applications].map((application) => application.settlement)).then(
          (decisions) => {
            cleanup();
            resolve(
              decisions.includes("deny")
                ? "deny"
                : decisions.includes("dismiss")
                  ? "dismiss"
                  : "accepted"
            );
          },
          (error) => {
            cleanup();
            reject(error);
          }
        );
      };
      const observers = this.unitApplicationObservers.get(key) ?? new Set();
      observers.add(observe);
      this.unitApplicationObservers.set(key, observers);
      signal.addEventListener("abort", aborted, { once: true });
      observe();
    });
  }

  constructor(
    private readonly deps: {
      approvalQueue: UnitApprovalQueueLike;
      delayMs?: number;
      /**
       * Startup has an explicit staging barrier so every unit shares one
       * prompt: until it is released, every review joins the startup one.
       */
      autoPublishStartup?: boolean;
      /**
       * Whether a unit ships in the host build. Installing Vibestudio already
       * decided about those, so a startup review of nothing else asks nobody.
       */
      isHostBuildUnit?(repoPath: string): boolean;
    }
  ) {}

  enqueue(request: {
    entries: ReviewedUnit[];
    trigger: "startup" | "meta-change";
    origins?: ReadonlyMap<string, InstallReviewOrigin>;
    identityKeys?: ReadonlyMap<string, string>;
    presentation?: ReviewPresentation;
    opened?(asked: boolean): void;
    applyApproved(): Promise<void>;
    applyDenied(): void;
  }): Promise<void> {
    if (request.entries.length === 0) {
      request.opened?.(false);
      return request.applyApproved();
    }
    const versionless = request.entries.find((entry) => !entry.ev);
    if (versionless) {
      throw new Error(
        `Cannot offer install review for ${versionless.source.repo} without an effective version`
      );
    }
    const trigger = this.isStagingStartup() ? "startup" : request.trigger;
    const key = batchKey(trigger);
    let batch = this.pending.get(key);
    if (!batch) {
      batch = { trigger, requests: [], timer: null };
      this.pending.set(key, batch);
      if (trigger !== "startup" || !this.isStagingStartup()) {
        batch.timer = setTimeout(() => {
          void this.publishPending(trigger).catch(() => {
            // Every enqueued request receives the same error through its own
            // promise. Avoid a second unhandled rejection from the timer-owned
            // publication promise.
          });
        }, this.deps.delayMs ?? 0);
      }
    }
    assertCompatiblePresentation(batch.requests, request.presentation);
    let settleReview!: PendingRequest["settleReview"];
    let failReview!: PendingRequest["failReview"];
    const reviewSettlement = new Promise<"accepted" | "deny" | "dismiss">((resolve, reject) => {
      settleReview = resolve;
      failReview = reject;
    });
    // The enqueue promise already propagates application failures. Its exact
    // unit observers independently receive the same retained failure.
    void reviewSettlement.catch(() => {});
    const application = { settlement: reviewSettlement, pending: true };
    void reviewSettlement.then(
      () => {
        application.pending = false;
      },
      () => {
        application.pending = false;
      }
    );
    const enqueue = new Promise<void>((resolve, reject) => {
      batch.requests.push({ ...request, resolve, reject, settleReview, failReview });
    });
    for (const entry of request.entries) {
      const key = `${entry.source.repo}@${entry.ev}`;
      const previous = this.unitApplications.get(key);
      const applications =
        previous && [...previous].some((entry) => entry.pending)
          ? previous
          : new Set<typeof application>();
      applications.add(application);
      this.unitApplications.set(key, applications);
      for (const observer of this.unitApplicationObservers.get(key) ?? []) observer();
    }
    return enqueue;
  }

  publishPending(
    trigger?: "startup" | "meta-change",
    matches?: UnitApprovalEntrySelector
  ): Promise<void> {
    const keys = trigger
      ? [...this.pending.keys(), ...this.active.keys()].filter((key) => key === batchKey(trigger))
      : Array.from(new Set([...this.pending.keys(), ...this.active.keys()]));

    // Starting a batch is deliberately synchronous through approvalQueue.request:
    // callers may inspect the queue immediately after this method returns to
    // distinguish a human decision from unattended activation. The returned
    // promise represents only matching unit applications, not unrelated work
    // which happened to share the same startup trigger.
    // The barrier is released whether or not anything was staged behind it.
    if (trigger) this.released.add(trigger);
    for (const candidate of keys) {
      this.released.add(triggerForBatchKey(candidate));
      this.startPendingBatch(candidate);
    }

    const settlements = keys.flatMap((candidate) =>
      [...(this.active.get(candidate) ?? [])]
        .filter((request) => !matches || request.entries.some(matches))
        .map((request) => request.settlement)
    );
    return Promise.all(settlements).then(() => undefined);
  }

  private startPendingBatch(key: string): void {
    const batch = this.pending.get(key);
    if (!batch) return;
    this.pending.delete(key);
    if (batch.timer) clearTimeout(batch.timer);
    const trigger = batch.trigger;
    const requests = batch.requests;
    const units = distinctUnits(requests.flatMap((request) => request.entries));
    const origins = mergeOrigins(requests);
    const identityKeys = mergeIdentityKeys(requests);
    const presentation = mergePresentation(requests);
    let decision: Promise<ApprovalQueueDecision>;
    let approvalId: string | undefined;
    let approvalParts: PendingUnitInstallReviewApproval["parts"] | undefined;
    let completedRequests = 0;
    let acceptedDecision = false;
    let landingReported = false;
    const landedEntries = new Set<string>();
    const failedEntries = new Map<string, string>();
    const entryKey = (entry: ReviewedUnit): string => `${entry.source.repo}@${entry.ev ?? ""}`;
    const reportLandingOnce = (): void => {
      if (landingReported) return;
      landingReported = true;
      this.reportLanding(units, approvalId, approvalParts, landedEntries, failedEntries);
    };
    const reportDecisionFailureOnce = (error: unknown): void => {
      if (landingReported) return;
      landingReported = true;
      const reason = error instanceof Error ? error.message : String(error);
      this.reportLanding(
        units,
        approvalId,
        approvalParts,
        new Set(),
        new Map(units.map((entry) => [entryKey(entry), reason]))
      );
    };
    const isHostBuildUnit = this.deps.isHostBuildUnit;
    try {
      if (
        trigger === "startup" &&
        isHostBuildUnit &&
        units.every((unit) => isHostBuildUnit(unit.source.repo))
      ) {
        // Accepted exactly as an approval would be, with nothing to show.
        decision = Promise.resolve("accepted");
        for (const request of requests) request.opened?.(false);
      } else {
        const handle = this.deps.approvalQueue.requestWithHandle({
          kind: "unit-install-review",
          callerId: presentation?.callerId ?? "system:units",
          callerKind: "system",
          repoPath: "meta",
          effectiveVersion: "",
          ...(presentation?.dedupKey ? { dedupKey: presentation.dedupKey } : {}),
          // Reconciling declared units is an arrival of code like any other; the
          // heading and rows come from the parts themselves, not from a trigger.
          mode: trigger === "startup" ? "adopt-root" : "install",
          title: presentation?.title ?? reviewTitle(units),
          description: presentation?.description ?? reviewDescription(units),
          units,
          ...(origins.size > 0 ? { origins } : {}),
          ...(identityKeys.size > 0 ? { identityKeys } : {}),
          ...(this.canReportLanding() ? { reportsLanding: true } : {}),
          configWrite: null,
        });
        decision = handle.decision;
        approvalId = handle.approvalId;
        const pending = this.deps.approvalQueue
          .listPending()
          .find((entry) => entry.approvalId === approvalId);
        if (pending?.kind === "unit-install-review") approvalParts = pending.parts;
        presentation?.onPublished?.({
          approvalId: handle.approvalId,
          partCount: pending?.kind === "unit-install-review" ? pending.parts.length : units.length,
        });
        for (const request of requests) request.opened?.(true);
      }
    } catch (error) {
      decision = Promise.reject(error);
    }

    const active = this.active.get(key) ?? new Set<ActiveRequest>();
    this.active.set(key, active);
    for (const request of applyOrder(requests)) {
      const tracked: ActiveRequest = {
        entries: request.entries,
        settlement: Promise.resolve(decision)
          .then(async (resolvedDecision) => {
            if (resolvedDecision === "deny" || resolvedDecision === "dismiss") {
              request.applyDenied();
              request.settleReview(resolvedDecision);
              request.resolve();
            } else if (resolvedDecision === "accepted") {
              acceptedDecision = true;
              try {
                await request.applyApproved();
                request.settleReview("accepted");
                for (const entry of request.entries) landedEntries.add(entryKey(entry));
                request.resolve();
              } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                for (const entry of request.entries) failedEntries.set(entryKey(entry), reason);
                request.reject(error);
                request.failReview(error);
                throw error;
              } finally {
                completedRequests += 1;
                // All host targets apply concurrently. Wait for every result so
                // a successful target is not reported as failed merely because a
                // sibling target failed first.
                if (completedRequests === requests.length) reportLandingOnce();
              }
            } else {
              throw new Error(`Invalid ${resolvedDecision} decision for a workspace-unit approval`);
            }
          })
          .catch((error: unknown) => {
            if (!acceptedDecision) {
              reportDecisionFailureOnce(error);
              request.reject(error);
              request.failReview(error);
            }
            throw error;
          }),
      };
      active.add(tracked);
      void tracked.settlement
        .finally(() => {
          active.delete(tracked);
          if (active.size === 0 && this.active.get(key) === active) {
            this.active.delete(key);
          }
        })
        .catch(() => {
          // The publication promise and the enqueue promise independently
          // expose the same failure to their respective owners.
        });
    }
  }

  private canReportLanding(): boolean {
    return Boolean(this.deps.approvalQueue.reportInstallLanding);
  }

  private reportLanding(
    entries: readonly ReviewedUnit[],
    approvalId?: string,
    approvalParts?: PendingUnitInstallReviewApproval["parts"],
    landedEntries: ReadonlySet<string> = new Set(),
    failedEntries: ReadonlyMap<string, string> = new Map()
  ): void {
    const reportInstallLanding = this.deps.approvalQueue.reportInstallLanding;
    if (!reportInstallLanding || !approvalId || !approvalParts) return;
    const identities = new Set(entries.map((entry) => `${entry.source.repo}@${entry.ev ?? ""}`));
    const failedKeys = new Set(failedEntries.keys());
    const landed = approvalParts
      .filter(
        (part) =>
          identities.has(`${part.repoPath}@${part.effectiveVersion}`) &&
          landedEntries.has(`${part.repoPath}@${part.effectiveVersion}`) &&
          !failedKeys.has(`${part.repoPath}@${part.effectiveVersion}`)
      )
      .map((part) => part.identityKey);
    const landedSet = new Set(landed);
    const failed = approvalParts
      .filter((part) => {
        const key = `${part.repoPath}@${part.effectiveVersion}`;
        return identities.has(key) && !landedSet.has(part.identityKey) && failedEntries.has(key);
      })
      .map((part) => ({
        identityKey: part.identityKey,
        reason: failedEntries.get(`${part.repoPath}@${part.effectiveVersion}`)!,
      }));
    reportInstallLanding.call(this.deps.approvalQueue, approvalId, {
      landed,
      ...(failed.length > 0 ? { failed } : {}),
      ...(failed.length > 0 ? { workspaceUnchanged: false } : {}),
    });
  }
}

function batchKey(trigger: "startup" | "meta-change"): string {
  return trigger;
}

function triggerForBatchKey(key: string): "startup" | "meta-change" {
  return key === "startup" ? "startup" : "meta-change";
}

function mergeOrigins(
  requests: readonly PendingRequest[]
): ReadonlyMap<string, InstallReviewOrigin> {
  const merged = new Map<string, InstallReviewOrigin>();
  for (const request of requests) {
    for (const [repo, origin] of request.origins ?? []) merged.set(repo, origin);
  }
  return merged;
}

function distinctUnits(units: readonly ReviewedUnit[]): ReviewedUnit[] {
  const distinct = new Map<string, ReviewedUnit>();
  for (const unit of units) {
    const key = `${unit.source.repo}\0${unit.ev ?? ""}`;
    if (!distinct.has(key)) distinct.set(key, unit);
  }
  return [...distinct.values()];
}

function mergeIdentityKeys(requests: readonly PendingRequest[]): ReadonlyMap<string, string> {
  const merged = new Map<string, string>();
  for (const request of requests) {
    for (const [repo, identity] of request.identityKeys ?? []) merged.set(repo, identity);
  }
  return merged;
}

function mergePresentation(requests: readonly PendingRequest[]): ReviewPresentation | undefined {
  const presentations = requests.flatMap((request) =>
    request.presentation ? [request.presentation] : []
  );
  if (presentations.length === 0) return undefined;
  const first = presentations[0]!;
  return {
    ...first,
    onPublished: (review) => {
      for (const presentation of presentations) presentation.onPublished?.(review);
    },
  };
}

function assertCompatiblePresentation(
  requests: readonly PendingRequest[],
  candidate?: ReviewPresentation
): void {
  if (!candidate) return;
  const existing = requests.find((request) => request.presentation)?.presentation;
  if (
    existing &&
    (candidate.callerId !== existing.callerId ||
      candidate.title !== existing.title ||
      candidate.description !== existing.description ||
      candidate.dedupKey !== existing.dedupKey)
  ) {
    throw new Error("A workspace unit review cannot have conflicting presentations");
  }
}

function applyOrder(requests: PendingRequest[]): PendingRequest[] {
  return [...requests].sort((a, b) => requestApplyRank(a) - requestApplyRank(b));
}

function requestApplyRank(request: PendingRequest): number {
  return request.entries.some((entry) => entry.unitKind === "extension") ? 0 : 1;
}

/**
 * The launch gate's own heading (§7.6.2). It reads as one question because that
 * is the only question this surface asks: whose code is this, and do I want it
 * running on my computer?
 */
function reviewTitle(_units: ReviewedUnit[]): string {
  return "Start this workspace?";
}

function reviewDescription(units: ReviewedUnit[]): string {
  return `Vibestudio needs to run ${units.length} program${units.length === 1 ? "" : "s"} on this computer.`;
}
