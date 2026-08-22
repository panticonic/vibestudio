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
  }

  stop(): void {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  private async issue(renewed: boolean): Promise<Invite | null> {
    if (this.stopped || this.deps.hasRoot()) {
      this.complete();
      return null;
    }
    const pairing = this.deps.createPairing();
    let invite: Invite;
    try {
      invite = await this.deps.armPairing(pairing);
    } catch (error) {
      await this.deps.cancelPairing(pairing).catch(() => undefined);
      throw error;
    }
    if (this.stopped || this.deps.hasRoot()) {
      await this.deps.cancelPairing(pairing).catch(() => undefined);
      this.complete();
      return null;
    }
    this.deps.publish(invite);
    if (renewed) this.deps.onRenewed?.(invite);
    this.scheduleRenewal(Math.max(1, pairing.expiresAt - this.now()));
    return invite;
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
