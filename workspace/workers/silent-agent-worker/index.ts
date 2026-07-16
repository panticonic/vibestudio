import { AiChatWorker } from "../agent-worker/ai-chat-worker.js";
import type { ParticipantDescriptor } from "@workspace/harness";
import type { AgentTool } from "@workspace/pi-core";
import type { AgentToolExecutionContext } from "@workspace/agentic-do";

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

  /** Silent agents publish only turn boundaries; speaking is the explicit `say`
   *  tool. This is now the config-level `publishPolicy: "say-only"` (WS-4's
   *  publishPolicy StepPolicy) — the old `silentPolicy()` runner wrapper is gone. */
  protected override getPublishPolicy(_channelId: string): "say-only" {
    return "say-only";
  }

  protected override getLoopTools(
    channelId: string,
    execution?: AgentToolExecutionContext
  ): AgentTool[] {
    const cfg = asSilentAgentConfig(this.subscriptions.getConfig(channelId));
    // The generalized `say` tool is provided by AgentWorkerBase.getLoopTools.
    const tools = super.getLoopTools(channelId, execution);
    if (!cfg.allowedTools || cfg.allowedTools.length === 0) return tools;
    const allowed = new Set([...cfg.allowedTools, "say"]);
    return tools.filter((tool) => allowed.has(tool.name));
  }
}

export default {
  fetch(_req: Request) {
    return new Response("silent-agent-worker DO service");
  },
};
