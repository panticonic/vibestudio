/**
 * Headless channel helpers — create channels and subscribe DOs with headless defaults.
 *
 * "Headless" here means "no chat panel attached" — the same agent worker, prompt,
 * and tool surface as the panel-hosted path. The only thing this layer adds is
 * full-auto approval (since there's no user to approve tool calls interactively).
 * UI-only tools (inline_ui, feedback_form, etc.) are filtered out naturally
 * because no panel is connected to advertise them.
 */

import type { AgentSubscriptionConfig, AgentLaunchRpc } from "@workspace/agentic-core";
import { launchAgentIntoChannel, retireAgentEntity } from "@workspace/agentic-core";
import type { ChannelConfig } from "@workspace/pubsub";

/** Recommended channel config for headless sessions: full-auto approval (level 2). */
export function getRecommendedChannelConfig(): Partial<ChannelConfig> {
  return {
    approvalLevel: 2,  // Full Auto
  };
}

export interface SubscribeHeadlessAgentOptions {
  /** RPC call function for reaching the platform */
  rpcCall: (target: string, method: string, args: unknown[]) => Promise<unknown>;
  /** Worker source (e.g., "workers/agent-worker") */
  source: string;
  /** DO class name (e.g., "AiChatWorker") */
  className: string;
  /** DO object key (unique per instance) */
  objectKey: string;
  /** Channel ID to subscribe to */
  channelId: string;
  /**
   * Context ID for the spawned agent. Omit to let runtime.createEntity mint a
   * fresh isolated context for this headless agent.
   */
  contextId?: string;
  /**
   * Pi-native pass-through config. Common keys are `model`,
   * `thinkingLevel`, `approvalLevel`, `systemPrompt`, and
   * `systemPromptMode`.
   */
  extraConfig?: AgentSubscriptionConfig;
}

export interface HeadlessAgentSubscription {
  ok: boolean;
  participantId?: string;
  entityId: string;
  targetId: string;
  contextId: string;
}

/**
 * Subscribe a DO agent to a channel with headless defaults.
 *
 * Sets full-auto approval on the channel and forwards any extra subscription
 * config to the worker. The worker uses the same harness config and system
 * prompt as it does for panel-hosted sessions; only the runtime environment
 * differs (no panel → no UI tools advertised → naturally absent from discovery).
 */
export async function subscribeHeadlessAgent(
  opts: SubscribeHeadlessAgentOptions,
): Promise<HeadlessAgentSubscription> {
  const channelConfig = getRecommendedChannelConfig();

  const subscriptionConfig: AgentSubscriptionConfig = {
    ...channelConfig,
    ...opts.extraConfig,
  };

  const { handle, subscription, contextId } = await launchAgentIntoChannel(
    { call: opts.rpcCall } as AgentLaunchRpc,
    {
      source: opts.source,
      className: opts.className,
      key: opts.objectKey,
      channelId: opts.channelId,
      ...(opts.contextId ? { contextId: opts.contextId } : {}),
      config: subscriptionConfig,
      retireEntityOnSubscribeFailure: true,
      missingContextErrorMessage:
        "runtime.createEntity did not return a contextId for headless agent subscription",
    },
  );
  return {
    ...subscription,
    entityId: handle.id ?? handle.targetId,
    targetId: handle.targetId,
    contextId,
  };
}

export async function retireHeadlessAgent(opts: {
  rpcCall: (target: string, method: string, args: unknown[]) => Promise<unknown>;
  entityId: string;
}): Promise<void> {
  await retireAgentEntity({ call: opts.rpcCall } as AgentLaunchRpc, opts.entityId);
}

export async function unsubscribeHeadlessAgent(opts: {
  rpcCall: (target: string, method: string, args: unknown[]) => Promise<unknown>;
  targetId: string;
  channelId: string;
}): Promise<void> {
  await opts.rpcCall(opts.targetId, "unsubscribeChannel", [opts.channelId]);
}
