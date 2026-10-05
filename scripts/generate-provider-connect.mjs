import fs from "node:fs";
import { builtinProviders, getBuiltinModels } from "@panticonic/pi-ai/providers/all";

// Endpoint configuration and subscription-only providers have explicit policy.
const configured = new Set([
  "azure",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "google-vertex",
  "openai-codex",
  "github-copilot",
]);
const entries = builtinProviders()
  .filter((provider) => provider.auth.apiKey?.login && !configured.has(provider.id))
  .map((provider) => {
    const models = provider.getModels().length
      ? provider.getModels()
      : getBuiltinModels(provider.id);
    const apis = [...new Set(models.map((model) => model.api))];
    return {
      providerId: provider.id,
      label:
        provider.id === "amazon-bedrock" ? "Amazon Bedrock API key" : provider.auth.apiKey.name,
      audienceUrls: [...new Set(models.map((model) => model.baseUrl))],
      header:
        provider.id === "google"
          ? "x-goog-api-key"
          : apis.length === 1 && apis[0] === "anthropic-messages"
            ? "x-api-key"
            : "Authorization",
    };
  })
  .filter((provider) => provider.audienceUrls.length);
fs.writeFileSync(
  new URL("../packages/shared/src/providerApiKeys.generated.ts", import.meta.url),
  "// Generated from Pi provider definitions. Regenerate with scripts/generate-provider-connect.mjs.\nexport const PROVIDER_API_KEYS = " +
    JSON.stringify(entries, null, 2) +
    " as const;\n"
);
