import type { SupervisionChange } from "@vibestudio/shared/events";
import type { SupervisionEvents } from "@vibestudio/client-host-core";

/**
 * The host's own fan-out of the server's `supervision:changed`. The System
 * workspace runtime holds the one server watch for the life of the host, so an
 * observer attaching or leaving needs no subscription of its own: it only
 * listens to what the runtime already delivers.
 */
export class SupervisionRelay implements SupervisionEvents {
  private readonly listeners = new Set<(change: SupervisionChange) => void>();

  on(_event: "supervision:changed", listener: (change: SupervisionChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async subscribe(_event: "supervision:changed"): Promise<void> {}

  async unsubscribe(_event: "supervision:changed"): Promise<void> {}

  /** The runtime delivered a change. A listener's failure never hides it from the others. */
  emit(change: SupervisionChange): void {
    const failures: unknown[] = [];
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Supervision listeners failed");
  }
}
