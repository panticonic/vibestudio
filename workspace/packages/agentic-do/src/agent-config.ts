import type { ApprovalLevel, ThinkingLevel } from "@workspace/harness";
import { toAgentCredentialSetup } from "@natstack/shared/models/providerConnect";

import type { ModelCredentialSetupProps } from "./trajectory-vessel-base.js";

export const OPENAI_CODEX_ACCOUNT_CLAIM = "https://api.openai.com/auth";

/** Default model in "provider:modelId" form. pi-ai owns the provider registry. */
export const DEFAULT_MODEL = "openai-codex:gpt-5.5";

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

/** Default approval: 0=manual, 1=auto-safe, 2=full-auto. */
export const DEFAULT_APPROVAL_LEVEL: ApprovalLevel = 2;

export const DEFAULT_RESPOND_POLICY = "all" as const;

/**
 * Agent-side model credential connect setups. Derived from the shared provider
 * connect presets (`@natstack/shared/models/providerConnect`) so the panel
 * picker and the agent share one source. Today only `openai-codex` is wired for
 * agent-initiated (mid-turn) connect; api-key providers are connected ahead of
 * time via the panel model picker, then merely resolved here.
 */
export const PROVIDER_CREDENTIAL_SETUPS: Record<string, ModelCredentialSetupProps> = (() => {
  const setups: Record<string, ModelCredentialSetupProps> = {};
  const codex = toAgentCredentialSetup("openai-codex");
  if (codex) setups["openai-codex"] = codex;
  return setups;
})();
