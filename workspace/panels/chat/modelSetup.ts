import type {
  DefaultAgentConfig,
  ModelCatalog,
  ModelCatalogEntry,
  ModelSettingsSnapshot,
} from "@workspace/model-catalog/catalog";
import type { ConnectProviderResult } from "@workspace/agentic-core";
import {
  getProviderConnectPreset,
  listProviderConnectPresets,
} from "@workspace/model-catalog/providerConnect";

export interface ProviderSetupOption {
  providerId: string;
  label: string;
  modelRef: string;
  modelBaseUrl: string;
}

function isCredentialedCloudModel(model: ModelCatalogEntry): boolean {
  return model.auth === "url-bound" && model.availability.state === "ready";
}

/**
 * A fallback only needs consent when it was selected implicitly and no cloud
 * credential is currently usable. An explicitly saved local workspace default
 * is already consent; a ready cloud model means there is nothing to gate.
 */
export function requiresModelSetupChoice(settings: ModelSettingsSnapshot): boolean {
  return (
    settings.defaultModelSource === "fallback" &&
    !settings.catalog.models.some(isCredentialedCloudModel)
  );
}

function connectLabel(providerId: string): string {
  const preset = getProviderConnectPreset(providerId);
  if (!preset) return `Connect ${providerId}`;
  if (preset.flow.type === "oauth2-auth-code-pkce") {
    const providerName = preset.credentialLabel.replace(/ model credential$/i, "");
    return `Sign in with ${providerName}`;
  }
  return `Add ${preset.credentialLabel}`;
}

/** One canonical quick-connect target per provider, in registry order. */
export function providerSetupOptions(catalog: ModelCatalog): ProviderSetupOption[] {
  const providerOrder = listProviderConnectPresets().map((preset) => preset.providerId);
  const providersById = new Map(catalog.providers.map((provider) => [provider.id, provider]));

  return providerOrder.flatMap((providerId) => {
    const provider = providersById.get(providerId);
    if (!provider?.connectable) return [];
    const candidates = catalog.models.filter(
      (model) =>
        model.provider === providerId &&
        model.connectable &&
        model.availability.state === "needs-setup" &&
        model.availability.detail === "no-credential"
    );
    const model =
      candidates.find((candidate) => candidate.ref === provider.recommendedModelRef) ??
      candidates.find((candidate) => candidate.recommended) ??
      candidates[0];
    if (!model) return [];
    return [
      {
        providerId,
        label: connectLabel(providerId),
        modelRef: model.ref,
        modelBaseUrl: model.baseUrl,
      },
    ];
  });
}

export function localModelChoice(
  catalog: ModelCatalog,
  preferredRef: string
): ModelCatalogEntry | null {
  const usableLocalModels = catalog.models.filter(
    (model) =>
      model.auth === "loopback" &&
      (model.availability.state === "ready" || model.availability.state === "startable")
  );
  return (
    usableLocalModels.find((model) => model.ref === preferredRef) ?? usableLocalModels[0] ?? null
  );
}

/**
 * Finish first-run provider setup as one ordered transaction from the UI's
 * perspective: credential first, then the exact selected model as workspace
 * default. The gate remains mounted until both steps succeed.
 */
export async function completeProviderSetup(
  option: ProviderSetupOption,
  currentConfig: DefaultAgentConfig | null,
  connect: (
    option: ProviderSetupOption,
    opts: { browser: "internal" | "external" }
  ) => Promise<ConnectProviderResult>,
  connectOptions: { browser: "internal" | "external" },
  saveDefault: (config: DefaultAgentConfig) => Promise<void>
): Promise<ConnectProviderResult> {
  const result = await connect(option, connectOptions);
  if (!result.ok) return result;
  try {
    await saveDefault({ ...(currentConfig ?? {}), model: option.modelRef });
    return result;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
