import { isRpcAbortedBy } from "@vibestudio/rpc";

export class DurableObservationStoppedError extends Error {
  constructor() {
    super("Durable observation stopped");
    this.name = "DurableObservationStoppedError";
  }
}

export interface DurableObservation {
  /** Remote admission followed by the first authoritative projection read. */
  readonly ready: Promise<void>;
  /** Request and await a projection generation at least this recent. */
  refresh(): Promise<void>;
  /** Retire local and remote ownership, and join admitted and in-flight work. */
  stop(reason?: unknown): Promise<void>;
}

/**
 * Own a level-triggered remote projection for its complete lifetime.
 *
 * The local listener is installed synchronously, remote event delivery is
 * admitted before the first read, and every event invalidates any older read.
 * Retirement is asynchronous because ownership is not gone until admission,
 * the current read, and the matching remote leave have all settled.
 */
export function observeDurableProjection<T>(input: {
  listen(changed: () => Promise<void>): () => void;
  admit?(): Promise<void>;
  leave?(): Promise<void>;
  read(): Promise<T>;
  apply(value: T): void;
  error(error: unknown): void;
}): DurableObservation {
  let active = true;
  let admitted = input.admit === undefined;
  let requested = 0;
  let settled = 0;
  let running: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;
  let retirementReason: unknown = new DurableObservationStoppedError();
  const receipts = new Map<number, { resolve(): void; reject(error: unknown): void }>();

  const settleThrough = (generation: number, error?: unknown) => {
    settled = Math.max(settled, generation);
    for (const [target, receipt] of receipts) {
      if (target > generation) continue;
      receipts.delete(target);
      if (error === undefined) receipt.resolve();
      else receipt.reject(error);
    }
  };

  const drain = async () => {
    while (active && settled !== requested) {
      const generation = requested;
      try {
        const value = await input.read();
        if (!active) return;
        if (generation !== requested) continue;
        input.apply(value);
        settleThrough(generation);
      } catch (error) {
        if (!active) {
          if (isRpcAbortedBy(error, retirementReason)) return;
          throw error;
        }
        if (generation !== requested) continue;
        input.error(error);
        settleThrough(generation, error);
      }
    }
  };

  const startDrain = () => {
    if (running || !active || !admitted) return;
    const flight = drain();
    running = flight.finally(() => {
      running = null;
      if (active && admitted && settled !== requested) startDrain();
    });
    // `running` is joined by receipts or stop. Retain the rejection here too,
    // so a caller that has not yet begun retirement cannot create an unhandled
    // cleanup rejection.
    void running.catch(() => undefined);
  };

  const refresh = (): Promise<void> => {
    if (!active) return Promise.reject(retirementReason);
    const generation = ++requested;
    const receipt = new Promise<void>((resolve, reject) => {
      receipts.set(generation, { resolve, reject });
    });
    void receipt.catch(() => undefined);
    startDrain();
    return receipt;
  };

  const unlisten = input.listen(() => (active ? refresh() : Promise.resolve()));
  const admission = input.admit ? input.admit() : Promise.resolve();
  const ready = admission.then(
    async () => {
      admitted = true;
      if (!active) throw retirementReason;
      await refresh();
    },
    (error: unknown) => {
      if (active) {
        input.error(error);
        settleThrough(requested, error);
      }
      throw error;
    }
  );
  void ready.catch(() => undefined);

  return {
    ready,
    refresh,
    stop(reason = retirementReason) {
      if (stopping) return stopping;
      active = false;
      retirementReason = reason;
      const localFailures: unknown[] = [];
      try {
        unlisten();
      } catch (error) {
        localFailures.push(error);
      }
      for (const receipt of receipts.values()) receipt.reject(retirementReason);
      receipts.clear();
      // Capture the admitted read now: its completion clears `running`, but
      // cannot erase the receipt this retirement must join.
      const reading = running;
      stopping = (async () => {
        const leaving = (async () => {
          // Leave must follow remote admission, including partial failure.
          try {
            await admission;
          } catch {
            /* Joined independently below. */
          }
          await input.leave?.();
        })();
        const outcomes = await Promise.allSettled([admission, reading, leaving]);
        const failures = [
          ...new Set([
            ...localFailures.filter((failure) => !isRpcAbortedBy(failure, retirementReason)),
            ...outcomes.flatMap((outcome) =>
              outcome.status === "rejected" && !isRpcAbortedBy(outcome.reason, retirementReason)
                ? [outcome.reason as unknown]
                : []
            ),
          ]),
        ];
        if (!failures.length) return;
        const failure =
          failures.length === 1
            ? failures[0]
            : new AggregateError(failures, "Durable observation retirement failed");
        try {
          input.error(failure);
        } catch (observerFailure) {
          throw new AggregateError(
            [failure, observerFailure],
            "Durable observation retirement and failure reporting failed"
          );
        }
        throw failure;
      })();
      void stopping.catch(() => undefined);
      return stopping;
    },
  };
}
