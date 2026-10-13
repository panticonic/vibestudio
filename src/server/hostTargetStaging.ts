/**
 * Own the declaration-staging pass for a demanded host target. Demand is
 * separate from staging: a target may be demanded at startup before any
 * reconciliation has classified its declarations.
 */
export class HostTargetStaging<Target extends string> {
  private readonly pending = new Map<Target, Promise<void>>();
  private readonly staged = new Set<Target>();

  constructor(
    private readonly demandedTargets: Set<Target>,
    private readonly stageDeclarations: (target: Target) => Promise<void>
  ) {}

  async ensure(target: Target): Promise<void> {
    const pending = this.pending.get(target);
    if (pending) return pending;
    if (this.staged.has(target)) return;

    const wasDemanded = this.demandedTargets.has(target);
    this.demandedTargets.add(target);
    const staging = Promise.resolve().then(() => this.stageDeclarations(target));
    this.pending.set(target, staging);
    try {
      await staging;
      this.staged.add(target);
    } catch (error) {
      if (!wasDemanded) this.demandedTargets.delete(target);
      throw error;
    } finally {
      this.pending.delete(target);
    }
  }
}
