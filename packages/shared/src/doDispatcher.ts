import type { AgentExecutionTestPolicy } from "@vibestudio/rpc";

/** Stable Durable Object identity used by host services. */
export interface DORef {
  /** Workspace-relative source path, for example `workers/agent-worker`. */
  source: string;
  /** Durable Object class name within the source. */
  className: string;
  /** Stable instance key within the class. */
  objectKey: string;
}

/** Lifecycle release delivered by the host before an activation disappears. */
export interface LifecyclePrepareInput {
  epoch: string;
  /** Preserve durable state for resume, or perform terminal entity release. */
  mode: "suspend" | "retire";
  reason: string;
  /** Remaining preparation budget; zero means the caller imposes no deadline. */
  deadlineMs: number;
}

/** Receipt returned only after the activation's owned resources are released. */
export interface LifecyclePrepareResult {
  status: "ready" | "failed";
  detail?: unknown;
}

export interface LifecycleResumeInput {
  epoch: string;
  previousGeneration: number | null;
  currentGeneration: number;
  reason: "planned" | "crash" | "server_restart";
}

/**
 * Minimal service-facing DO dispatch contract.
 *
 * Transport setup, retry wiring, credentials, and workerd lifecycle remain
 * private to the server's concrete `DODispatch` implementation.
 */
export interface DoDispatcher {
  dispatch(ref: DORef, method: string, ...args: unknown[]): Promise<unknown>;
}

/** Long-running dispatch capability needed only by eval execution. */
export interface HeldDoDispatcher extends DoDispatcher {
  dispatchHeld(ref: DORef, method: string, ...args: unknown[]): Promise<unknown>;
}

/** Lifecycle capability needed only by the lifecycle driver. */
export interface LifecycleDoDispatcher extends DoDispatcher {
  dispatchLifecycle(
    ref: DORef,
    method: "prepare",
    arg: LifecyclePrepareInput
  ): Promise<LifecyclePrepareResult>;
  dispatchLifecycle(ref: DORef, method: "resume", arg: LifecycleResumeInput): Promise<void>;
}

/** Alarm capability needed only by the alarm driver. */
export interface DoAlarmSchedule {
  /** Absolute Unix epoch time in milliseconds. */
  wakeAt: number;
}

/**
 * The complete scheduling decision made by one alarm invocation.
 *
 * Alarm handlers return this decision to their driver instead of calling back
 * through the host while the alarm dispatch is still active. The driver is the
 * sole writer of the durable alarm row for that dispatch.
 */
export interface DoAlarmDispatchResult {
  nextAlarm: DoAlarmSchedule | null;
}

export function isDoAlarmDispatchResult(value: unknown): value is DoAlarmDispatchResult {
  if (typeof value !== "object" || value === null || !("nextAlarm" in value)) return false;
  const nextAlarm = (value as { nextAlarm?: unknown }).nextAlarm;
  if (nextAlarm === null) return true;
  if (typeof nextAlarm !== "object" || nextAlarm === null) return false;
  const schedule = nextAlarm as { wakeAt?: unknown };
  return (
    typeof schedule.wakeAt === "number" &&
    Number.isSafeInteger(schedule.wakeAt) &&
    schedule.wakeAt >= 0
  );
}

export interface AlarmDoDispatcher extends DoDispatcher {
  /**
   * Deliver one scheduler-owned alarm invocation. The optional signal cancels
   * only this transport attempt when the scheduler is quiesced; the durable
   * alarm row remains the source of truth until a completed result is
   * acknowledged.
   */
  dispatchAlarm(
    ref: DORef,
    signal?: AbortSignal,
    testPolicy?: AgentExecutionTestPolicy
  ): Promise<DoAlarmDispatchResult>;
}
