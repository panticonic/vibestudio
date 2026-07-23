/**
 * SubscriptionManager — Channel subscriptions, participant identity.
 *
 * Uses ChannelClient (callDoTarget) for subscribe/unsubscribe — no PubSubDOClient.
 * Owns the `subscriptions` table.
 */

import type { SqlStorage } from "@workspace/runtime/worker";
import type { ChannelSubscriptionConfig } from "@workspace/agentic-core";
import type { ParticipantDescriptor } from "@workspace/harness";
import type { ChannelReplayEnvelope } from "@workspace/pubsub";
import type { DOIdentity } from "./identity.js";
import type { ChannelClient, ChannelSubscription } from "./channel-client.js";

const INITIAL_RECOVERY_DELAY_MS = 250;
const MAX_RECOVERY_DELAY_MS = 10_000;

interface LiveSubscription {
  generation: number;
  subscription: ChannelSubscription;
  participantId: string;
  metadata: Record<string, unknown>;
  config?: unknown;
  retryDelayMs: number;
  retryTimer?: ReturnType<typeof setTimeout>;
}

export interface RecoveredChannelSubscription {
  channelId: string;
  config?: unknown;
  envelope?: ChannelReplayEnvelope;
}

export class SubscriptionManager {
  private readonly liveSubscriptions = new Map<string, LiveSubscription>();
  private generation = 0;

  constructor(
    private sql: SqlStorage,
    private channelFactory: (channelId: string) => ChannelClient,
    private identity: DOIdentity,
    private onRecovered?: (subscription: RecoveredChannelSubscription) => Promise<void>
  ) {}

  createTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        channel_id TEXT PRIMARY KEY,
        context_id TEXT NOT NULL,
        subscribed_at INTEGER NOT NULL,
        config TEXT,
        participant_id TEXT
      )
    `);
  }

  /** Build the participant ID from the DO's identity. */
  private buildParticipantId(): string {
    const ref = this.identity.ref;
    return `do:${ref.source}:${ref.className}:${ref.objectKey}`;
  }

  async subscribe(opts: {
    channelId: string;
    contextId: string;
    config?: unknown;
    descriptor: ParticipantDescriptor;
    /** Request replay of persisted messages sent before this subscriber joined. */
    replay?: boolean;
  }): Promise<{
    ok: boolean;
    participantId: string;
    channelConfig?: Record<string, unknown>;
    envelope?: ChannelReplayEnvelope;
  }> {
    const participantId = this.buildParticipantId();
    const metadata: Record<string, unknown> = {
      name: opts.descriptor.name,
      type: opts.descriptor.type,
      handle: opts.descriptor.handle,
      contextId: opts.contextId,
      ...opts.descriptor.metadata,
    };
    // This DO participant (an agent vessel) consumes the channel's STRUCTURED
    // `onChannelEnvelope` delivery. RPC-style clients (connectViaRpc — e.g. the
    // eval running system tests) do NOT set this and receive only the
    // subscription stream, so the channel won't push onChannelEnvelope
    // to them (they have no handler for it).
    metadata["receivesChannelEnvelopes"] = true;
    if (opts.config && typeof opts.config === "object") {
      metadata["channelConfig"] = opts.config;
    }
    if (opts.descriptor.methods && opts.descriptor.methods.length > 0) {
      metadata["methods"] = opts.descriptor.methods;
    }
    if (opts.replay !== undefined) {
      metadata["replay"] = opts.replay;
    }

    await this.closeLiveSubscription(opts.channelId);
    const subscription = await this.channelFactory(opts.channelId).openSubscription(
      participantId,
      metadata
    );
    const live: LiveSubscription = {
      generation: ++this.generation,
      subscription,
      participantId,
      metadata,
      ...(opts.config !== undefined ? { config: opts.config } : {}),
      retryDelayMs: INITIAL_RECOVERY_DELAY_MS,
    };
    this.liveSubscriptions.set(opts.channelId, live);
    this.watchUnexpectedClose(opts.channelId, live);
    const subResult = subscription.result;

    this.sql.exec(
      `INSERT OR REPLACE INTO subscriptions
         (channel_id, context_id, subscribed_at, config, participant_id)
       VALUES (?, ?, ?, ?, ?)`,
      opts.channelId,
      opts.contextId,
      Date.now(),
      opts.config ? JSON.stringify(opts.config) : null,
      participantId
    );

    return {
      ok: true,
      participantId,
      channelConfig: subResult?.channelConfig,
      envelope: subResult?.envelope,
    };
  }

  /** Close the response resource. Does NOT clean up other tables — caller handles that. */
  async unsubscribeFromChannel(channelId: string): Promise<void> {
    const live = this.liveSubscriptions.get(channelId);
    if (!live) return;
    await this.closeLiveSubscription(channelId);
    await live.subscription.closed.catch(() => {});
  }

  /**
   * Release every response resource owned by this activation without changing
   * durable membership. Removing each entry before cancellation makes the
   * close terminal for this activation: its unexpected-close watcher cannot
   * schedule recovery while lifecycle replacement is in progress.
   */
  async releaseActivation(): Promise<number> {
    const live = [...this.liveSubscriptions.entries()];
    await Promise.all(live.map(([channelId]) => this.closeLiveSubscription(channelId)));
    await Promise.all(live.map(([, entry]) => entry.subscription.closed.catch(() => {})));
    return live.length;
  }

  private async closeLiveSubscription(channelId: string): Promise<void> {
    const live = this.liveSubscriptions.get(channelId);
    if (!live) return;
    this.liveSubscriptions.delete(channelId);
    if (live.retryTimer) clearTimeout(live.retryTimer);
    await live.subscription.close();
  }

  private watchUnexpectedClose(channelId: string, live: LiveSubscription): void {
    void live.subscription.closed.then(
      () => this.recoverAfterUnexpectedClose(channelId, live),
      () => this.recoverAfterUnexpectedClose(channelId, live)
    );
  }

  private recoverAfterUnexpectedClose(channelId: string, live: LiveSubscription): void {
    if (this.liveSubscriptions.get(channelId)?.generation !== live.generation) return;
    this.scheduleRecovery(channelId, live);
  }

  private scheduleRecovery(channelId: string, live: LiveSubscription): void {
    if (this.liveSubscriptions.get(channelId)?.generation !== live.generation || live.retryTimer) {
      return;
    }
    const delayMs = live.retryDelayMs;
    live.retryDelayMs = Math.min(delayMs * 2, MAX_RECOVERY_DELAY_MS);
    live.retryTimer = setTimeout(() => {
      live.retryTimer = undefined;
      void this.recover(channelId, live);
    }, delayMs);
    (live.retryTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  }

  private async recover(channelId: string, live: LiveSubscription): Promise<void> {
    if (this.liveSubscriptions.get(channelId)?.generation !== live.generation) return;
    let subscription: ChannelSubscription | null = null;
    let recovered: LiveSubscription | null = null;
    try {
      subscription = await this.channelFactory(channelId).openSubscription(live.participantId, {
        ...live.metadata,
        replay: true,
      });
      if (this.liveSubscriptions.get(channelId)?.generation !== live.generation) {
        await subscription.close();
        return;
      }
      recovered = {
        ...live,
        generation: ++this.generation,
        subscription,
        retryDelayMs: INITIAL_RECOVERY_DELAY_MS,
      };
      this.liveSubscriptions.set(channelId, recovered);
      await this.onRecovered?.({
        channelId,
        ...(live.config !== undefined ? { config: live.config } : {}),
        envelope: subscription.result.envelope,
      });
      this.watchUnexpectedClose(channelId, recovered);
    } catch {
      await subscription?.close().catch(() => undefined);
      const currentGeneration = this.liveSubscriptions.get(channelId)?.generation;
      if (
        currentGeneration === live.generation ||
        (recovered !== null && currentGeneration === recovered.generation)
      ) {
        this.liveSubscriptions.set(channelId, live);
        this.scheduleRecovery(channelId, live);
      }
    }
  }

  getParticipantId(channelId: string): string | null {
    const row = this.sql
      .exec(`SELECT participant_id FROM subscriptions WHERE channel_id = ?`, channelId)
      .toArray();
    return row.length > 0 ? (row[0]!["participant_id"] as string | null) : null;
  }

  getContextId(channelId: string): string {
    const row = this.sql
      .exec(`SELECT context_id FROM subscriptions WHERE channel_id = ?`, channelId)
      .toArray();
    if (row.length === 0) throw new Error(`No subscription for channel ${channelId}`);
    return row[0]!["context_id"] as string;
  }

  getConfig(channelId: string): ChannelSubscriptionConfig | null {
    const row = this.sql
      .exec(`SELECT config FROM subscriptions WHERE channel_id = ?`, channelId)
      .toArray();
    if (row.length === 0 || !row[0]!["config"]) return null;
    const parsed = JSON.parse(row[0]!["config"] as string);
    return parsed && typeof parsed === "object" ? (parsed as ChannelSubscriptionConfig) : null;
  }

  patchConfig(channelId: string, patch: Record<string, unknown>): ChannelSubscriptionConfig {
    const current = this.getConfig(channelId) ?? {};
    if (!this.getParticipantId(channelId)) {
      throw new Error(`No subscription for channel ${channelId}`);
    }
    const next: Record<string, unknown> = { ...current, ...patch };
    this.sql.exec(
      `UPDATE subscriptions SET config = ? WHERE channel_id = ?`,
      JSON.stringify(next),
      channelId
    );
    return next as ChannelSubscriptionConfig;
  }

  listAll(): Array<{ channelId: string; participantId: string | null }> {
    return this.sql
      .exec(`SELECT channel_id, participant_id FROM subscriptions`)
      .toArray()
      .map((row) => ({
        channelId: row["channel_id"] as string,
        participantId: row["participant_id"] as string | null,
      }));
  }

  listStored(): Array<{ channelId: string; contextId: string; config?: unknown }> {
    return this.sql
      .exec(`SELECT channel_id, context_id, config FROM subscriptions ORDER BY channel_id`)
      .toArray()
      .map((row) => ({
        channelId: String(row["channel_id"]),
        contextId: String(row["context_id"]),
        ...(typeof row["config"] === "string"
          ? { config: JSON.parse(String(row["config"])) as unknown }
          : {}),
      }));
  }

  /** Delete subscription record only (no channel call). Used during unsubscribeChannel cleanup. */
  deleteSubscription(channelId: string): void {
    this.sql.exec(`DELETE FROM subscriptions WHERE channel_id = ?`, channelId);
  }

  /** Number of durable membership rows (fork preflight and lifecycle registration). */
  count(): number {
    const row = this.sql.exec(`SELECT COUNT(*) AS cnt FROM subscriptions`).toArray()[0];
    return Number(row?.["cnt"] ?? 0);
  }

  listChannelIds(): string[] {
    return this.sql
      .exec(`SELECT channel_id FROM subscriptions ORDER BY channel_id`)
      .toArray()
      .map((row) => String(row["channel_id"]));
  }

  /**
   * Fork bookkeeping: re-key a cloned subscription onto the new channel and
   * re-home it to the fork context.
   */
  rename(oldChannelId: string, newChannelId: string, newContextId: string): void {
    if (!newContextId) throw new Error("SubscriptionManager.rename requires newContextId");
    this.sql.exec(
      `UPDATE subscriptions SET channel_id = ?, context_id = ?, participant_id = ? WHERE channel_id = ?`,
      newChannelId,
      newContextId,
      this.buildParticipantId(),
      oldChannelId
    );
  }
}
