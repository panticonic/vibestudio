/**
 * Chat-panel agent lifecycle helpers that drive the runtime over RPC. Extracted
 * from the panel component so they're unit-testable with a mocked `@vibestudio/runtime`
 * rpc (the panel-rpc harness), independent of the React/UI surface.
 */
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import { rpc } from "@vibestudio/runtime";
import {
  createAgentEntity,
  launchAgentIntoChannel,
  retireAgentEntity,
  subscribeAgentToChannel,
  type AgentEntityHandle,
  type AgentLaunchRpc,
  type AgentSubscriptionResult,
} from "@workspace/agentic-core";

/**
 * Create the agent DO entity (or reactivate it), then subscribe it to the channel.
 *
 * Agent behavior config is PER-AGENT: model/thinkingLevel/approvalLevel/respondPolicy/
 * etc. ride the entity's creation `stateArgs.agentConfig` (the vessel seeds its
 * per-agent settings record from `STATE_ARGS.agentConfig`). The subscription gets
 * `toSubscriptionConfig(config)` — presentation (handle/name/systemPrompt) + any
 * worker-specific extras, with the behavior settings stripped (they'd be inert,
 * and the subscription type forbids them).
 */
export async function createAndSubscribeAgent(args: {
  source: string;
  className: string;
  key: string;
  channelId: string;
  channelContextId: string;
  config?: Record<string, unknown>;
  replay?: boolean;
}): Promise<{ ok: boolean; participantId?: string }> {
  if (!args.channelContextId) {
    throw new Error("Cannot subscribe an agent DO without a context ID");
  }
  const { subscription } = await launchAgentIntoChannel(rpc, {
    source: args.source,
    className: args.className,
    key: args.key,
    channelId: args.channelId,
    contextId: args.channelContextId,
    config: args.config,
    replay: args.replay,
  });
  return subscription;
}

/**
 * Fully-resolved first-agent intent. The handle is still a base here: the
 * lifecycle mints the concrete participant handle and entity key exactly once
 * when it activates the provisional agent.
 */
export interface ProvisionalAgentIntent {
  source: string;
  className: string;
  channelId: string;
  channelContextId: string;
  handleBase: string;
  config: Record<string, unknown>;
  persistedConfig: Record<string, unknown>;
  replay?: boolean;
}

export interface ClaimedProvisionalAgent {
  subscription: AgentSubscriptionResult;
  source: string;
  className: string;
  key: string;
  handle: string;
  persistedConfig: Record<string, unknown>;
}

interface ProvisionalAgentLease {
  fingerprint: string;
  intent: ProvisionalAgentIntent;
  entity: AgentEntityHandle;
  key: string;
  handle: string;
  config: Record<string, unknown>;
}

function fingerprintIntent(intent: ProvisionalAgentIntent): string {
  return canonicalJson({
    source: intent.source,
    className: intent.className,
    channelId: intent.channelId,
    channelContextId: intent.channelContextId,
    handleBase: intent.handleBase,
    config: intent.config,
    persistedConfig: intent.persistedConfig,
    replay: intent.replay ?? false,
  });
}

/**
 * Owns the uncommitted first-agent lease for one chat panel.
 *
 * `prepare()` is latest-intent-wins and never subscribes the agent. `claim()`
 * promotes the exact matching lease into the channel. Replacement first
 * retires the old entity, and disposal retires every lease that was never
 * successfully claimed.
 */
export class ProvisionalAgentLifecycle {
  private desired: { fingerprint: string; intent: ProvisionalAgentIntent } | null = null;
  private current: ProvisionalAgentLease | null = null;
  private claimLease: ProvisionalAgentLease | null = null;
  private reconcileTail: Promise<void> = Promise.resolve();
  private readonly retirementPromises = new Map<string, Promise<void>>();
  private started = false;
  private claiming = false;
  private committed = false;
  private disposed = false;

  constructor(
    private readonly launchRpc: AgentLaunchRpc,
    private readonly randomUuid: () => string = () => crypto.randomUUID()
  ) {}

  get hasStarted(): boolean {
    return this.started;
  }

  get hasCommitted(): boolean {
    return this.committed;
  }

  prepare(intent: ProvisionalAgentIntent | null): Promise<void> {
    if (this.disposed || this.committed || this.claiming) return Promise.resolve();
    if (intent) this.started = true;
    this.desired = intent ? { fingerprint: fingerprintIntent(intent), intent } : null;
    return this.scheduleReconcile();
  }

  async claim(intent: ProvisionalAgentIntent): Promise<ClaimedProvisionalAgent> {
    if (this.disposed) throw new Error("Cannot claim a disposed provisional agent");
    if (this.committed || this.claiming) {
      throw new Error("The provisional first-agent lifecycle has already been claimed");
    }

    this.started = true;
    this.claiming = true;
    const fingerprint = fingerprintIntent(intent);
    this.desired = { fingerprint, intent };

    try {
      await this.scheduleReconcile();
      const lease = this.current;
      if (!lease || lease.fingerprint !== fingerprint) {
        throw new Error("The requested provisional agent could not be activated");
      }

      this.current = null;
      this.desired = null;
      this.claimLease = lease;
      const subscription = await subscribeAgentToChannel(this.launchRpc, lease.entity, {
        channelId: intent.channelId,
        contextId: intent.channelContextId,
        config: lease.config,
        replay: intent.replay,
      });
      if (this.disposed) {
        await this.retireLease(lease);
        throw new Error("The chat panel closed while its provisional agent was being claimed");
      }

      this.claimLease = null;
      this.committed = true;
      return {
        subscription,
        source: intent.source,
        className: intent.className,
        key: lease.key,
        handle: lease.handle,
        persistedConfig: intent.persistedConfig,
      };
    } catch (error) {
      const lease = this.claimLease;
      this.claimLease = null;
      if (lease) {
        try {
          await this.retireLease(lease);
        } catch (cleanupError) {
          this.claiming = false;
          throw new AggregateError(
            [error, cleanupError],
            "Failed to claim and retire the provisional agent"
          );
        }
      }
      this.claiming = false;
      throw error;
    } finally {
      if (this.committed) this.claiming = false;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.desired = null;
    let failure: unknown;
    try {
      await this.scheduleReconcile();
    } catch (error) {
      failure = error;
    }
    const claimLease = this.claimLease;
    if (claimLease) {
      try {
        await this.retireLease(claimLease);
        if (this.claimLease === claimLease) this.claimLease = null;
      } catch (error) {
        failure = failure
          ? new AggregateError([failure, error], "Failed to dispose provisional agents")
          : error;
      }
    }
    if (failure) throw failure;
  }

  private scheduleReconcile(): Promise<void> {
    const next = this.reconcileTail.catch(() => undefined).then(() => this.reconcile());
    this.reconcileTail = next;
    return next;
  }

  private async reconcile(): Promise<void> {
    while (true) {
      if (this.disposed) {
        if (!this.current) return;
        const current = this.current;
        await this.retireLease(current);
        if (this.current === current) this.current = null;
        continue;
      }

      const desired = this.desired;
      if (this.current?.fingerprint === desired?.fingerprint) return;

      if (this.current) {
        const current = this.current;
        await this.retireLease(current);
        if (this.current === current) this.current = null;
        continue;
      }
      if (!desired) return;

      const handle = `${desired.intent.handleBase}-${this.randomUuid().slice(0, 4)}`;
      const key = `${handle}-${this.randomUuid().slice(0, 8)}`;
      const config = { ...desired.intent.config, handle };
      const entity = await createAgentEntity(this.launchRpc, {
        source: desired.intent.source,
        className: desired.intent.className,
        key,
        contextId: desired.intent.channelContextId,
        config,
        agentChannelId: desired.intent.channelId,
      });
      const lease: ProvisionalAgentLease = {
        fingerprint: desired.fingerprint,
        intent: desired.intent,
        entity,
        key,
        handle,
        config,
      };

      if (this.disposed || !this.desired || this.desired.fingerprint !== desired.fingerprint) {
        this.current = lease;
        continue;
      }
      this.current = lease;
      return;
    }
  }

  private retireLease(lease: ProvisionalAgentLease): Promise<void> {
    const entityId = lease.entity.id ?? lease.entity.targetId;
    const existing = this.retirementPromises.get(entityId);
    if (existing) return existing;
    const retirement = retireAgentEntity(this.launchRpc, entityId).catch((error) => {
      this.retirementPromises.delete(entityId);
      throw error;
    });
    this.retirementPromises.set(entityId, retirement);
    return retirement;
  }
}
