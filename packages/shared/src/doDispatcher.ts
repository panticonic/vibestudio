import type { EntityCloneProvenance } from "./runtime/entitySpec.js";
import type { AgentExecutionTestPolicy, RpcFailure } from "@vibestudio/rpc";

/** Stable Durable Object identity used by host services. */
export interface DORef {
  /** Workspace-relative source path, for example `workers/agent-worker`. */
  source: string;
  /** Durable Object class name within the source. */
  className: string;
  /** Stable instance key within the class. */
  objectKey: string;
}

/**
 * The request crossed the local dispatch boundary, but the host did not receive
 * a trustworthy acknowledgement. Callers may retry only operations whose
 * identity makes replay safe.
 */
export class AmbiguousDoDispatchError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", {
        value: cause,
        writable: true,
        configurable: true,
      });
    }
    this.name = "AmbiguousDoDispatchError";
  }
}

/** Lifecycle release delivered by the host before an activation disappears. */
export interface LifecyclePrepareInput {
  epoch: string;
  /** Stop admission, settle peer-facing obligations, then close owned resources. */
  phase: "quiesce" | "peer-obligations" | "release" | "cancel";
  mode: "suspend" | "retire";
  reason: string;
  deadlineMs: number;
}

/** Validate the positional RPC value before a lifecycle phase can advance. */
export function parseLifecyclePrepareInput(value: unknown): LifecyclePrepareInput {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Lifecycle prepare requires an input object");
  const input = value as Record<string, unknown>;
  const epoch = input["epoch"];
  const phase = input["phase"];
  const mode = input["mode"];
  const reason = input["reason"];
  const deadlineMs = input["deadlineMs"];
  if (typeof epoch !== "string" || epoch.length === 0)
    throw new Error("Lifecycle prepare requires an epoch");
  if (phase !== "quiesce" && phase !== "peer-obligations" && phase !== "release")
    throw new Error("Lifecycle prepare requires a valid phase");
  if (mode !== "suspend" && mode !== "retire")
    throw new Error("Lifecycle prepare requires a valid mode");
  if (typeof reason !== "string") throw new Error("Lifecycle prepare requires a reason");
  if (typeof deadlineMs !== "number" || !Number.isSafeInteger(deadlineMs) || deadlineMs < 0)
    throw new Error("Lifecycle prepare requires a nonnegative deadline");
  return { epoch, phase, mode, reason, deadlineMs };
}

/** Receipt returned only after the activation's owned resources are released. */
export type LifecyclePrepareResult =
  | { status: "ready" }
  | { status: "failed"; failure: RpcFailure };

export interface LifecycleResumeInput {
  epoch: string;
  previousGeneration: number | null;
  currentGeneration: number;
  reason: "planned" | "crash" | "server_restart";
}

/** Host-owned storage preparation, completed before an incarnation becomes active. */
export interface LifecycleCloneInput {
  provenance: EntityCloneProvenance;
  source: DORef;
  sourceContextId: string;
  target: DORef;
  targetContextId: string;
  authoritySessionId: string;
  buildKey: string;
  executionDigest: string;
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
  dispatchHeldWithSignal(
    ref: DORef,
    signal: AbortSignal,
    method: string,
    ...args: unknown[]
  ): Promise<unknown>;
}

/** Lifecycle capability needed only by the lifecycle driver. */
export interface LifecycleDoDispatcher extends DoDispatcher {
  dispatchLifecycle(
    ref: DORef,
    method: "prepare",
    arg: LifecyclePrepareInput
  ): Promise<LifecyclePrepareResult>;
  dispatchLifecycle(ref: DORef, method: "resume", arg: LifecycleResumeInput): Promise<void>;
  dispatchLifecycle(ref: DORef, method: "initializeClone", arg: LifecycleCloneInput): Promise<void>;
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
