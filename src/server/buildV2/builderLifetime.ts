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
  readonly priority: BuildPriority;
  release(): void;
}

export type BuildPriority = "interactive" | "background" | "speculative";
export type BuildPriorityPromotion = (priority: BuildPriority) => void;

/** Required work keeps a lane available beside background work; speculative
 * work occupies at most the remaining capacity. Used by local and shared
 * compiler admission so both enforce the same priority contract. */
export function hasBuildSlotCapacity(
  priority: BuildPriority,
  activeBuilds: number,
  activeNonInteractiveBuilds: number,
  activeSpeculativeBuilds: number,
  maxConcurrentBuilds: number
): boolean {
  if (activeBuilds >= maxConcurrentBuilds) return false;
  if (priority === "interactive") return true;
  if (activeNonInteractiveBuilds >= Math.max(1, maxConcurrentBuilds - 1)) return false;
  return (
    priority === "background" || activeSpeculativeBuilds < Math.max(1, maxConcurrentBuilds - 2)
  );
}

/** Keeps the strongest demand attached to one shared build flight. */
export class BuildPriorityOwner {
  private queuedPromotion?: BuildPriorityPromotion;

  constructor(private currentPriority: BuildPriority) {}

  get priority(): BuildPriority {
    return this.currentPriority;
  }

  promote(priority: BuildPriority): void {
    if (priorityRank(priority) >= priorityRank(this.currentPriority)) return;
    this.currentPriority = priority;
    this.queuedPromotion?.(priority);
  }

  bindQueuedPromotion(promote: BuildPriorityPromotion): void {
    this.queuedPromotion = promote;
    promote(this.currentPriority);
  }

  clearQueuedPromotion(): void {
    this.queuedPromotion = undefined;
  }
}

/** One shared build promise whose queued admission follows its strongest caller. */
export class BuildFlight<T> {
  readonly priority: BuildPriorityOwner;
  readonly promise: Promise<T>;

  constructor(priority: BuildPriority, run: (owner: BuildPriorityOwner) => Promise<T>) {
    this.priority = new BuildPriorityOwner(priority);
    this.promise = Promise.resolve().then(() => run(this.priority));
  }

  adopt(priority: BuildPriority): Promise<T> {
    this.priority.promote(priority);
    return this.promise;
  }
}

function priorityRank(priority: BuildPriority): number {
  return priority === "interactive" ? 0 : priority === "background" ? 1 : 2;
}

interface Waiter {
  priority: BuildPriority;
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
    signal?: AbortSignal,
    bindPromotion?: (promote: BuildPriorityPromotion) => void
  ): Promise<BuildSlotLease> {
    if (this.isClosed) {
      bindPromotion?.(() => {});
      return Promise.reject(this.closeReason);
    }
    if (signal?.aborted) {
      bindPromotion?.(() => {});
      return Promise.reject(signal.reason);
    }
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
      bindPromotion?.(() => {});
      return Promise.resolve(this.grant(priority));
    }
    return new Promise<BuildSlotLease>((resolve, reject) => {
      const waiter: Waiter = { priority, resolve, reject, ...(signal ? { signal } : {}) };
      const promote = (next: BuildPriority) => {
        if (priorityRank(next) >= priorityRank(waiter.priority)) return;
        const index = this.waiters.indexOf(waiter);
        if (index < 0) return;
        this.waiters.splice(index, 1);
        waiter.priority = next;
        const insertionPoint = this.waiters.findIndex(
          (entry) => priorityRank(entry.priority) > priorityRank(next)
        );
        if (insertionPoint >= 0) this.waiters.splice(insertionPoint, 0, waiter);
        else this.waiters.push(waiter);
        this.admitWaiters(canAdmit);
      };
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
      bindPromotion?.(promote);
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
      priority,
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
