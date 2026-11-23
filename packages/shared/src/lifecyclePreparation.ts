import type { LifecyclePrepareInput } from "./doDispatcher.js";

export const LIFECYCLE_RELEASED_STATE_KEY = "__lifecycle_resources_released";

export interface LifecycleReleaseStore {
  get(): "started" | "complete" | null;
  set(state: "started" | "complete" | null): void;
}

/** Activation-local ownership of one host lifecycle preparation. Cancellation
 * restores admission only before resource release has actually begun. */
export class LifecyclePreparation {
  private current: { epoch: string; releaseStarted: boolean } | null = null;
  private cancelledEpoch: string | null = null;

  constructor(private readonly releaseStore?: LifecycleReleaseStore) {}

  resourcesReleased(): boolean {
    return this.current?.releaseStarted === true || this.releaseStore?.get() != null;
  }

  releaseCompleted(): boolean {
    return this.releaseStore?.get() === "complete";
  }

  completed(input: LifecyclePrepareInput): void {
    if (input.phase === "release") this.releaseStore?.set("complete");
  }

  advance(input: LifecyclePrepareInput): void {
    if (input.phase === "quiesce") {
      if (this.current && this.current.epoch !== input.epoch)
        throw new Error("Lifecycle preparation belongs to another epoch");
      if (this.current?.releaseStarted && !this.releaseCompleted())
        throw new Error("Lifecycle resource release has already begun");
      this.current ??= { epoch: input.epoch, releaseStarted: this.resourcesReleased() };
      return;
    }
    if (input.phase === "cancel" && !this.current && this.cancelledEpoch === input.epoch) return;
    if (!this.current || this.current.epoch !== input.epoch)
      throw new Error("Lifecycle phase does not own the active preparation epoch");
    if (input.phase === "cancel" && this.current.releaseStarted)
      throw new Error("Lifecycle cancellation cannot reopen released resources");
    if (input.phase === "release") {
      this.current.releaseStarted = true;
      // Retirement survives activation eviction; an archival read must not
      // publish alarms using the released runtime's authority after restart.
      if (!this.releaseCompleted()) this.releaseStore?.set("started");
    }
  }

  cancelled(input: LifecyclePrepareInput): void {
    this.advance(input);
    this.current = null;
    this.cancelledEpoch = input.epoch;
  }

  resumed(): void {
    this.releaseStore?.set(null);
    this.current = null;
    this.cancelledEpoch = null;
  }
}
