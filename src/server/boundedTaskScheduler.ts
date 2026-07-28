/**
 * Small FIFO scheduler for expensive asynchronous lifecycles.
 *
 * The task occupies a slot until its promise settles. This is intentionally
 * stronger than limiting only the first I/O call: callers can use it to bound
 * an entire readiness lifecycle so completed resources are not evicted while
 * older readiness waiters are still trying to claim them.
 */
export class BoundedTaskScheduler {
  private active = 0;
  private readonly pending: Array<() => void> = [];

  constructor(private readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error(`BoundedTaskScheduler concurrency must be a positive integer`);
    }
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.pending.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    this.pending.shift()?.();
  }
}
