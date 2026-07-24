import { randomUUID } from "node:crypto";
import type { DORef, HeldDoDispatcher } from "@vibestudio/shared/doDispatcher";

/** Interactive notebook state remains live for this long after the latest eval cell. */
export const EVAL_KERNEL_IDLE_LEASE_MS = 30 * 60 * 1_000;

interface LiveLease {
  id: string;
  holding: boolean;
}

interface KernelLeaseStatus {
  leaseId: string;
  expiresAt: number;
  holderAttached: boolean;
}

export interface EvalKernelLease {
  touch(ref: DORef): Promise<void>;
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

  constructor(
    private readonly doDispatch: Pick<HeldDoDispatcher, "dispatch" | "dispatchHeld">,
    private readonly options: {
      idleMs?: number;
      onError?: (message: string, error: unknown) => void;
    } = {}
  ) {}

  async touch(ref: DORef): Promise<void> {
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
    let lease = this.leases.get(key);
    if (!lease) {
      lease = { id: randomUUID(), holding: false };
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

    // A holder attached in the EvalDO is the authoritative warm-kernel fact.
    if (status.holderAttached) return;

    // The host still tracking a hold while the object reports none means that
    // hold belongs to an expired/reconstructed lease and its HTTP response has
    // not reached the coordinator yet. Replace the lease identity so the old
    // request's terminal callback cannot delete the new hold.
    if (lease.holding) {
      lease = { id: randomUUID(), holding: false };
      this.leases.set(key, lease);
      status = (await this.doDispatch.dispatch(ref, "acquireKernelLease", {
        leaseId: lease.id,
        idleMs: this.options.idleMs ?? EVAL_KERNEL_IDLE_LEASE_MS,
      })) as KernelLeaseStatus;
      if (status.holderAttached) {
        throw new Error(`fresh eval kernel lease ${lease.id} unexpectedly already has a holder`);
      }
    }

    // Claim the one holder before opening its long request. This quick
    // acknowledgement makes duplicate prevention explicit instead of inferring
    // it from fire-and-forget transport timing.
    await this.doDispatch.dispatch(ref, "attachKernelLeaseHolder", lease.id);
    lease.holding = true;
    void this.doDispatch
      .dispatchHeld(ref, "holdKernelLease", lease.id)
      .catch((error) => {
        (this.options.onError ?? defaultErrorReporter)(
          `Eval kernel lease ${lease.id} for ${key} ended unexpectedly`,
          error
        );
      })
      .finally(() => {
        if (this.leases.get(key) === lease) this.leases.delete(key);
      });
  }
}

function refKey(ref: DORef): string {
  return `${ref.source}\0${ref.className}\0${ref.objectKey}`;
}

function defaultErrorReporter(message: string, error: unknown): void {
  console.warn(message, error instanceof Error ? error.message : error);
}
