/**
 * Keeps exactly one usable root-bootstrap invitation available until the first
 * account is created. Ordinary user/device invitations are caller-owned and do
 * not use this lifecycle; only an otherwise-unclaimable fresh server needs an
 * automatically renewed credential.
 */

export interface RootBootstrapPairing {
  expiresAt: number;
}

export interface RootBootstrapInviteLifecycleDependencies<
  Pairing extends RootBootstrapPairing,
  Invite,
> {
  hasRoot(): boolean;
  createPairing(): Pairing;
  /** The issued credential is usable locally before remote reach is available. */
  describePairing(pairing: Pairing): Invite;
  armPairing(pairing: Pairing): Promise<Invite>;
  cancelPairing(pairing: Pairing): Promise<void>;
  publish(invite: Invite | null): void;
  onRenewed?(invite: Invite): void;
  onRenewalError?(error: unknown): void;
  now?(): number;
  retryMs?: number;
  schedule?(callback: () => void, delayMs: number): () => void;
}

const DEFAULT_RETRY_MS = 5_000;

function defaultSchedule(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
}

export class RootBootstrapInviteLifecycle<Pairing extends RootBootstrapPairing, Invite> {
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => () => void;
  private cancelTimer: (() => void) | null = null;
  private stopped = false;
  private readonly tasks = new Set<Promise<void>>();
  private readonly pairings = new Set<Pairing>();
  private currentPairing: Pairing | null = null;
  private readonly retirements = new WeakMap<Pairing, Promise<void>>();

  constructor(private readonly deps: RootBootstrapInviteLifecycleDependencies<Pairing, Invite>) {
    this.now = deps.now ?? Date.now;
    this.schedule = deps.schedule ?? defaultSchedule;
  }

  async start(): Promise<Invite | null> {
    if (this.deps.hasRoot()) {
      this.stopped = true;
      this.deps.publish(null);
      return null;
    }
    return this.issue(false);
  }

  complete(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.deps.publish(null);
    // Completing ownership invalidates outstanding remote-reach waiters as well
    // as the visible credential. Their arm operation settles from cancellation.
    for (const pairing of this.pairings) {
      void this.retirePairing(pairing).catch(() => {});
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
    const cancellations = await Promise.allSettled(
      [...this.pairings].map((pairing) => this.retirePairing(pairing))
    );
    const settled = await Promise.allSettled([...this.tasks]);
    const failures = [...cancellations, ...settled].flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : []
    );
    if (failures.length) throw new AggregateError(failures, "Root invitation retirement failed");
  }

  private retirePairing(pairing: Pairing): Promise<void> {
    const existing = this.retirements.get(pairing);
    if (existing) return existing;
    const retirement = Promise.resolve().then(() => this.deps.cancelPairing(pairing));
    this.retirements.set(pairing, retirement);
    this.tasks.add(retirement);
    void retirement.then(
      () => this.tasks.delete(retirement),
      () => {}
    );
    return retirement;
  }

  private async issue(renewed: boolean): Promise<Invite | null> {
    if (this.stopped || this.deps.hasRoot()) {
      this.complete();
      return null;
    }
    const previous = this.currentPairing;
    if (previous && this.pairings.has(previous)) {
      await this.retirePairing(previous);
      await Promise.allSettled([...this.tasks]);
    }
    if (this.stopped || this.deps.hasRoot()) return null;
    const pairing = this.deps.createPairing();
    this.currentPairing = pairing;
    this.pairings.add(pairing);
    const issued = this.deps.describePairing(pairing);
    this.deps.publish(issued);
    this.scheduleRenewal(Math.max(1, pairing.expiresAt - this.now()));
    let task!: Promise<void>;
    task = this.arm(pairing, renewed)
      .catch((error) => {
        if (this.stopped || this.deps.hasRoot() || this.currentPairing !== pairing) return;
        this.deps.publish(null);
        this.deps.onRenewalError?.(error);
        this.scheduleRenewal(this.deps.retryMs ?? DEFAULT_RETRY_MS);
      })
      .finally(() => {
        this.tasks.delete(task);
        this.pairings.delete(pairing);
      });
    this.tasks.add(task);
    return issued;
  }

  private async arm(pairing: Pairing, renewed: boolean): Promise<void> {
    let invite: Invite;
    try {
      invite = await this.deps.armPairing(pairing);
    } catch (error) {
      try {
        await this.retirePairing(pairing);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Root bootstrap pairing failed and its invite could not be retired"
        );
      }
      throw error;
    }
    if (this.stopped || this.deps.hasRoot() || this.currentPairing !== pairing) {
      await this.retirePairing(pairing);
      if (this.stopped || this.deps.hasRoot()) this.complete();
      return;
    }
    this.deps.publish(invite);
    if (renewed) this.deps.onRenewed?.(invite);
  }

  private scheduleRenewal(delayMs: number): void {
    this.cancelTimer?.();
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null;
      void this.issue(true).catch((error) => {
        if (this.stopped) return;
        this.deps.onRenewalError?.(error);
        this.scheduleRenewal(this.deps.retryMs ?? DEFAULT_RETRY_MS);
      });
    }, delayMs);
  }
}
