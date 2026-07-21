import type { UnitApprovalCoordinator, UnitApprovalDecision } from "@vibestudio/unit-host";
import type { PendingUnitBatchApproval, UnitBatchEntry } from "@vibestudio/shared/approvals";

export interface UnitApprovalQueueLike {
  request(req: {
    kind: "unit-batch";
    callerId: string;
    callerKind: "system";
    repoPath: string;
    effectiveVersion: string;
    dedupKey?: string | null;
    trigger: PendingUnitBatchApproval["trigger"];
    title: string;
    description: string;
    units: PendingUnitBatchApproval["units"];
    configWrite?: PendingUnitBatchApproval["configWrite"];
  }): Promise<UnitApprovalDecision>;
}

interface PendingRequest {
  entries: UnitBatchEntry[];
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
  entries: UnitBatchEntry[];
  settlement: Promise<void>;
}

type UnitApprovalEntrySelector = (entry: UnitBatchEntry) => boolean;

export class ServerUnitApprovalCoordinator implements UnitApprovalCoordinator<UnitBatchEntry> {
  private pending = new Map<"startup" | "meta-change", PendingBatch>();
  private active = new Map<"startup" | "meta-change", Set<ActiveRequest>>();

  constructor(
    private readonly deps: {
      approvalQueue: UnitApprovalQueueLike;
      delayMs?: number;
      autoApproveStartupUnits?: boolean;
    }
  ) {}

  enqueue(request: {
    entries: UnitBatchEntry[];
    trigger: "startup" | "meta-change";
    applyApproved(): Promise<void>;
    applyDenied(): void;
  }): Promise<void> {
    if (request.entries.length === 0) {
      return request.applyApproved();
    }
    let batch = this.pending.get(request.trigger);
    if (!batch) {
      batch = { trigger: request.trigger, requests: [], timer: null };
      this.pending.set(request.trigger, batch);
      batch.timer = setTimeout(() => {
        void this.publishPending(request.trigger).catch(() => {
          // Every enqueued request receives the same error through its own
          // promise. Avoid a second unhandled rejection from the timer-owned
          // publication promise.
        });
      }, this.deps.delayMs ?? 0);
    }
    return new Promise<void>((resolve, reject) => {
      batch.requests.push({ ...request, resolve, reject });
    });
  }

  publishPending(
    trigger?: "startup" | "meta-change",
    matches?: UnitApprovalEntrySelector
  ): Promise<void> {
    const triggers = trigger
      ? [trigger]
      : Array.from(new Set([...this.pending.keys(), ...this.active.keys()]));

    // Starting a batch is deliberately synchronous through approvalQueue.request:
    // callers may inspect the queue immediately after this method returns to
    // distinguish a human decision from unattended activation. The returned
    // promise represents only matching unit applications, not unrelated work
    // which happened to share the same startup trigger.
    for (const candidate of triggers) this.startPendingBatch(candidate);

    const settlements = triggers.flatMap((candidate) =>
      [...(this.active.get(candidate) ?? [])]
        .filter((request) => !matches || request.entries.some(matches))
        .map((request) => request.settlement)
    );
    return Promise.all(settlements).then(() => undefined);
  }

  private startPendingBatch(trigger: "startup" | "meta-change"): void {
    const batch = this.pending.get(trigger);
    if (!batch) return;
    this.pending.delete(trigger);
    if (batch.timer) clearTimeout(batch.timer);
    const requests = batch.requests;
    const units = requests.flatMap((request) => request.entries);
    let decision: Promise<UnitApprovalDecision>;
    try {
      decision =
        trigger === "startup" && this.deps.autoApproveStartupUnits
          ? Promise.resolve("once")
          : this.deps.approvalQueue.request({
              kind: "unit-batch",
              callerId: "system:units",
              callerKind: "system",
              repoPath: "meta",
              effectiveVersion: "",
              trigger,
              title: unitBatchTitle(units, trigger),
              description: unitBatchDescription(units),
              units,
              configWrite: null,
            });
    } catch (error) {
      decision = Promise.reject(error);
    }

    const active = this.active.get(trigger) ?? new Set<ActiveRequest>();
    this.active.set(trigger, active);
    for (const request of applyOrder(requests)) {
      const tracked: ActiveRequest = {
        entries: request.entries,
        settlement: Promise.resolve(decision)
          .then(async (resolvedDecision) => {
            if (resolvedDecision === "deny") request.applyDenied();
            else await request.applyApproved();
            request.resolve();
          })
          .catch((error: unknown) => {
            request.reject(error);
            throw error;
          }),
      };
      active.add(tracked);
      void tracked.settlement
        .finally(() => {
          active.delete(tracked);
          if (active.size === 0 && this.active.get(trigger) === active) {
            this.active.delete(trigger);
          }
        })
        .catch(() => {
          // The publication promise and the enqueue promise independently
          // expose the same failure to their respective owners.
        });
    }
  }
}

function applyOrder(requests: PendingRequest[]): PendingRequest[] {
  return [...requests].sort((a, b) => requestApplyRank(a) - requestApplyRank(b));
}

function requestApplyRank(request: PendingRequest): number {
  return request.entries.some((entry) => entry.unitKind === "extension") ? 0 : 1;
}

function unitBatchTitle(units: UnitBatchEntry[], trigger: "startup" | "meta-change"): string {
  const hasApps = units.some((unit) => unit.unitKind === "app");
  const hasExtensions = units.some((unit) => unit.unitKind === "extension");
  if (hasApps && hasExtensions) {
    return trigger === "meta-change" ? "Workspace units changed" : "Approve workspace units";
  }
  if (hasApps)
    return trigger === "meta-change" ? "Workspace apps changed" : "Approve workspace apps";
  return trigger === "meta-change"
    ? "Workspace extensions changed"
    : "Approve workspace extensions";
}

function unitBatchDescription(units: UnitBatchEntry[]): string {
  const appCount = units.filter((unit) => unit.unitKind === "app").length;
  const extensionCount = units.filter((unit) => unit.unitKind === "extension").length;
  const parts: string[] = [];
  if (extensionCount > 0) {
    parts.push(
      `${extensionCount} extension${extensionCount === 1 ? "" : "s"} that run as native code`
    );
  }
  if (appCount > 0) {
    parts.push(`${appCount} privileged app${appCount === 1 ? "" : "s"} that run in the app host`);
  }
  return parts.length > 0
    ? `This workspace declares ${parts.join(" and ")}.`
    : "This push changes workspace configuration.";
}
