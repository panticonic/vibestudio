import type { UnitApprovalCoordinator } from "@vibestudio/unit-host";
import type {
  PendingApproval,
  PendingUnitInstallReviewApproval,
  ReviewedUnit,
} from "@vibestudio/shared/approvals";
import type { InstallReviewOrigin } from "@vibestudio/shared/authority/unitInstallReview";
import type { ApprovalQueueDecision, InstallLandingReport } from "./services/approvalQueue.js";

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
    reportsLanding?: boolean;
    charters?: PendingUnitInstallReviewApproval["charters"];
    configWrite?: PendingUnitInstallReviewApproval["configWrite"];
  }): { approvalId: string; decision: Promise<ApprovalQueueDecision> };
  listPending(): PendingApproval[];
  reportInstallLanding?(approvalId: string, report: InstallLandingReport): void;
}

interface PendingRequest {
  entries: ReviewedUnit[];
  batchKey?: string;
  origins?: ReadonlyMap<string, InstallReviewOrigin>;
  applyApproved(): Promise<void>;
  applyDenied(): void;
  resolve(): void;
  reject(error: unknown): void;
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

  constructor(
    private readonly deps: {
      approvalQueue: UnitApprovalQueueLike;
      delayMs?: number;
      /** Startup has an explicit staging barrier so every unit shares one prompt. */
      autoPublishStartup?: boolean;
    }
  ) {}

  enqueue(request: {
    entries: ReviewedUnit[];
    trigger: "startup" | "meta-change";
    batchKey?: string;
    origins?: ReadonlyMap<string, InstallReviewOrigin>;
    applyApproved(): Promise<void>;
    applyDenied(): void;
  }): Promise<void> {
    if (request.entries.length === 0) {
      return request.applyApproved();
    }
    const versionless = request.entries.find((entry) => !entry.ev);
    if (versionless) {
      throw new Error(
        `Cannot offer install review for ${versionless.source.repo} without an effective version`
      );
    }
    const key = batchKey(request.trigger, request.batchKey);
    let batch = this.pending.get(key);
    if (!batch) {
      batch = { trigger: request.trigger, requests: [], timer: null };
      this.pending.set(key, batch);
      if (
        request.trigger !== "startup" ||
        this.deps.autoPublishStartup !== false ||
        this.released.has(request.trigger)
      ) {
        batch.timer = setTimeout(() => {
          void this.publishPending(request.trigger, undefined, request.batchKey).catch(() => {
            // Every enqueued request receives the same error through its own
            // promise. Avoid a second unhandled rejection from the timer-owned
            // publication promise.
          });
        }, this.deps.delayMs ?? 0);
      }
    }
    return new Promise<void>((resolve, reject) => {
      batch.requests.push({ ...request, resolve, reject });
    });
  }

  publishPending(
    trigger?: "startup" | "meta-change",
    matches?: UnitApprovalEntrySelector,
    requestedBatchKey?: string
  ): Promise<void> {
    const keys = trigger
      ? requestedBatchKey !== undefined
        ? [batchKey(trigger, requestedBatchKey)]
        : [...this.pending.keys(), ...this.active.keys()].filter((key) =>
            key.startsWith(`${trigger}\0`)
          )
      : Array.from(new Set([...this.pending.keys(), ...this.active.keys()]));

    // Starting a batch is deliberately synchronous through approvalQueue.request:
    // callers may inspect the queue immediately after this method returns to
    // distinguish a human decision from unattended activation. The returned
    // promise represents only matching unit applications, not unrelated work
    // which happened to share the same startup trigger.
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
    const units = requests.flatMap((request) => request.entries);
    const origins = mergeOrigins(requests);
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
    try {
      const handle = this.deps.approvalQueue.requestWithHandle({
        kind: "unit-install-review",
        callerId: "system:units",
        callerKind: "system",
        repoPath: "meta",
        effectiveVersion: "",
        // Reconciling declared units is an arrival of code like any other; the
        // heading and rows come from the parts themselves, not from a trigger.
        mode: trigger === "startup" ? "adopt-root" : "install",
        title: reviewTitle(units),
        description: reviewDescription(units),
        units,
        ...(origins.size > 0 ? { origins } : {}),
        ...(this.canReportLanding() ? { reportsLanding: true } : {}),
        configWrite: null,
      });
      decision = handle.decision;
      approvalId = handle.approvalId;
      const pending = this.deps.approvalQueue
        .listPending()
        .find((entry) => entry.approvalId === approvalId);
      if (pending?.kind === "unit-install-review") approvalParts = pending.parts;
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
              request.resolve();
            } else if (resolvedDecision === "accepted") {
              acceptedDecision = true;
              try {
                await request.applyApproved();
                for (const entry of request.entries) landedEntries.add(entryKey(entry));
                request.resolve();
              } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                for (const entry of request.entries) failedEntries.set(entryKey(entry), reason);
                request.reject(error);
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

function batchKey(trigger: "startup" | "meta-change", key?: string): string {
  return `${trigger}\0${key ?? "default"}`;
}

function triggerForBatchKey(key: string): "startup" | "meta-change" {
  return key.startsWith("startup\0") ? "startup" : "meta-change";
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
