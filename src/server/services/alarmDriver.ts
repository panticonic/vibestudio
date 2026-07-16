import { createDevLogger } from "@vibestudio/dev-log";
import {
  isDoAlarmDispatchResult,
  type AlarmDoDispatcher,
  type DORef,
} from "@vibestudio/shared/doDispatcher";
import { INTERNAL_DO_SOURCE } from "../internalDOs/internalDoLoader.js";
import type { LifecycleKey } from "../internalDOs/workspaceDO.js";

const log = createDevLogger("AlarmDriver");

/** setTimeout caps out near 2^31 ms; clamp longer delays and re-evaluate on wake. */
const MAX_TIMER_MS = 2_000_000_000;
const FAILURE_RETRY_MIN_MS = 1_000;
const FAILURE_RETRY_MAX_MS = 30_000;

export interface AlarmDriverDeps {
  doDispatch: AlarmDoDispatcher;
  workspaceId: string;
  concurrency?: number;
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
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
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

  constructor(deps: AlarmDriverDeps) {
    this.deps = deps;
    this.workspaceRef = {
      source: INTERNAL_DO_SOURCE,
      className: "WorkspaceDO",
      objectKey: deps.workspaceId,
    };
    this.concurrency = deps.concurrency ?? 8;
  }

  /** Load durable alarms and arm the timer. Idempotent; call on boot. */
  start(): void {
    this.stopped = false;
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
    let next: number | null = null;
    try {
      next = await this.dispatchWorkspace<number | null>("alarmNextWakeAt");
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

  /** Returns true only when every due outcome was durably acknowledged. */
  private async fireOnce(): Promise<boolean> {
    if (this.stopped) return false;
    let due: Array<LifecycleKey & { wakeAt: number }> = [];
    try {
      due = await this.dispatchWorkspace<Array<LifecycleKey & { wakeAt: number }>>(
        "alarmListDue",
        Date.now()
      );
    } catch (err) {
      log.warn("alarmListDue failed:", err);
      // Listing never acknowledges consumption. Keep the row and retry it
      // through the driver's one bounded timer; never turn its
      // past wakeAt into a setTimeout(0) transport storm.
      this.armFailureRetry("fire");
      return false;
    }
    this.consecutiveFailures = 0;
    try {
      await this.runPool(due, async (target) => {
        const ref = {
          source: target.source,
          className: target.className,
          objectKey: target.objectKey,
        };
        let result: Awaited<ReturnType<AlarmDoDispatcher["dispatchAlarm"]>>;
        try {
          result = await this.deps.doDispatch.dispatchAlarm(ref);
          if (!isDoAlarmDispatchResult(result)) {
            throw new Error(
              `Invalid alarm dispatch result for ${target.source}:${target.className}`
            );
          }
        } catch (err) {
          // The original due row remains until this replacement succeeds.
          // Re-arm with a short backoff; a destroyed DO keeps its cheap retry
          // row until entity cleanup instead of losing its only wake.
          log.warn(
            `alarm dispatch failed for ${target.source}:${target.className}/${target.objectKey}; re-arming:`,
            err
          );
          await this.dispatchWorkspace("alarmSet", {
            source: target.source,
            className: target.className,
            objectKey: target.objectKey,
            wakeAt: Date.now() + 5_000,
          });
          return;
        }
        // Persist the successful handler outcome outside the dispatch catch.
        // An acknowledgement failure is a storage failure, not a second
        // handler failure; the outer retry keeps the original due row intact.
        if (result.nextAlarm) {
          await this.dispatchWorkspace("alarmSet", {
            ...ref,
            ...result.nextAlarm,
          });
        } else {
          await this.dispatchWorkspace("alarmClear", ref);
        }
      });
    } catch (err) {
      log.warn("alarm outcome acknowledgement failed; durable due rows remain pending:", err);
      this.armFailureRetry("fire");
      return false;
    }
    return true;
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

  private dispatchWorkspace<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    return this.deps.doDispatch.dispatch(this.workspaceRef, method, ...args) as Promise<T>;
  }

  private async runPool<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const workers = Array.from({ length: Math.min(this.concurrency, items.length) }, async () => {
      for (;;) {
        const index = next++;
        const item = items[index];
        if (item === undefined) return;
        await fn(item);
      }
    });
    await Promise.all(workers);
  }
}
