import type { SupervisionChange } from "@vibestudio/shared/events";

export type UpdatePolicy = "prompt" | "immediate" | "restart-at-safe-point";

/** A newer ready build of the client that is running. */
export interface ClientUpdate {
  source: string;
  buildKey: string;
  previousBuildKey: string | null;
  effectiveVersion: string | null;
  change: SupervisionChange;
}

/** The slice of the host's events client the observer needs. */
export interface SupervisionEvents {
  subscribe(event: "supervision:changed"): Promise<void>;
  unsubscribe(event: "supervision:changed"): Promise<void>;
  on(event: "supervision:changed", listener: (change: SupervisionChange) => void): () => void;
}

export interface UpdateObserverOptions {
  events: SupervisionEvents;
  /** The running client: updates are for this source, relative to this build. */
  source: string;
  buildKey: string;
  /** The host's configured policy for this client. */
  policy: () => UpdatePolicy;
  /** Development mode (per client, per device) turns any policy into `immediate`. */
  developmentMode: () => boolean;
  /** The host implements the policy: prompt, restart at a safe point, or swap now. */
  onUpdate: (update: ClientUpdate, effectivePolicy: UpdatePolicy) => void | Promise<void>;
  onError: (error: unknown) => void;
}

/**
 * Observes `supervision:changed` for one running client and hands each newer
 * ready build to the host's policy. The core holds no UI. Rollbacks count: a
 * different build adopted is a build to move to.
 */
export class ClientUpdateObserver {
  private current: string;
  private release: (() => void) | null = null;

  constructor(private readonly options: UpdateObserverOptions) {
    this.current = options.buildKey;
  }

  async start(): Promise<void> {
    if (this.release) return;
    this.release = this.options.events.on("supervision:changed", (change) => this.observe(change));
    try {
      await this.options.events.subscribe("supervision:changed");
    } catch (error) {
      this.release();
      this.release = null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    const release = this.release;
    if (!release) return;
    this.release = null;
    release();
    await this.options.events.unsubscribe("supervision:changed");
  }

  /** The host adopted a build (restart, swap): later updates are relative to it. */
  adopted(buildKey: string): void {
    this.current = buildKey;
  }

  private observe(change: SupervisionChange): void {
    if (change.source !== this.options.source) return;
    if (change.change !== "adopted" && change.change !== "rolled-back") return;
    if (change.status !== "running") return;
    const buildKey = change.artifact.buildKey;
    if (!buildKey || buildKey === this.current) return;
    const policy = this.options.developmentMode() ? "immediate" : this.options.policy();
    const update: ClientUpdate = {
      source: change.source,
      buildKey,
      previousBuildKey: change.previousBuildKey,
      effectiveVersion: change.artifact.effectiveVersion,
      change,
    };
    try {
      void Promise.resolve(this.options.onUpdate(update, policy)).catch(this.options.onError);
    } catch (error) {
      this.options.onError(error);
    }
  }
}
