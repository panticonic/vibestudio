import type { ApprovalLevel, ThinkingLevel } from "@natstack/harness";

import type { ModelCredentialSetupProps } from "./trajectory-vessel-base.js";

export const OPENAI_CODEX_ACCOUNT_CLAIM = "https://api.openai.com/auth";

/** Default model in "provider:modelId" form. pi-ai owns the provider registry. */
export const DEFAULT_MODEL = "openai-codex:gpt-5.5";

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

/** Default approval: 0=manual, 1=auto-safe, 2=full-auto. */
export const DEFAULT_APPROVAL_LEVEL: ApprovalLevel = 2;

export const DEFAULT_RESPOND_POLICY = "all" as const;

export const PROVIDER_CREDENTIAL_SETUPS: Record<string, ModelCredentialSetupProps> = {
  "openai-codex": {
    credentialLabel: "ChatGPT Codex model credential",
    accountIdentityJwtClaimRoot: OPENAI_CODEX_ACCOUNT_CLAIM,
    accountIdentityJwtClaimField: "chatgpt_account_id",
    redirectPolicy: "loopback-required",
    redirect: {
      type: "loopback",
      host: "localhost",
      port: 1455,
      callbackPath: "/auth/callback",
    },
    clientLoopbackRedirect: {
      type: "client-loopback",
      host: "localhost",
      port: 1455,
      callbackPath: "/auth/callback",
    },
    flow: {
      type: "oauth2-auth-code-pkce",
      authorizeUrl: "https://auth.openai.com/oauth/authorize",
      tokenUrl: "https://auth.openai.com/oauth/token",
      clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
      scopes: ["openid", "profile", "email", "offline_access"],
      extraAuthorizeParams: {
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
        originator: "codex_cli_rs",
      },
    },
  },
};
