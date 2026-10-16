/**
 * Own the declaration-staging pass for a demanded client runtime. Demand is
 * separate from staging: a runtime may be demanded at startup before any
 * reconciliation has classified its declarations.
 */
export class RuntimeStaging<Runtime extends string> {
  private readonly pending = new Map<Runtime, Promise<void>>();
  private readonly staged = new Set<Runtime>();

  constructor(
    private readonly demandedRuntimes: Set<Runtime>,
    private readonly stageDeclarations: (runtime: Runtime) => Promise<void>
  ) {}

  async ensure(runtime: Runtime): Promise<void> {
    const pending = this.pending.get(runtime);
    if (pending) return pending;
    if (this.staged.has(runtime)) return;

    const wasDemanded = this.demandedRuntimes.has(runtime);
    this.demandedRuntimes.add(runtime);
    const staging = Promise.resolve().then(() => this.stageDeclarations(runtime));
    this.pending.set(runtime, staging);
    try {
      await staging;
      this.staged.add(runtime);
    } catch (error) {
      if (!wasDemanded) this.demandedRuntimes.delete(runtime);
      throw error;
    } finally {
      this.pending.delete(runtime);
    }
  }
}
