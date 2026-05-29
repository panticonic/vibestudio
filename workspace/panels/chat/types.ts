/** Persisted per-agent record (mirrors PendingAgentRecord in bootstrap.ts). */
export interface PersistedPendingAgent {
  agentId: string;
  handle: string;
  key?: string;
  source?: string;
  className?: string;
  /** Per-agent subscription config (model/effort/etc.), excluding handle. */
  config?: Record<string, unknown>;
}

export interface ChatStateArgs {
  channelName: string;
  channelConfig?: Record<string, unknown>;
  contextId?: string;
  pendingAgents?: PersistedPendingAgent[];
  agentSource?: string;
  agentClass?: string;
  agentConfig?: Record<string, unknown>;
  initialPrompt?: string;
  systemPrompt?: string;
  systemPromptMode?: "append" | "replace-natstack" | "replace";
  actionBarFile?: string | null;
  actionBarProps?: Record<string, unknown> | null;
  actionBarMaxHeight?: number | null;
}
