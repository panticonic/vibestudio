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
    method: "prepare" | "resume",
    arg: unknown
  ): Promise<unknown>;
}

/** Alarm capability needed only by the alarm driver. */
export interface AlarmDoDispatcher extends DoDispatcher {
  dispatchAlarm(ref: DORef): Promise<unknown>;
}
