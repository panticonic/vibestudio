import { AiChatWorker } from "../agent-worker/ai-chat-worker.js";
import type { ParticipantDescriptor } from "@workspace/harness";
import type { AgentTool } from "@workspace/pi-core";
import { defaultPolicies, silentPolicy, type StepPolicy } from "@workspace/agent-loop";

type SilentAgentConfig = {
  handle?: string;
  name?: string;
  allowedTools?: string[];
};

function asSilentAgentConfig(config: unknown): SilentAgentConfig {
  return config && typeof config === "object" ? (config as SilentAgentConfig) : {};
}

export class SilentAgentWorker extends AiChatWorker {
  static override schemaVersion = AiChatWorker.schemaVersion;

  constructor(ctx: ConstructorParameters<typeof AiChatWorker>[0], env: unknown) {
    super(ctx, env);
    void this.setOwnTitle("Silent Agent");
  }

  protected override getParticipantInfo(
    channelId: string,
    config?: unknown
  ): ParticipantDescriptor {
    const base = super.getParticipantInfo(channelId, config);
    const cfg = asSilentAgentConfig(config);
    return {
      ...base,
      handle: cfg.handle ?? "silent-agent",
      name: cfg.name ?? "Silent Agent",
    };
  }

  /** Silent agents publish only turn boundaries; speaking is an explicit
   *  `say` tool call (a declarative step policy, not a runner wrapper). */
  protected override getStepPolicies(_channelId: string): StepPolicy[] {
    return [...defaultPolicies(), silentPolicy()];
  }

  protected override getLoopTools(channelId: string): AgentTool[] {
    const cfg = asSilentAgentConfig(this.subscriptions.getConfig(channelId));
    const tools = [...super.getLoopTools(channelId), this.createSayTool(channelId)];
    if (!cfg.allowedTools || cfg.allowedTools.length === 0) return tools;
    const allowed = new Set([...cfg.allowedTools, "say"]);
    return tools.filter((tool) => allowed.has(tool.name));
  }

  private createSayTool(channelId: string): AgentTool<any> {
    return {
      name: "say",
      label: "say",
      description:
        "Send a concise message to the channel. Use this only when you intentionally want participants to see the response.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "Message text to send to the channel." },
          replyTo: { type: "string", description: "Optional message id this is replying to." },
          mentions: {
            type: "array",
            items: { type: "string" },
            description: "Optional participant IDs to mention.",
          },
        },
        required: ["content"],
      } as never,
      execute: async (_toolCallId, params) => {
        const input = params as { content?: unknown; replyTo?: unknown; mentions?: unknown };
        if (typeof input.content !== "string" || input.content.trim().length === 0) {
          throw new Error("say requires non-empty content");
        }
        const participantId = this.subscriptions.getParticipantId(channelId);
        if (!participantId) throw new Error("silent agent is not subscribed to the channel");
        const descriptor = this.getParticipantInfo(
          channelId,
          this.subscriptions.getConfig(channelId)
        );
        const messageId = crypto.randomUUID();
        await this.createChannelClient(channelId).send(participantId, messageId, input.content, {
          senderMetadata: {
            ...descriptor.metadata,
            name: descriptor.name,
            type: descriptor.type,
            handle: descriptor.handle,
          },
          replyTo: typeof input.replyTo === "string" ? input.replyTo : undefined,
          mentions: Array.isArray(input.mentions)
            ? input.mentions.filter((mention): mention is string => typeof mention === "string")
            : undefined,
        });
        return {
          content: [{ type: "text", text: `sent message ${messageId}` }],
          details: { messageId },
        };
      },
    };
  }
}

export default {
  fetch(_req: Request) {
    return new Response("silent-agent-worker DO service");
  },
};
