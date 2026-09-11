import { isRpcConnectionLost } from "../errors.js";

export type RecoveryKind = "resubscribe" | "cold-recover";

export interface ResubscribeRegistrationOptions {
  /** Include the already-completed current transport generation. Keep this
   * enabled for consumers whose recovery callback owns bootstrap. Disable it
   * when the registering resource has already bootstrapped itself and should
   * only observe future transport generations. */
  includeCurrentGeneration?: boolean;
}

type Handler = {
  name: string;
  fn: () => Promise<void> | void;
  includeCurrentGeneration: boolean;
};

export interface RecoveryCoordinator {
  registerResubscribeHandler(
    name: string,
    fn: () => Promise<void> | void,
    options?: ResubscribeRegistrationOptions
  ): () => void;
  registerColdRecoverHandler(name: string, fn: () => Promise<void> | void): () => void;
  run(kind: RecoveryKind): Promise<void>;
}

export class DefaultRecoveryCoordinator implements RecoveryCoordinator {
  private handlers: Record<RecoveryKind, Map<string, Handler>> = {
    resubscribe: new Map(),
    "cold-recover": new Map(),
  };
  private generation = 0;
  private completedGeneration: Partial<Record<RecoveryKind, number>> = {};
  private queue: Promise<void> = Promise.resolve();

  registerResubscribeHandler(
    name: string,
    fn: () => Promise<void> | void,
    options: ResubscribeRegistrationOptions = {}
  ): () => void {
    return this.register("resubscribe", name, fn, options.includeCurrentGeneration !== false);
  }

  registerColdRecoverHandler(name: string, fn: () => Promise<void> | void): () => void {
    return this.register("cold-recover", name, fn, false);
  }

  async run(kind: RecoveryKind): Promise<void> {
    if (kind === "resubscribe") this.generation++;
    const generation = this.generation;
    this.queue = this.queue.then(() => this.runHandlers(kind, generation));
    return this.queue;
  }

  private register(
    kind: RecoveryKind,
    name: string,
    fn: () => Promise<void> | void,
    includeCurrentGeneration: boolean
  ): () => void {
    const handler = { name, fn, includeCurrentGeneration };
    this.handlers[kind].set(name, handler);
    if (
      kind === "resubscribe" &&
      handler.includeCurrentGeneration &&
      this.completedGeneration[kind] === this.generation
    ) {
      queueMicrotask(() => {
        if (this.handlers[kind].get(name) === handler) void this.runOne(kind, handler);
      });
    }
    return () => {
      if (this.handlers[kind].get(name) === handler) this.handlers[kind].delete(name);
    };
  }

  private async runHandlers(kind: RecoveryKind, generation: number): Promise<void> {
    const handlers =
      kind === "cold-recover" ? [...this.handlers[kind].values()] : this.handlers[kind].values();
    for (const handler of handlers) {
      if (this.handlers[kind].get(handler.name) !== handler) continue;
      if (!(await this.runOne(kind, handler))) return;
    }
    this.completedGeneration[kind] = generation;
  }

  private async runOne(kind: RecoveryKind, handler: Handler): Promise<boolean> {
    const maxAttempts = 3;
    // An attempt this loop is about to retry is not yet a fault, so it is
    // recorded rather than announced. Warning on each one meant a recovery
    // that timed out once and then succeeded — the ordinary shape of
    // resubscribing across a reconnect — left a warning behind for anything
    // auditing the console to treat as a failure, which is how a healthy
    // reconnect failed the desktop smoke. Nothing is hidden: every cause is
    // kept and reported together if the retries do run out.
    const failures: unknown[] = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await handler.fn();
        return true;
      } catch (error) {
        // A resource can close just before its transport reports an outage.
        // Once that outage is known, this generation cannot finish. The host
        // owns the next recovery signal; local retries cannot restore a pipe.
        if (isRpcConnectionLost(error)) return false;
        failures.push(error);
        console.debug(
          `[RecoveryCoordinator] ${kind} handler "${handler.name}" failed (attempt ${attempt}/${maxAttempts}); retrying:`,
          error
        );
        if (attempt < maxAttempts) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(250 * 2 ** (attempt - 1), 1000))
          );
        }
      }
    }
    console.warn(
      `[RecoveryCoordinator] ${kind} handler "${handler.name}" exhausted all ${maxAttempts} attempts:`,
      ...failures
    );
    return true;
  }
}

export function createRecoveryCoordinator(): DefaultRecoveryCoordinator {
  return new DefaultRecoveryCoordinator();
}
