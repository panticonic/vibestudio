/**
 * Chat-panel agent lifecycle helpers that drive the runtime over RPC. Extracted
 * from the panel component so they're unit-testable with a mocked `@workspace/runtime`
 * rpc (the panel-rpc harness), independent of the React/UI surface.
 */
import { rpc } from "@workspace/runtime";
import { launchAgentIntoChannel } from "@workspace/agentic-core";

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
