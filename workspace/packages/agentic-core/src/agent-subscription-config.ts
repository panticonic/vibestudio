export type AgentThinkingLevel = "minimal" | "low" | "medium" | "high";
export type AgentApprovalLevel = 0 | 1 | 2;
export type AgentRespondPolicy =
  | "all"
  | "mentioned"
  | "mentioned-strict"
  | "mentioned-or-followup"
  | "from-participants";

export interface AgentSubscriptionConfig {
  /** Model in "provider:modelId" form. */
  model?: string;
  /** Effort level for the model. */
  thinkingLevel?: AgentThinkingLevel;
  /** 0=manual, 1=auto-safe, 2=full-auto. */
  approvalLevel?: AgentApprovalLevel;
  /** Override or append to the workspace system prompt. */
  systemPrompt?: string;
  systemPromptMode?: "append" | "replace" | "replace-natstack";
  /** Chattiness: who the agent responds to. */
  respondPolicy?: AgentRespondPolicy;
  respondFrom?: string[];
  /** Optional cap for model rounds in one turn. Null/undefined means unlimited. */
  maxModelCallsPerTurn?: number | null;
  /** Worker-specific extras, such as handle and display name. */
  [key: string]: unknown;
}
