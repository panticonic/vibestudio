import { PROVIDER_API_KEYS } from "./providerApiKeys.generated";
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
import {
  findMatchingUrlAudience,
  urlMatchesAudience,
} from "@vibestudio/credential-client/urlAudience";
import type { CredentialInjection } from "@vibestudio/credential-client/urlAudience";

export interface ProviderConnectMethod {
  id: "subscription" | "api-key";
  label: string;
  credentialLabel: string;
  /** Exact provider API surface to which the resulting credential is bound. */
  credentialAudience: UrlAudience[];
  /** The credentials.connect flow (OAuth params or api-key field collection). */
  flow: CredentialFlowSpec;
  /** How the stored credential injects auth into model API requests. */
  injection: CredentialInjection;
  /** OAuth-only: in-process redirect used by the workspace browser. */
  redirect?: OAuthLoopbackRedirectStrategy;
  redirectPolicy?: "loopback-required";
  /** OAuth-only: JWT account-identity claim extraction (e.g. openai-codex). */
  accountIdentityJwtClaimRoot?: string;
  accountIdentityJwtClaimField?: string;
}

export interface ProviderConnectPreset {
  providerId: string;
  /** Provider-owned endpoint templates and public connection settings. */
  modelBaseUrls?: string[];
  configuration?: Array<{
    name: string;
    label: string;
    placeholder: string;
    type: "identifier" | "https-url";
  }>;
  /** Ordered login methods; the first is the default. */
  methods: ProviderConnectMethod[];
}

const BEARER_INJECTION: CredentialInjection = {
  type: "header",
  name: "Authorization",
  valueTemplate: "Bearer {token}",
  stripIncoming: ["authorization"],
};

function apiKeyMethod(opts: {
  providerId: string;
  label: string;
  audienceUrl: string;
  injection?: CredentialInjection;
}): ProviderConnectMethod {
  return {
    id: "api-key",
    label: "API key",
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

function apiKeyPreset(opts: Parameters<typeof apiKeyMethod>[0]): ProviderConnectPreset {
  return { providerId: opts.providerId, methods: [apiKeyMethod(opts)] };
}

/** Claim used by the ChatGPT OAuth client to identify its account. */
const OPENAI_CODEX_ACCOUNT_CLAIM = "https://api.openai.com/auth";

function subscriptionMethod(
  providerId: string,
  label: string,
  audienceUrl: string
): ProviderConnectMethod {
  return {
    id: "subscription",
    label,
    credentialLabel: label,
    credentialAudience: [{ url: audienceUrl, match: "path-prefix" }],
    injection: BEARER_INJECTION,
    flow: { type: "model-provider-oauth", providerId },
  };
}

export function modelProviderLabel(providerId: string): string {
  return (
    (
      {
        "openai-codex": "ChatGPT",
        anthropic: "Claude",
        "github-copilot": "GitHub Copilot",
        "kimi-coding": "Kimi Code",
        meta: "Meta",
        xai: "xAI",
        openai: "OpenAI",
        google: "Google",
        openrouter: "OpenRouter",
        groq: "Groq",
        deepseek: "DeepSeek",
        mistral: "Mistral",
      } as Record<string, string>
    )[providerId] ??
    providerId
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

export const PROVIDER_CONNECT_PRESETS: Record<string, ProviderConnectPreset> = {
  "openai-codex": {
    providerId: "openai-codex",
    methods: [
      {
        id: "subscription",
        label: "ChatGPT subscription",
        credentialLabel: "ChatGPT Codex model credential",
        credentialAudience: [{ url: "https://chatgpt.com/backend-api", match: "path-prefix" }],
        injection: BEARER_INJECTION,
        accountIdentityJwtClaimRoot: OPENAI_CODEX_ACCOUNT_CLAIM,
        accountIdentityJwtClaimField: "chatgpt_account_id",
        redirectPolicy: "loopback-required",
        redirect: {
          type: "loopback",
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
    ],
  },
  openai: apiKeyPreset({
    providerId: "openai",
    label: "OpenAI API key",
    audienceUrl: "https://api.openai.com/v1",
  }),
  anthropic: {
    providerId: "anthropic",
    methods: [
      {
        id: "subscription",
        label: "Claude Pro / Max",
        credentialLabel: "Claude subscription",
        credentialAudience: [{ url: "https://api.anthropic.com", match: "origin" }],
        injection: { ...BEARER_INJECTION, stripIncoming: ["authorization", "x-api-key"] },
        flow: { type: "model-provider-oauth", providerId: "anthropic" },
      },
      apiKeyMethod({
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
    ],
  },
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
  "github-copilot": {
    providerId: "github-copilot",
    methods: [
      subscriptionMethod(
        "github-copilot",
        "GitHub Copilot",
        "https://api.individual.githubcopilot.com"
      ),
    ],
  },
  "kimi-coding": {
    providerId: "kimi-coding",
    methods: [subscriptionMethod("kimi-coding", "Kimi Code", "https://api.kimi.com/coding")],
  },
  meta: {
    providerId: "meta",
    methods: [
      subscriptionMethod("meta", "Meta Muse", "https://api.meta.ai/v1"),
      apiKeyMethod({
        providerId: "meta",
        label: "Meta API key",
        audienceUrl: "https://api.meta.ai/v1",
      }),
    ],
  },
  xai: {
    providerId: "xai",
    methods: [
      subscriptionMethod("xai", "SuperGrok / X Premium", "https://api.x.ai/v1"),
      apiKeyMethod({ providerId: "xai", label: "xAI API key", audienceUrl: "https://api.x.ai/v1" }),
    ],
  },
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

const CONFIGURED_PROVIDERS = [
  {
    id: "azure",
    label: "Azure OpenAI API key",
    header: "api-key",
    bases: [""],
    audiences: ["{ENDPOINT}"],
    fields: [
      {
        name: "ENDPOINT",
        label: "Azure OpenAI endpoint",
        placeholder: "https://your-resource.openai.azure.com/openai/v1",
        type: "https-url" as const,
      },
    ],
  },
  {
    id: "cloudflare-workers-ai",
    label: "Cloudflare API token",
    header: "Authorization",
    bases: ["https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1"],
    fields: [
      {
        name: "CLOUDFLARE_ACCOUNT_ID",
        label: "Cloudflare account ID",
        placeholder: "Account ID",
        type: "identifier" as const,
      },
    ],
  },
  {
    id: "cloudflare-ai-gateway",
    label: "Cloudflare API token",
    header: "cf-aig-authorization",
    bases: ["anthropic", "compat", "openai"].map(
      (api) =>
        `https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/${api}`
    ),
    fields: [
      {
        name: "CLOUDFLARE_ACCOUNT_ID",
        label: "Cloudflare account ID",
        placeholder: "Account ID",
        type: "identifier" as const,
      },
      {
        name: "CLOUDFLARE_GATEWAY_ID",
        label: "AI Gateway ID",
        placeholder: "Gateway ID",
        type: "identifier" as const,
      },
    ],
  },
  {
    id: "google-vertex",
    label: "Vertex AI express-mode API key",
    header: "x-goog-api-key",
    bases: ["https://{location}-aiplatform.googleapis.com"],
    audiences: ["https://aiplatform.googleapis.com"],
    fields: [],
  },
];
for (const provider of CONFIGURED_PROVIDERS) {
  const method = apiKeyMethod({
    providerId: provider.id,
    label: provider.label,
    audienceUrl: (provider.audiences ?? provider.bases)[0]!,
    injection: {
      type: "header",
      name: provider.header,
      valueTemplate: ["Authorization", "cf-aig-authorization"].includes(provider.header)
        ? "Bearer {token}"
        : "{token}",
      stripIncoming: [
        "authorization",
        "x-api-key",
        "x-goog-api-key",
        "api-key",
        "cf-aig-authorization",
      ],
    },
  });
  method.credentialAudience = (provider.audiences ?? provider.bases).map((url) => ({
    url,
    match: "path-prefix",
  }));
  PROVIDER_CONNECT_PRESETS[provider.id] = {
    providerId: provider.id,
    modelBaseUrls: provider.bases,
    configuration: provider.fields,
    methods: [method],
  };
}

function providerConfiguration(
  providerId: string,
  values: Record<string, string> = {}
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const field of getProviderConnectPreset(providerId)?.configuration ?? []) {
    const value = values[field.name]?.trim();
    if (!value) throw new Error(`${field.label} is required`);
    if (field.type === "https-url") {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
        throw new Error(`Enter a valid HTTPS URL for ${field.label}`);
      result[field.name] = value.replace(/\/+$/, "");
    } else {
      if (!/^[a-zA-Z0-9_-]+$/.test(value))
        throw new Error(
          `${field.label} must contain only letters, numbers, underscores, or hyphens`
        );
      result[field.name] = value;
    }
  }
  return result;
}

function fillProviderUrl(template: string, values: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    if (!values[name]) throw new Error(`Missing provider setting: ${name}`);
    return values[name];
  });
}

/** Resolve catalog endpoint templates from public, credential-owned settings. */
export function resolveProviderModelBaseUrl(
  providerId: string,
  baseUrl: string,
  metadata?: Record<string, string>
): string {
  if (metadata?.["modelBaseUrl"]) return metadata["modelBaseUrl"];
  if (!metadata?.["modelProviderConfig"]) return baseUrl;
  const config = providerConfiguration(providerId, JSON.parse(metadata["modelProviderConfig"]));
  return fillProviderUrl(baseUrl, config);
}

// Every fixed-endpoint API-key provider uses the same secure input flow.
for (const definition of PROVIDER_API_KEYS) {
  const method = apiKeyMethod({
    providerId: definition.providerId,
    label: definition.label,
    audienceUrl: definition.audienceUrls[0],
    injection: {
      type: "header",
      name: definition.header,
      valueTemplate: definition.header === "Authorization" ? "Bearer {token}" : "{token}",
      stripIncoming: ["authorization", "x-api-key", "x-goog-api-key"],
    },
  });
  method.credentialAudience = definition.audienceUrls.map((url) => ({ url, match: "path-prefix" }));
  const existing = PROVIDER_CONNECT_PRESETS[definition.providerId];
  if (!existing)
    PROVIDER_CONNECT_PRESETS[definition.providerId] = {
      providerId: definition.providerId,
      methods: [method],
    };
  else if (!existing.methods.some((entry) => entry.id === "api-key")) existing.methods.push(method);
}

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

export function getProviderConnectMethod(
  providerId: string,
  methodId?: string
): ProviderConnectMethod | null {
  const preset = getProviderConnectPreset(providerId);
  return (
    (methodId ? preset?.methods.find((method) => method.id === methodId) : preset?.methods[0]) ??
    null
  );
}

export function providerIsConnectable(providerId: string): boolean {
  return providerId in PROVIDER_CONNECT_PRESETS;
}

/** True when a base URL carries unresolved `{...}` template variables. */
export function isTemplatedBaseUrl(baseUrl: string): boolean {
  return /\{[^}]+\}/.test(baseUrl);
}

/**
 * A model can offer quick-connect when its concrete base URL overlaps the
 * preset audience. SDKs may append versioned paths beneath their base URL.
 * This is setup eligibility; credential injection still checks each request
 * against the unchanged preset audience.
 */
export function modelIsConnectable(providerId: string, baseUrl: string): boolean {
  const preset = getProviderConnectPreset(providerId);
  if (!preset) return false;
  if (preset.modelBaseUrls?.includes(baseUrl)) return true;
  if (preset.configuration && /^https:\/\//.test(baseUrl) && !isTemplatedBaseUrl(baseUrl))
    return true;
  if (isTemplatedBaseUrl(baseUrl)) return false;
  try {
    return preset.methods.some(
      (method) =>
        findMatchingUrlAudience(baseUrl, method.credentialAudience) !== null ||
        method.credentialAudience.some((audience) =>
          urlMatchesAudience(audience.url, { url: baseUrl, match: "path-prefix" })
        )
    );
  } catch {
    return false;
  }
}

function credentialMetadataForPreset(
  providerId: string,
  preset: ProviderConnectMethod
): Record<string, string> {
  return {
    modelProviderId: providerId,
    modelAuthMethod: preset.id,
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
  opts?: {
    browser?: "internal" | "external";
    method?: string;
    configuration?: Record<string, string>;
  }
): ConnectCredentialRequest | null {
  const preset = getProviderConnectMethod(providerId, opts?.method);
  if (!preset) return null;
  const browser = opts?.browser ?? "internal";
  const configuration = providerConfiguration(providerId, opts?.configuration);
  const audience = preset.credentialAudience.map((entry) => ({
    ...entry,
    url: fillProviderUrl(entry.url, configuration),
  }));
  const definition = getProviderConnectPreset(providerId)!;
  const baseUrl =
    definition.modelBaseUrls?.length === 1 && definition.modelBaseUrls[0] !== audience[0]?.url
      ? audience[0]?.url
      : undefined;
  // The workspace browser uses the server's in-process callback. For a system
  // browser, omit the strategy: the host selects the callback advertised by
  // the authenticated delivery client. Platform identity is intentionally not
  // part of this decision.
  const redirect =
    browser === "internal"
      ? preset.redirect
      : preset.redirect
        ? {
            host: preset.redirect.host,
            port: preset.redirect.port,
            callbackPath: preset.redirect.callbackPath,
          }
        : undefined;
  return {
    flow: preset.flow,
    credential: {
      label: preset.credentialLabel,
      audience,
      injection: preset.injection,
      metadata: {
        ...credentialMetadataForPreset(providerId, preset),
        ...(definition.configuration?.length
          ? { modelProviderConfig: JSON.stringify(configuration) }
          : {}),
        ...(baseUrl ? { modelBaseUrl: baseUrl } : {}),
      },
    },
    ...(redirect ? { redirect } : {}),
    browser,
  };
}

/**
 * Build the agent-side `ModelCredentialSetupProps`-shaped object consumed by
 * `TrajectoryVesselBase.getModelCredentialConnectSpec`. Returns a plain record
 * so shared does not depend on agentic-do's type.
 */
export function toAgentCredentialSetup(providerId: string): Record<string, unknown> | null {
  const preset = getProviderConnectMethod(providerId);
  if (!preset) return null;
  return {
    flow: preset.flow,
    credentialLabel: preset.credentialLabel,
    credential: {
      injection: preset.injection,
    },
    ...(preset.redirect ? { redirect: preset.redirect } : {}),
    ...(preset.redirectPolicy ? { redirectPolicy: preset.redirectPolicy } : {}),
    ...(preset.accountIdentityJwtClaimRoot
      ? { accountIdentityJwtClaimRoot: preset.accountIdentityJwtClaimRoot }
      : {}),
    ...(preset.accountIdentityJwtClaimField
      ? { accountIdentityJwtClaimField: preset.accountIdentityJwtClaimField }
      : {}),
  };
}
