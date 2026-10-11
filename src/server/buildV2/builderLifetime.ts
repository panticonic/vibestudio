/** Owns build admission and joins every admitted operation before teardown. */
export class BuilderLifetime {
  private closing: Error | undefined;
  private drained = false;
  private readonly operations = new Set<Promise<unknown>>();
  private closeFlight: Promise<unknown[]> | undefined;
  private readonly controller = new AbortController();

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get isClosing(): boolean {
    return this.closing !== undefined;
  }

  get isDrained(): boolean {
    return this.drained;
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(this.closing);
    const flight = Promise.resolve().then(operation);
    this.operations.add(flight);
    void flight.finally(() => this.operations.delete(flight)).catch(() => {});
    return flight;
  }

  close(reason = new Error("Build system is shutting down")): Promise<unknown[]> {
    if (this.closeFlight) return this.closeFlight;
    this.closing = reason;
    this.controller.abort(reason);
    const flight = this.joinOperations();
    this.closeFlight = flight.finally(() => {
      this.drained = true;
    });
    return flight;
  }

  assertOpen(): void {
    if (this.closing) throw this.closing;
  }

  private async joinOperations(): Promise<unknown[]> {
    const failures: unknown[] = [];
    // Closing admission is synchronous, so the set only shrinks while draining.
    while (this.operations.size > 0) {
      const outcomes = await Promise.allSettled([...this.operations]);
      failures.push(
        ...outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []))
      );
    }
    return failures;
  }
}

export function joinedFailure(failures: readonly unknown[], message: string): unknown {
  if (failures.length === 0) return undefined;
  if (failures.length === 1) return failures[0];
  return new AggregateError(failures, message, { cause: failures[0] });
}

export interface BuildSlotLease {
  release(): void;
}

interface Waiter {
  priority: "interactive" | "background" | "speculative";
  resolve(lease: BuildSlotLease): void;
  reject(reason: unknown): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** A cancellable build-slot queue. Closing rejects waiters, never active work. */
export class BuildSlotQueue {
  private isClosed = false;
  private closeReason: unknown;
  private readonly waiters: Waiter[] = [];
  private running = 0;
  private runningNonInteractive = 0;
  private runningSpeculative = 0;

  constructor(private readonly capacity: number) {}

  get queuedCount(): number {
    return this.waiters.length;
  }

  acquire(
    priority: Waiter["priority"],
    canAdmit: (
      priority: Waiter["priority"],
      running: number,
      nonInteractive: number,
      speculative: number,
      capacity: number
    ) => boolean,
    signal?: AbortSignal
  ): Promise<BuildSlotLease> {
    if (this.isClosed) return Promise.reject(this.closeReason);
    if (signal?.aborted) return Promise.reject(signal.reason);
    this.canAdmit = canAdmit;
    if (
      canAdmit(
        priority,
        this.running,
        this.runningNonInteractive,
        this.runningSpeculative,
        this.capacity
      )
    ) {
      return Promise.resolve(this.grant(priority));
    }
    return new Promise<BuildSlotLease>((resolve, reject) => {
      const waiter: Waiter = { priority, resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          signal.removeEventListener("abort", waiter.onAbort!);
          reject(signal.reason);
          this.admitWaiters(canAdmit);
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      const rank = (candidate: Waiter["priority"]): number =>
        candidate === "interactive" ? 0 : candidate === "background" ? 1 : 2;
      const insertionPoint = this.waiters.findIndex(
        (entry) => rank(entry.priority) > rank(priority)
      );
      if (insertionPoint >= 0) this.waiters.splice(insertionPoint, 0, waiter);
      else this.waiters.push(waiter);
    });
  }

  close(reason: unknown): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.closeReason = reason;
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.signal && waiter.onAbort)
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(reason);
    }
  }

  private grant(priority: Waiter["priority"]): BuildSlotLease {
    this.running++;
    if (priority !== "interactive") this.runningNonInteractive++;
    if (priority === "speculative") this.runningSpeculative++;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.running--;
        if (priority !== "interactive") this.runningNonInteractive--;
        if (priority === "speculative") this.runningSpeculative--;
        if (this.canAdmit) this.admitWaiters(this.canAdmit);
      },
    };
  }

  private canAdmit?: Parameters<BuildSlotQueue["acquire"]>[1];

  private admitWaiters(canAdmit: Parameters<BuildSlotQueue["acquire"]>[1]): void {
    this.canAdmit = canAdmit;
    for (let index = 0; index < this.waiters.length; ) {
      const waiter = this.waiters[index]!;
      if (
        !canAdmit(
          waiter.priority,
          this.running,
          this.runningNonInteractive,
          this.runningSpeculative,
          this.capacity
        )
      ) {
        index++;
        continue;
      }
      this.waiters.splice(index, 1);
      if (waiter.signal && waiter.onAbort)
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(this.grant(waiter.priority));
    }
  }
}
