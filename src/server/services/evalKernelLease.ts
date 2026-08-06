import { randomUUID } from "node:crypto";
import type { DORef, HeldDoDispatcher } from "@vibestudio/shared/doDispatcher";

/** Interactive notebook state remains live for this long after the latest eval cell. */
export const EVAL_KERNEL_IDLE_LEASE_MS = 30 * 60 * 1_000;

interface LiveLease {
  id: string;
  holding: boolean;
  abortController: AbortController;
  hold?: Promise<unknown>;
}

interface KernelLeaseStatus {
  leaseId: string;
  expiresAt: number;
  holderAttached: boolean;
}

export interface EvalKernelLease {
  touch(ref: DORef): Promise<void>;
  /** Stop host-held residency requests during an ordered server shutdown. */
  close?(): Promise<void>;
}

/**
 * Keeps one deliberately held request open to each active EvalDO.
 *
 * A cell's own held request protects execution only until that cell returns.
 * This separate request owns the notebook kernel's inter-cell lifetime. The
 * EvalDO expires it after an idle interval refreshed by `acquireKernelLease`.
 * A host/workerd restart drops the request, which is intentionally observable
 * as a new kernel incarnation rather than hidden by replay.
 */
export class EvalKernelLeaseCoordinator implements EvalKernelLease {
  private readonly leases = new Map<string, LiveLease>();
  private readonly operations = new Map<string, Promise<void>>();
  private closed = false;

  constructor(
    private readonly doDispatch: Pick<HeldDoDispatcher, "dispatch" | "dispatchHeld"> &
      Partial<Pick<HeldDoDispatcher, "dispatchHeldWithSignal">>,
    private readonly options: {
      idleMs?: number;
      onError?: (message: string, error: unknown) => void;
    } = {}
  ) {}

  async touch(ref: DORef): Promise<void> {
    if (this.closed) throw new Error("eval kernel lease coordinator is closed");
    const key = refKey(ref);
    const previous = this.operations.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.touchLocked(key, ref));
    this.operations.set(key, operation);
    try {
      await operation;
    } finally {
      if (this.operations.get(key) === operation) this.operations.delete(key);
    }
  }

  private async touchLocked(key: string, ref: DORef): Promise<void> {
    if (this.closed) throw new Error("eval kernel lease coordinator is closed");
    let lease = this.leases.get(key);
    if (!lease) {
      lease = { id: randomUUID(), holding: false, abortController: new AbortController() };
      this.leases.set(key, lease);
    }

    let status: KernelLeaseStatus;
    try {
      status = (await this.doDispatch.dispatch(ref, "acquireKernelLease", {
        leaseId: lease.id,
        idleMs: this.options.idleMs ?? EVAL_KERNEL_IDLE_LEASE_MS,
      })) as KernelLeaseStatus;
    } catch (error) {
      if (this.leases.get(key) === lease) this.leases.delete(key);
      throw error;
    }

    // Shutdown may have started while the receiver was processing the
    // admission. Do not claim a holder after quiescence; the close loop is
    // waiting for this operation and lifecycle release will settle any
    // receiver-side lease that the admission already created.
    if (this.closed) {
      if (this.leases.get(key) === lease) this.leases.delete(key);
      return;
    }

    // A holder attached in the EvalDO is the authoritative warm-kernel fact.
    if (status.holderAttached) return;

    // A locally tracked hold with no receiver-side holder belongs to an
    // expired/reconstructed activation whose response has not reached us yet.
    if (lease.holding) {
      lease = { id: randomUUID(), holding: false, abortController: new AbortController() };
      this.leases.set(key, lease);
      status = (await this.doDispatch.dispatch(ref, "acquireKernelLease", {
        leaseId: lease.id,
        idleMs: this.options.idleMs ?? EVAL_KERNEL_IDLE_LEASE_MS,
      })) as KernelLeaseStatus;
      if (status.holderAttached) {
        throw new Error(`fresh eval kernel lease ${lease.id} unexpectedly already has a holder`);
      }
    }

    // Claim the single holder before opening the long request. This is not an
    // alarm activation or durable-work execution lane; it owns only residency.
    await this.doDispatch.dispatch(ref, "attachKernelLeaseHolder", lease.id);
    if (this.closed) {
      if (this.leases.get(key) === lease) this.leases.delete(key);
      return;
    }
    lease.holding = true;
    const hold = this.doDispatch.dispatchHeldWithSignal
      ? this.doDispatch.dispatchHeldWithSignal(
          ref,
          lease.abortController.signal,
          "holdKernelLease",
          lease.id
        )
      : this.doDispatch.dispatchHeld(ref, "holdKernelLease", lease.id);
    lease.hold = hold;
    void hold
      .catch((error) => {
        if (this.closed || lease.abortController.signal.aborted) return;
        (this.options.onError ?? defaultErrorReporter)(
          `Eval kernel lease ${lease.id} for ${key} ended unexpectedly`,
          error
        );
      })
      .finally(() => {
        if (this.leases.get(key) === lease) this.leases.delete(key);
      });
  }

  async close(): Promise<void> {
    this.closed = true;
    // The DO lifecycle release remains the durable cleanup path. Aborting the
    // host leg as soon as shutdown begins is the transport cleanup path: it
    // prevents a 30-minute residency request from keeping workerd alive while
    // lifecycle preparation is releasing the corresponding DO holder.
    // Drain in rounds instead of taking one snapshot. A touch that was already
    // admitted when close() began can finish its acquire/attach sequence after
    // the first snapshot; that late hold is still owned by this coordinator and
    // must be aborted and awaited before close returns.
    for (;;) {
      const operations = [...this.operations.values()];
      const leases = [...this.leases.values()];
      const holds = leases
        .map((lease) => lease.hold)
        .filter((hold): hold is Promise<unknown> => hold !== undefined);
      for (const lease of leases) lease.abortController.abort();
      await Promise.allSettled([...operations, ...holds]);
      if (this.operations.size === 0 && this.leases.size === 0) return;
    }
  }
}

function refKey(ref: DORef): string {
  return `${ref.source}\0${ref.className}\0${ref.objectKey}`;
}

function defaultErrorReporter(message: string, error: unknown): void {
  console.warn(message, error instanceof Error ? error.message : error);
}
