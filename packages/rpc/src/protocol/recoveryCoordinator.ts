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
    this.queue = this.queue.catch(() => undefined).then(() => this.runHandlers(kind, generation));
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
        if (this.handlers[kind].get(name) === handler) {
          void Promise.resolve()
            .then(handler.fn)
            .catch((error: unknown) => {
              console.error(
                `[RecoveryCoordinator] Late bootstrap for ${handler.name} failed:`,
                error
              );
            });
        }
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
      await handler.fn();
    }
    this.completedGeneration[kind] = generation;
  }
}

export function createRecoveryCoordinator(): DefaultRecoveryCoordinator {
  return new DefaultRecoveryCoordinator();
}
