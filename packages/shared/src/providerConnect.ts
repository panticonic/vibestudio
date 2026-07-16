/**
 * Provider connect presets: the single source of truth for connecting a model
 * provider's credential, used by both panels and agent runtimes.
 */

import type {
  ConnectCredentialRequest,
  CredentialFlowSpec,
  OAuthLoopbackRedirectStrategy,
  UrlAudience,
} from "@vibestudio/credential-client/types";
import { findMatchingUrlAudience } from "@vibestudio/credential-client/urlAudience";
import type { CredentialInjection } from "@vibestudio/credential-client/urlAudience";

export interface ProviderConnectPreset {
  providerId: string;
  credentialLabel: string;
  /** Exact provider API surface to which the resulting credential is bound. */
  credentialAudience: UrlAudience[];
  /** The credentials.connect flow (OAuth params or api-key field collection). */
  flow: CredentialFlowSpec;
  /** How the stored credential injects auth into model API requests. */
  injection: CredentialInjection;
  /** OAuth-only: redirect strategies + policy (agent selects at connect time). */
  redirect?: OAuthLoopbackRedirectStrategy;
  clientLoopbackRedirect?: OAuthLoopbackRedirectStrategy;
  redirectPolicy?: "loopback-required";
  /** OAuth-only: JWT account-identity claim extraction (e.g. openai-codex). */
  accountIdentityJwtClaimRoot?: string;
  accountIdentityJwtClaimField?: string;
}

const BEARER_INJECTION: CredentialInjection = {
  type: "header",
  name: "Authorization",
  valueTemplate: "Bearer {token}",
  stripIncoming: ["authorization"],
};

function apiKeyPreset(opts: {
  providerId: string;
  label: string;
  audienceUrl: string;
  injection?: CredentialInjection;
}): ProviderConnectPreset {
  return {
    providerId: opts.providerId,
    credentialLabel: opts.label,
    credentialAudience: [{ url: opts.audienceUrl, match: "path-prefix" }],
    flow: {
      type: "api-key",
      title: opts.label,
      description: `Paste your ${opts.label}. It is stored locally and scoped to this provider.`,
      fields: [{ name: "apiKey", label: "API key", type: "secret", required: true }],
      materialTemplate: { type: "api-key", valueTemplate: "{apiKey}" },
      accountValidation: "none",
    },
    injection: opts.injection ?? BEARER_INJECTION,
  };
}

/** OpenAI Codex (ChatGPT) OAuth: the one preset the agent already supported. */
const OPENAI_CODEX_ACCOUNT_CLAIM = "https://api.openai.com/auth";

export const PROVIDER_CONNECT_PRESETS: Record<string, ProviderConnectPreset> = {
  "openai-codex": {
    providerId: "openai-codex",
    credentialLabel: "ChatGPT Codex model credential",
    credentialAudience: [{ url: "https://chatgpt.com/backend-api", match: "path-prefix" }],
    injection: BEARER_INJECTION,
    accountIdentityJwtClaimRoot: OPENAI_CODEX_ACCOUNT_CLAIM,
    accountIdentityJwtClaimField: "chatgpt_account_id",
    redirectPolicy: "loopback-required",
    redirect: { type: "loopback", host: "localhost", port: 1455, callbackPath: "/auth/callback" },
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
      persistRefreshToken: true,
      extraAuthorizeParams: {
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
        originator: "codex_cli_rs",
      },
    },
  },
  openai: apiKeyPreset({
    providerId: "openai",
    label: "OpenAI API key",
    audienceUrl: "https://api.openai.com/v1",
  }),
  anthropic: apiKeyPreset({
    providerId: "anthropic",
    label: "Anthropic API key",
    audienceUrl: "https://api.anthropic.com",
    injection: {
      type: "header",
      name: "x-api-key",
      valueTemplate: "{token}",
      stripIncoming: ["x-api-key", "authorization"],
    },
  }),
  openrouter: apiKeyPreset({
    providerId: "openrouter",
    label: "OpenRouter API key",
    audienceUrl: "https://openrouter.ai/api/v1",
  }),
  groq: apiKeyPreset({
    providerId: "groq",
    label: "Groq API key",
    audienceUrl: "https://api.groq.com/openai/v1",
  }),
  xai: apiKeyPreset({
    providerId: "xai",
    label: "xAI API key",
    audienceUrl: "https://api.x.ai/v1",
  }),
  deepseek: apiKeyPreset({
    providerId: "deepseek",
    label: "DeepSeek API key",
    audienceUrl: "https://api.deepseek.com",
  }),
  mistral: apiKeyPreset({
    providerId: "mistral",
    label: "Mistral API key",
    audienceUrl: "https://api.mistral.ai",
  }),
  google: apiKeyPreset({
    providerId: "google",
    label: "Google AI API key",
    audienceUrl: "https://generativelanguage.googleapis.com/v1beta",
    injection: {
      type: "header",
      name: "x-goog-api-key",
      valueTemplate: "{token}",
      stripIncoming: ["x-goog-api-key"],
    },
  }),
};

export const MODEL_PROVIDER_CONNECT_ORDER = [
  "openai-codex",
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "groq",
  "xai",
  "deepseek",
  "mistral",
] as const;

export function listProviderConnectPresets(): ProviderConnectPreset[] {
  const ordered = MODEL_PROVIDER_CONNECT_ORDER.flatMap((providerId) => {
    const preset = PROVIDER_CONNECT_PRESETS[providerId];
    return preset ? [preset] : [];
  });
  const orderedIds = new Set(ordered.map((preset) => preset.providerId));
  return [
    ...ordered,
    ...Object.values(PROVIDER_CONNECT_PRESETS).filter(
      (preset) => !orderedIds.has(preset.providerId)
    ),
  ];
}

export function getProviderConnectPreset(providerId: string): ProviderConnectPreset | null {
  return PROVIDER_CONNECT_PRESETS[providerId] ?? null;
}

export function providerIsConnectable(providerId: string): boolean {
  return providerId in PROVIDER_CONNECT_PRESETS;
}

/** True when a base URL carries unresolved `{...}` template variables. */
export function isTemplatedBaseUrl(baseUrl: string): boolean {
  return /\{[^}]+\}/.test(baseUrl);
}

/**
 * A model is quick-connectable when its provider has a preset and its base URL
 * is concrete (not templated). Authoritative per-model connectability.
 */
export function modelIsConnectable(providerId: string, baseUrl: string): boolean {
  const preset = getProviderConnectPreset(providerId);
  if (!preset || isTemplatedBaseUrl(baseUrl)) return false;
  try {
    return findMatchingUrlAudience(baseUrl, preset.credentialAudience) !== null;
  } catch {
    return false;
  }
}

function credentialMetadataForPreset(preset: ProviderConnectPreset): Record<string, string> {
  return {
    modelProviderId: preset.providerId,
    ...(preset.accountIdentityJwtClaimRoot
      ? { accountIdentityJwtClaimRoot: preset.accountIdentityJwtClaimRoot }
      : {}),
    ...(preset.accountIdentityJwtClaimField
      ? { accountIdentityJwtClaimField: preset.accountIdentityJwtClaimField }
      : {}),
  };
}

/** Build the `credentials.connect` request from canonical provider policy. */
export function toCredentialConnectRequest(
  providerId: string,
  opts?: { browser?: "internal" | "external" }
): ConnectCredentialRequest | null {
  const preset = getProviderConnectPreset(providerId);
  if (!preset) return null;
  const browser = opts?.browser ?? "internal";
  // OAuth loopback flows: an external/system browser needs the client-loopback
  // redirect; the internal browser uses the in-process loopback redirect.
  const redirect =
    browser === "external" && preset.clientLoopbackRedirect
      ? preset.clientLoopbackRedirect
      : preset.redirect;
  return {
    flow: preset.flow,
    credential: {
      label: preset.credentialLabel,
      audience: preset.credentialAudience.map((audience) => ({ ...audience })),
      injection: preset.injection,
      metadata: credentialMetadataForPreset(preset),
    },
    ...(redirect ? { redirect } : {}),
    browser,
  };
}

/** Build the panel-facing request from the same canonical provider policy. */
export function toPanelConnectRequest(
  providerId: string,
  opts?: { browser?: "internal" | "external" }
): ConnectCredentialRequest | null {
  return toCredentialConnectRequest(providerId, opts);
}

/**
 * Build the agent-side `ModelCredentialSetupProps`-shaped object consumed by
 * `TrajectoryVesselBase.getModelCredentialConnectSpec`. Returns a plain record
 * so shared does not depend on agentic-do's type.
 */
export function toAgentCredentialSetup(providerId: string): Record<string, unknown> | null {
  const preset = getProviderConnectPreset(providerId);
  if (!preset) return null;
  return {
    flow: preset.flow,
    credentialLabel: preset.credentialLabel,
    credential: {
      injection: preset.injection,
    },
    ...(preset.redirect ? { redirect: preset.redirect } : {}),
    ...(preset.clientLoopbackRedirect
      ? { clientLoopbackRedirect: preset.clientLoopbackRedirect }
      : {}),
    ...(preset.redirectPolicy ? { redirectPolicy: preset.redirectPolicy } : {}),
    ...(preset.accountIdentityJwtClaimRoot
      ? { accountIdentityJwtClaimRoot: preset.accountIdentityJwtClaimRoot }
      : {}),
    ...(preset.accountIdentityJwtClaimField
      ? { accountIdentityJwtClaimField: preset.accountIdentityJwtClaimField }
      : {}),
  };
}
