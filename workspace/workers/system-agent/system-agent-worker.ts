import { AgentWorkerBase, type AgentToolExecutionContext } from "@workspace/agentic-do";
import { createEvalTool, type ParticipantDescriptor } from "@workspace/harness";
import type { AgentTool } from "@workspace/pi-core";
import { createRpcFs } from "@workspace/runtime/worker";
import { SYSTEM_AGENT_EVAL_GUIDE, SYSTEM_AGENT_PROMPT } from "./prompts.js";

const SYSTEM_AGENT_PARTICIPANT_METHOD_NAMES = [
  "pause",
  "resume",
  "scheduleResumeAtReset",
  "getAgentSettings",
  "getModelExecutionEvidence",
  "getDebugState",
  "inspectMethodSuspensions",
] as const;
const SYSTEM_AGENT_PARTICIPANT_METHODS = new Set<string>(
  SYSTEM_AGENT_PARTICIPANT_METHOD_NAMES
);

/**
 * Product-owned shell operator. Its small model-tool surface is deliberate:
 * shell semantics remain typed service/runtime APIs inside the ordinary EvalDO.
 */
export class SystemAgentWorker extends AgentWorkerBase {
  static override schemaVersion = AgentWorkerBase.schemaVersion;

  constructor(ctx: ConstructorParameters<typeof AgentWorkerBase>[0], env: unknown) {
    super(ctx, env);
    void this.setOwnTitle("System Agent");
  }

  protected override getParticipantInfo(
    _channelId: string,
    _config?: unknown
  ): ParticipantDescriptor {
    return {
      handle: "system-agent",
      name: "System Agent",
      type: "agent",
      metadata: { productOwned: true },
      methods: this.getStandardAgentMethods({
        include: SYSTEM_AGENT_PARTICIPANT_METHOD_NAMES,
      }),
    };
  }

  protected override isParticipantMethodEnabled(methodName: string): boolean {
    return SYSTEM_AGENT_PARTICIPANT_METHODS.has(methodName);
  }

  protected override async loadPromptResources(): Promise<{ workspacePrompt: string }> {
    return { workspacePrompt: SYSTEM_AGENT_EVAL_GUIDE };
  }

  protected override getAgentPrompt(): string {
    return SYSTEM_AGENT_PROMPT;
  }

  protected override getPromptOverride(): Record<string, never> {
    return {};
  }

  protected override includeMemoryRecallTool(): boolean {
    return false;
  }

  protected override getLoopTools(
    channelId: string,
    execution?: AgentToolExecutionContext
  ): AgentTool[] {
    const toolRpc = execution?.rpc ?? this.rpc;
    const fs = createRpcFs(toolRpc as never);
    return [
      createEvalTool(
        <T>(method: string, args: unknown[]) => toolRpc.call<T>("main", method, args),
        { subKey: channelId }
      ),
      this.createSayTool(channelId, fs),
    ];
  }
}
