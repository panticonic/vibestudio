import type { DurableWorkQueue } from "@vibestudio/shared/durableWork";

const READY_GENERATION_PREFIX = "durable-work-ready-generation:";
const ACK_GENERATION_PREFIX = "durable-work-ack-generation:";
const ACTIVE_WORKER_KEY = "durable-work-active-worker";
const ACTIVE_ACTIVATION_KEY = "durable-work-active-activation";

export interface DurableWorkReadinessStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  transaction<T>(callback: () => T): T;
}

/** Transport-neutral durable readiness and lease-generation fencing. */
export class DurableWorkReadiness {
  constructor(
    private readonly store: DurableWorkReadinessStore,
    private readonly activationId: string
  ) {}

  markReady(queues: readonly DurableWorkQueue[]): void {
    this.store.transaction(() => {
      for (const queue of new Set(queues)) {
        const key = `${READY_GENERATION_PREFIX}${queue}`;
        this.store.set(key, String(this.generation(key, queue) + 1));
      }
    });
  }

  pendingQueues(queues: readonly DurableWorkQueue[]): DurableWorkQueue[] {
    return queues.filter((queue) => {
      const ready = this.generation(`${READY_GENERATION_PREFIX}${queue}`, queue);
      const acknowledged = this.generation(`${ACK_GENERATION_PREFIX}${queue}`, queue);
      if (acknowledged > ready) throw new Error(`Invalid durable work generations for ${queue}`);
      return ready > acknowledged;
    });
  }

  diagnostics(queues: readonly DurableWorkQueue[]): Array<{
    queue: DurableWorkQueue;
    readyGeneration: number;
    acknowledgedGeneration: number;
    pending: boolean;
  }> {
    return queues.map((queue) => {
      const readyGeneration = this.generation(`${READY_GENERATION_PREFIX}${queue}`, queue);
      const acknowledgedGeneration = this.generation(`${ACK_GENERATION_PREFIX}${queue}`, queue);
      if (acknowledgedGeneration > readyGeneration) {
        throw new Error(`Invalid durable work generations for ${queue}`);
      }
      return {
        queue,
        readyGeneration,
        acknowledgedGeneration,
        pending: readyGeneration > acknowledgedGeneration,
      };
    });
  }

  acknowledge(queue: DurableWorkQueue): void {
    const ready = this.generation(`${READY_GENERATION_PREFIX}${queue}`, queue);
    this.store.set(`${ACK_GENERATION_PREFIX}${queue}`, String(ready));
  }

  adoptWorker(
    workerId: string,
    releaseClaims: (previousWorkerId: string | null, nextWorkerId: string) => void
  ): { adopted: boolean; previousWorkerId: string | null } {
    if (typeof workerId !== "string" || workerId.length < 8 || workerId.length > 512) {
      throw new Error("adoptDurableWorkWorker: invalid worker identity");
    }
    return this.store.transaction(() => {
      const previousWorkerId = this.store.get(ACTIVE_WORKER_KEY);
      const previousActivationId = this.store.get(ACTIVE_ACTIVATION_KEY);
      if (previousWorkerId === workerId && previousActivationId === this.activationId) {
        return { adopted: false, previousWorkerId };
      }
      releaseClaims(previousWorkerId, workerId);
      this.store.set(ACTIVE_WORKER_KEY, workerId);
      this.store.set(ACTIVE_ACTIVATION_KEY, this.activationId);
      return { adopted: true, previousWorkerId };
    });
  }

  private generation(key: string, queue: DurableWorkQueue): number {
    const value = Number(this.store.get(key) ?? 0);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Invalid durable work ready generation for ${queue}`);
    }
    return value;
  }
}
