import { createDevLogger } from "@vibestudio/dev-log";
import {
  isDoAlarmDispatchResult,
  type AlarmDoDispatcher,
  type DORef,
} from "@vibestudio/shared/doDispatcher";
import type { AgentExecutionTestPolicy } from "@vibestudio/rpc";
import { INTERNAL_DO_SOURCE } from "../internalDOs/internalDoLoader.js";
import type { LifecycleKey } from "@panticonic/builtin/workspace-state";
import { isPermanentRuntimeReadinessError } from "../runtimeReadinessError.js";

const log = createDevLogger("AlarmDriver");

/** setTimeout caps out near 2^31 ms; clamp longer delays and re-evaluate on wake. */
const MAX_TIMER_MS = 2_000_000_000;
const FAILURE_RETRY_MIN_MS = 1_000;
const FAILURE_RETRY_MAX_MS = 30_000;

type AlarmClaim = LifecycleKey & {
  wakeAt: number;
  dispatchGeneration: number;
  testPolicy?: AgentExecutionTestPolicy;
};

export interface AlarmDriverDeps {
  doDispatch: AlarmDoDispatcher;
  workspaceId: string;
  concurrency?: number;
  workerId?: string;
  isAuthorityPaused?: (ref: DORef) => boolean;
  onStateChange?: (event: {
    ref: DORef;
    state: "pending" | "claimed" | "blocked" | "cleared";
    wakeAt?: number;
    reason?: string;
  }) => void;
}

/**
 * Server-driven DO alarms. workerd does not implement alarms for SQLite-backed
 * Durable Objects (and never for facets), so wake times live durably in
 * WorkspaceDO (`do_alarms`) and this driver fires `__alarm` on schedule.
 *
 * A single timer tracks the soonest pending wake. On fire it lists due alarms
 * without consuming them, dispatches `__alarm` to each, then acknowledges each
 * outcome by replacing or clearing its durable row. Survives server/workerd
 * restart: `start()` reloads from durable storage.
 */
export class AlarmDriver {
  private readonly deps: AlarmDriverDeps;
  private readonly workspaceRef: DORef;
  private readonly concurrency: number;
  private readonly workerId: string;
  private adopted = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Admission is closed until start() runs after runtime restoration. */
  private stopped = true;
  /**
   * One scheduler operation owns the driver at a time. Requests are booleans,
   * not a promise chain, so a burst of alarm mutations coalesces to one refresh.
   */
  private driving: Promise<void> | null = null;
  private refreshRequested = false;
  private fireRequested = false;
  /** A failed scheduler operation owns the timer until its bounded retry. */
  private failureRetryOperation: "refresh" | "fire" | null = null;
  private consecutiveFailures = 0;
  /** Transport attempts currently owned by this scheduler activation. */
  private readonly activeDispatches = new Set<AbortController>();
  /** Per-target lane occupancy. A target is never admitted twice concurrently. */
  private readonly activeTargets = new Map<string, LifecycleKey>();
  /** Dispatch and acknowledgement boundaries that quiesce must observe. */
  private readonly activeLanes = new Set<Promise<void>>();

  constructor(deps: AlarmDriverDeps) {
    this.deps = deps;
    this.workspaceRef = {
      source: INTERNAL_DO_SOURCE,
      className: "WorkspaceDO",
      objectKey: deps.workspaceId,
    };
    this.concurrency = deps.concurrency ?? 8;
    this.workerId = deps.workerId ?? `alarm-driver:${crypto.randomUUID()}`;
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1) {
      throw new Error("AlarmDriver concurrency must be a positive integer");
    }
  }

  /** Load durable alarms and arm the timer. Idempotent; call on boot. */
  start(): void {
    this.stopped = false;
    this.adopted = false;
    this.requestRefresh();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.refreshRequested = false;
    this.fireRequested = false;
    this.failureRetryOperation = null;
    this.consecutiveFailures = 0;
    const reason = new Error("alarm scheduler quiesced");
    for (const controller of this.activeDispatches) controller.abort(reason);
  }

  /**
   * Close admission, cancel scheduler-owned transports, and wait until the one
   * driving operation has relinquished ownership. Interrupted alarms are not
   * acknowledged or re-armed here: their existing durable rows are recovered
   * by the next scheduler activation.
   */
  async quiesce(): Promise<void> {
    this.stop();
    await this.driving;
    await Promise.allSettled([...this.activeLanes]);
  }

  /** Re-evaluate the next wake time. Call after any alarm set/clear. */
  notifyChanged(): void {
    this.requestRefresh();
  }

  private requestRefresh(): void {
    if (this.stopped) return;
    this.refreshRequested = true;
    if (this.failureRetryOperation) return;
    this.kick();
  }

  private requestFire(): void {
    if (this.stopped) return;
    this.fireRequested = true;
    this.kick();
  }

  private kick(): void {
    if (this.stopped || this.driving || this.failureRetryOperation) return;
    const run = this.drive();
    this.driving = run;
    void run.finally(() => {
      if (this.driving === run) this.driving = null;
      if (!this.stopped && (this.fireRequested || this.refreshRequested)) this.kick();
    });
  }

  private async drive(): Promise<void> {
    while (!this.stopped) {
      // A timer that already fired wins over a later mutation notification. A
      // successful fire always performs one fresh schedule read afterwards.
      if (this.fireRequested) {
        this.fireRequested = false;
        this.refreshRequested = false;
        if (await this.fireOnce()) this.refreshRequested = true;
        continue;
      }
      if (!this.refreshRequested) return;
      this.refreshRequested = false;
      await this.refreshTimer();
    }
  }

  private async refreshTimer(): Promise<void> {
    if (this.stopped) return;
    if (!(await this.ensureAdopted())) return;
    if (this.activeLanes.size >= this.concurrency) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      return;
    }
    let next: number | null = null;
    try {
      next = await this.dispatchWorkspace<number | null>("alarmNextWakeAt", Date.now(), [
        ...this.activeTargets.values(),
      ]);
    } catch (err) {
      // The durable row remains intact. Recovery uses the driver's one owned
      // timer, never a detached retry or recursive zero-delay reschedule.
      log.warn("alarmNextWakeAt failed; scheduler remains durably pending:", err);
      this.armFailureRetry("refresh");
      return;
    }
    if (this.stopped) return;
    this.consecutiveFailures = 0;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (next === null) return;
    const delay = Math.max(0, Math.min(MAX_TIMER_MS, next - Date.now()));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.requestFire();
    }, delay);
  }

  /** Claims due rows and admits their dispatch lanes without awaiting them. */
  private async fireOnce(): Promise<boolean> {
    if (this.stopped) return false;
    if (!(await this.ensureAdopted())) return false;
    const available = this.concurrency - this.activeLanes.size;
    if (available <= 0) return true;
    let due: AlarmClaim[] = [];
    try {
      due = await this.dispatchWorkspace<AlarmClaim[]>("alarmClaimDue", {
        now: Date.now(),
        workerId: this.workerId,
        limit: available,
        exclude: [...this.activeTargets.values()],
      });
    } catch (err) {
      log.warn("alarmClaimDue failed:", err);
      // Claim failure never acknowledges consumption. Keep the row and retry it
      // through the driver's one bounded timer; never turn its
      // past wakeAt into a setTimeout(0) transport storm.
      this.armFailureRetry("fire");
      return false;
    }
    this.consecutiveFailures = 0;
    for (const target of due) this.startLane(target);
    return true;
  }

  private startLane(target: AlarmClaim): void {
    const key = this.targetKey(target);
    if (this.activeTargets.has(key)) {
      throw new Error(`alarmClaimDue returned active target ${key}`);
    }
    this.activeTargets.set(key, target);
    const lane = this.runLane(target);
    this.activeLanes.add(lane);
    void lane.finally(() => {
      this.activeLanes.delete(lane);
      this.activeTargets.delete(key);
      if (!this.stopped) this.requestRefresh();
    });
  }

  private async runLane(target: AlarmClaim): Promise<void> {
    const ref = {
      source: target.source,
      className: target.className,
      objectKey: target.objectKey,
    };
    const claim = {
      dispatchOwner: this.workerId,
      dispatchGeneration: target.dispatchGeneration,
    };
    this.deps.onStateChange?.({ ref, state: "claimed", wakeAt: target.wakeAt });
    try {
      if (this.deps.isAuthorityPaused?.(ref)) {
        const wakeAt = Date.now() + 60_000;
        await this.dispatchWorkspace("alarmSet", {
          ...ref,
          ...claim,
          wakeAt,
        });
        this.deps.onStateChange?.({ ref, state: "pending", wakeAt, reason: "authority-paused" });
        log.info(
          `state=paused authority lock deferred ${target.source}:${target.className}/${target.objectKey}`
        );
        return;
      }
      let result: Awaited<ReturnType<AlarmDoDispatcher["dispatchAlarm"]>>;
      const controller = new AbortController();
      this.activeDispatches.add(controller);
      try {
        result = await this.deps.doDispatch.dispatchAlarm(
          ref,
          controller.signal,
          target.testPolicy
        );
        if (!isDoAlarmDispatchResult(result)) {
          throw new Error(`Invalid alarm dispatch result for ${target.source}:${target.className}`);
        }
      } catch (err) {
        if (this.stopped && controller.signal.aborted) return;
        if (isPermanentRuntimeReadinessError(err)) {
          // The claimed row remains durable and owned by this scheduler
          // generation. Rewriting its wake time would create an endless retry
          // loop for an immutable integrity failure. A replacement generation
          // adopts the row after the artifact/provider has been repaired.
          log.warn(
            `state=blocked alarm target ${target.source}:${target.className}/${target.objectKey}; ` +
              "sealed execution is unavailable and the durable claim remains pending:",
            err
          );
          this.deps.onStateChange?.({
            ref,
            state: "blocked",
            reason: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        log.warn(
          `alarm dispatch failed for ${target.source}:${target.className}/${target.objectKey}; re-arming:`,
          err
        );
        const wakeAt = Date.now() + 5_000;
        await this.dispatchWorkspace("alarmSet", {
          ...ref,
          ...claim,
          wakeAt,
        });
        this.deps.onStateChange?.({ ref, state: "pending", wakeAt, reason: "dispatch-failed" });
        return;
      } finally {
        this.activeDispatches.delete(controller);
      }
      if (result.nextAlarm) {
        await this.dispatchWorkspace("alarmSet", {
          ...ref,
          ...claim,
          ...result.nextAlarm,
        });
        this.deps.onStateChange?.({ ref, state: "pending", wakeAt: result.nextAlarm.wakeAt });
      } else {
        await this.dispatchWorkspace("alarmClear", { ...ref, ...claim });
        this.deps.onStateChange?.({ ref, state: "cleared" });
      }
    } catch (err) {
      // Acknowledgement failure leaves the durable claim intact. Only explicit
      // adoption by the next scheduler generation can release it.
      log.warn(
        `alarm outcome acknowledgement failed for ${target.source}:${target.className}/${target.objectKey}; durable claim remains pending:`,
        err
      );
    }
  }

  private armFailureRetry(operation: "refresh" | "fire"): void {
    if (this.stopped) return;
    this.consecutiveFailures++;
    this.failureRetryOperation = operation;
    const delay = Math.min(
      FAILURE_RETRY_MAX_MS,
      FAILURE_RETRY_MIN_MS * 2 ** Math.min(this.consecutiveFailures - 1, 30)
    );
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.failureRetryOperation = null;
      if (operation === "fire") this.requestFire();
      else this.requestRefresh();
    }, delay);
  }

  private async ensureAdopted(): Promise<boolean> {
    if (this.adopted) return true;
    try {
      await this.dispatchWorkspace("alarmAdoptWorker", this.workerId);
      if (this.stopped) return false;
      this.adopted = true;
      return true;
    } catch (error) {
      log.warn("alarm scheduler generation adoption failed:", error);
      this.armFailureRetry("refresh");
      return false;
    }
  }

  private dispatchWorkspace<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    return this.deps.doDispatch.dispatch(this.workspaceRef, method, ...args) as Promise<T>;
  }

  private targetKey(key: LifecycleKey): string {
    return `${key.source}\u0000${key.className}\u0000${key.objectKey}`;
  }
}
