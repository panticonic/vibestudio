import type { LifecyclePrepareInput } from "./doDispatcher.js";

/** Activation-local ownership of one host lifecycle preparation. Cancellation
 * restores admission only before resource release has actually begun. */
export class LifecyclePreparation {
  private current: { epoch: string; releaseStarted: boolean } | null = null;
  private cancelledEpoch: string | null = null;

  advance(input: LifecyclePrepareInput): void {
    if (input.phase === "quiesce") {
      if (this.current && this.current.epoch !== input.epoch)
        throw new Error("Lifecycle preparation belongs to another epoch");
      if (this.current?.releaseStarted)
        throw new Error("Lifecycle resource release has already begun");
      this.current ??= { epoch: input.epoch, releaseStarted: false };
      return;
    }
    if (input.phase === "cancel" && !this.current && this.cancelledEpoch === input.epoch) return;
    if (!this.current || this.current.epoch !== input.epoch)
      throw new Error("Lifecycle phase does not own the active preparation epoch");
    if (input.phase === "cancel" && this.current.releaseStarted)
      throw new Error("Lifecycle cancellation cannot reopen released resources");
    if (input.phase === "release") this.current.releaseStarted = true;
  }

  cancelled(input: LifecyclePrepareInput): void {
    this.advance(input);
    this.current = null;
    this.cancelledEpoch = input.epoch;
  }

  resumed(): void {
    this.current = null;
    this.cancelledEpoch = null;
  }
}
