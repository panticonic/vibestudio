/**
 * Model catalog shared types.
 *
 * The workspace model-settings service returns the STATIC pi catalog described
 * here — no credentials, no connection state. Connection status is computed
 * panel-side from the panel's own `credentials.listStoredCredentials()` so it
 * stays scoped to that caller's identity.
 */

export const MODEL_SETTINGS_SERVICE_PROTOCOL = "vibez1.models.v1";
/** Workspace config field holding the full default agent config (model + behavior). */
export const WORKSPACE_DEFAULT_AGENT_CONFIG_FIELD = "defaultAgentConfig";
export const DEFAULT_AGENT_MODEL_REF = "openai-codex:gpt-5.5";

/** Effort levels the agent harness accepts (subset of pi's ModelThinkingLevel). */
export type AgentThinkingLevel = "minimal" | "low" | "medium" | "high";

/**
 * Workspace-wide defaults applied to NEW agents — model plus behavior. Persisted
 * as a single workspace config field, written ONLY via an explicit "Save as
 * defaults" action (never as a side-effect of adding/spawning an agent).
 */
export interface DefaultAgentConfig {
  /** Default model ref ("provider:modelId"). */
  model: string;
  /** Default reasoning effort (reasoning models only). */
  thinkingLevel?: AgentThinkingLevel;
  /** Default autonomy (0 = Manual, 1 = Auto-safe, 2 = Full-auto). */
  approvalLevel?: 0 | 1 | 2;
}

export interface ModelCatalogProvider {
  id: string;
  label: string;
  /** Distinct base URLs across this provider's models (can be >1). */
  baseUrls: string[];
  /** Recommended onboarding/default model for this provider, when known. */
  recommendedModelRef: string | null;
  /**
   * Summary only: a connect preset exists AND at least one non-templated model
   * baseUrl. The per-model `connectable` flag is authoritative for the UI.
   */
  connectable: boolean;
}

export interface ModelCatalogEntry {
  /** Stable "provider:modelId" form used as the agent's `model` config. */
  ref: string;
  id: string;
  name: string;
  provider: string;
  /** Per-model base URL — used for credential matching. */
  baseUrl: string;
  reasoning: boolean;
  vision: boolean;
  contextWindow: number;
  maxTokens: number;
  /** Model-supported subset of the four agent thinking levels. */
  thinkingLevels: AgentThinkingLevel[];
  /** baseUrl contains "{...}" placeholders → not quick-connectable. */
  templatedBaseUrl: boolean;
  /** Authoritative: a connect preset exists for the provider AND !templatedBaseUrl. */
  connectable: boolean;
  /** Part of the curated flagship-newest recommended set. */
  recommended: boolean;
}

export interface ModelCatalog {
  providers: ModelCatalogProvider[];
  models: ModelCatalogEntry[];
}

export interface ModelSettingsSnapshot {
  catalog: ModelCatalog;
  /** Resolved/validated default model (equals `defaultAgentConfig.model`). */
  defaultModel: string;
  defaultModelSource: "workspace" | "fallback";
  invalidDefaultModel?: string;
  /** Full default agent config (model + behavior) applied to new agents. */
  defaultAgentConfig: DefaultAgentConfig;
}
