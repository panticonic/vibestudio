/**
 * Model settings service — the single authority on what a model IS
 * (journaled `modelSpec`) and whether it is USABLE right now (`availability`).
 *
 * Catalog = pi-ai registry entries (static, cached) + local-models extension
 * entries (live, per snapshot). Availability is computed here and shared by
 * every consumer — picker, agent config, fallback logic, CLI — replacing the
 * old panel-side connection heuristic (design
 * docs/local-models-extension-design.md §6.1/§7.1/§8).
 */

import { DurableObjectBase, rpc } from "@workspace/runtime/worker";
import type { WorkspaceConfig } from "@workspace/runtime/worker";
import {
  DEFAULT_AGENT_MODEL_REF,
  LOCAL_FALLBACK_MODEL_REF,
  LOCAL_MODELS_EXTENSION_ID,
  LOCAL_PROVIDER_ID,
  WORKSPACE_DEFAULT_AGENT_CONFIG_FIELD,
  type AgentThinkingLevel,
  type DefaultAgentConfig,
  type ModelAvailability,
  type ModelCatalog,
  type ModelCatalogEntry,
  type ModelCatalogProvider,
  type ModelSettingsSnapshot,
  type PiModelSpec,
} from "@workspace/model-catalog/catalog";
import {
  isTemplatedBaseUrl,
  modelIsConnectable,
  providerIsConnectable,
} from "@workspace/model-catalog/providerConnect";
import { pickRecommendedModelId } from "@workspace/model-catalog/modelRecommendations";
import {
  findMatchingUrlAudience,
  type UrlAudience,
} from "@vibestudio/shared/credentials/urlAudience";

const AGENT_THINKING_LEVELS = new Set<string>(["minimal", "low", "medium", "high", "xhigh", "max"]);

type PiAiModule = {
  getModels: typeof import("@earendil-works/pi-ai/providers/all").getBuiltinModels;
  getProviders: typeof import("@earendil-works/pi-ai/providers/all").getBuiltinProviders;
  getSupportedThinkingLevels: typeof import("@earendil-works/pi-ai").getSupportedThinkingLevels;
};

async function loadPiAi(): Promise<PiAiModule> {
  const [{ getSupportedThinkingLevels }, { getBuiltinModels, getBuiltinProviders }] =
    await Promise.all([
      import("@earendil-works/pi-ai"),
      import("@earendil-works/pi-ai/providers/all"),
    ]);
  return {
    getModels: getBuiltinModels,
    getProviders: getBuiltinProviders,
    getSupportedThinkingLevels,
  };
}

/** llama-server quirks (design §6.4); mirrors agentic-do's model-spec.ts. */
const LLAMA_SERVER_COMPAT: Record<string, unknown> = { supportsReasoningEffort: false };

/** Shape of the local-models extension's listModels() entries we consume. */
export interface LocalModelEntry {
  slug: string;
  displayName: string;
  baseUrl: string;
  contextWindow: number;
  maxTokens: number;
  measuredTokensPerSec: number | null;
  toolsCapable: boolean;
  state: "ready" | "startable" | "downloading" | "error";
  downloadProgress: number | null;
  errorMessage: string | null;
}

let cachedCatalog: Promise<ModelCatalog> | null = null;

export function getModelCatalog(): Promise<ModelCatalog> {
  if (!cachedCatalog) {
    const catalogPromise = buildModelCatalog();
    cachedCatalog = catalogPromise;
    catalogPromise.catch(() => {
      if (cachedCatalog === catalogPromise) cachedCatalog = null;
    });
  }
  return cachedCatalog;
}

interface PiModelLike {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Record<string, unknown>;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

function piModelToSpec(model: PiModelLike): PiModelSpec {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    provider: model.provider,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    input: [...model.input],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
    ...(model.headers ? { headers: { ...model.headers } } : {}),
    ...(model.compat ? { compat: { ...model.compat } } : {}),
  };
}

/** Static pi-ai registry projection. Availability here is a placeholder —
 *  the snapshot overlay (applyCloudAvailability) is authoritative. */
export async function buildModelCatalog(): Promise<ModelCatalog> {
  const { getModels, getProviders, getSupportedThinkingLevels } = await loadPiAi();
  const providerIds = getProviders();
  const providers: ModelCatalogProvider[] = [];
  const models: ModelCatalogEntry[] = [];
  const recommendedRefs = new Set<string>();

  for (const providerId of providerIds) {
    const provModels = getModels(providerId);
    const recommendedId = pickRecommendedModelId(providerId, provModels);
    if (recommendedId) recommendedRefs.add(`${providerId}:${recommendedId}`);
  }

  for (const providerId of providerIds) {
    const provModels = getModels(providerId);
    const baseUrls = Array.from(new Set(provModels.map((model) => model.baseUrl)));
    const recommendedModelId = pickRecommendedModelId(providerId, provModels);
    providers.push({
      id: providerId,
      label: providerId,
      baseUrls,
      recommendedModelRef: recommendedModelId ? `${providerId}:${recommendedModelId}` : null,
      connectable:
        providerIsConnectable(providerId) && baseUrls.some((url) => !isTemplatedBaseUrl(url)),
    });

    for (const model of provModels) {
      const ref = `${providerId}:${model.id}`;
      const thinkingLevels = model.reasoning
        ? (getSupportedThinkingLevels(model).filter((level) =>
            AGENT_THINKING_LEVELS.has(level)
          ) as AgentThinkingLevel[])
        : [];
      const connectable = modelIsConnectable(providerId, model.baseUrl);
      models.push({
        ref,
        id: model.id,
        name: model.name,
        provider: providerId,
        baseUrl: model.baseUrl,
        reasoning: model.reasoning,
        vision: model.input.includes("image"),
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        thinkingLevels,
        templatedBaseUrl: isTemplatedBaseUrl(model.baseUrl),
        connectable,
        recommended: recommendedRefs.has(ref),
        auth: "url-bound",
        availability: {
          state: "needs-setup",
          detail: connectable ? "no-credential" : "not-installed",
        },
        modelSpec: piModelToSpec(model as unknown as PiModelLike),
        capabilities: { tools: true },
      });
    }
  }

  return { providers, models };
}

export function localEntryToCatalogEntry(entry: LocalModelEntry): ModelCatalogEntry {
  return {
    ref: `${LOCAL_PROVIDER_ID}:${entry.slug}`,
    id: entry.slug,
    name: entry.displayName,
    provider: LOCAL_PROVIDER_ID,
    baseUrl: entry.baseUrl,
    reasoning: false,
    vision: false,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    tokensPerSec: entry.measuredTokensPerSec ?? null,
    thinkingLevels: [],
    templatedBaseUrl: false,
    // Local models are never "connectable" — no credential flow exists for
    // them; availability comes from live server state (design §6.3/§7.1).
    connectable: false,
    recommended: `${LOCAL_PROVIDER_ID}:${entry.slug}` === LOCAL_FALLBACK_MODEL_REF,
    auth: "loopback",
    availability: localAvailability(entry),
    modelSpec: {
      id: entry.slug,
      name: entry.displayName,
      api: "openai-completions",
      provider: LOCAL_PROVIDER_ID,
      baseUrl: entry.baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxTokens,
      compat: { ...LLAMA_SERVER_COMPAT },
    },
    capabilities: { tools: entry.toolsCapable },
  };
}

function localAvailability(entry: LocalModelEntry): ModelAvailability {
  switch (entry.state) {
    case "ready":
      return { state: "ready", detail: "running" };
    case "startable":
      return { state: "startable", detail: "will-load-on-use" };
    case "downloading":
      return {
        state: "downloading",
        progress: entry.downloadProgress ?? 0,
        phase: "active",
      };
    case "error":
      return { state: "error", message: entry.errorMessage ?? "local server error" };
  }
}

export function applyCloudAvailability(
  entry: ModelCatalogEntry,
  audiences: readonly UrlAudience[]
): ModelCatalogEntry {
  if (entry.auth !== "url-bound") return entry;
  // Credential presence establishes readiness today; the TTL'd live probe
  // (design §7.1) lands with the connect-time standing grant for this worker
  // — probing without that grant would raise approval prompts, which is
  // strictly worse than presence-based availability.
  const matched = (() => {
    try {
      return findMatchingUrlAudience(entry.baseUrl, audiences) !== null;
    } catch {
      return false;
    }
  })();
  const availability: ModelAvailability = matched
    ? { state: "ready", detail: "credentialed" }
    : {
        state: "needs-setup",
        detail: entry.connectable ? "no-credential" : "not-installed",
      };
  return { ...entry, availability };
}

/** A model an agent can actually run on right now (design §8). */
export function isUsable(entry: ModelCatalogEntry): boolean {
  return entry.availability.state === "ready" || entry.availability.state === "startable";
}

export function pickFallbackModel(catalog: ModelCatalog): {
  ref: string;
  reason?: "missing" | "unavailable";
} {
  const byRef = (ref: string) => catalog.models.find((model) => model.ref === ref);
  const preferred = byRef(DEFAULT_AGENT_MODEL_REF);
  const preferredRef = preferred?.ref;
  if (preferred && isUsable(preferred)) return { ref: preferred.ref };
  const recommended = catalog.models.find((model) => model.recommended && isUsable(model));
  if (recommended) return { ref: recommended.ref };
  // The floor (design §8): the local fallback is kept servable at all times.
  const localFloor = byRef(LOCAL_FALLBACK_MODEL_REF);
  if (localFloor && isUsable(localFloor)) return { ref: localFloor.ref };
  const anyUsable = catalog.models.find(isUsable);
  if (anyUsable) return { ref: anyUsable.ref };
  // Nothing usable at all — keep the old static preference so the connect
  // flow has a sensible target.
  return { ref: preferredRef ?? catalog.models[0]?.ref ?? "" };
}

export class ModelSettingsDO extends DurableObjectBase {
  protected createTables(): void {}

  async listCatalog(): Promise<ModelCatalog> {
    return this.assembleCatalog();
  }

  @rpc({ callers: ["panel", "server"] })
  async getSettings(): Promise<ModelSettingsSnapshot> {
    const [catalog, config] = await Promise.all([
      this.assembleCatalog(),
      this.getWorkspaceConfig(),
    ]);
    return this.resolveSettings(catalog, config);
  }

  async getDefaultModel(): Promise<ModelSettingsSnapshot> {
    return this.getSettings();
  }

  @rpc({ callers: ["panel", "server"] })
  async setDefaultAgentConfig(input: DefaultAgentConfig): Promise<ModelSettingsSnapshot> {
    const catalog = await this.assembleCatalog();
    const model = catalog.models.find((entry) => entry.ref === input.model);
    if (!model) {
      throw new Error(`Unknown model ref: ${input.model}`);
    }
    const config: DefaultAgentConfig = {
      model: model.ref,
      ...(input.thinkingLevel && AGENT_THINKING_LEVELS.has(input.thinkingLevel)
        ? { thinkingLevel: input.thinkingLevel }
        : {}),
      ...(input.approvalLevel === 0 || input.approvalLevel === 1 || input.approvalLevel === 2
        ? { approvalLevel: input.approvalLevel }
        : {}),
    };
    await this.setWorkspaceConfigField(WORKSPACE_DEFAULT_AGENT_CONFIG_FIELD, config);
    return {
      catalog,
      defaultModel: model.ref,
      defaultModelSource: "workspace",
      defaultAgentConfig: config,
    };
  }

  /** Static pi projection — overridable seam for tests. */
  protected getCatalog(): Promise<ModelCatalog> {
    return getModelCatalog();
  }

  /** Static pi catalog + live availability overlay + live local entries. */
  protected async assembleCatalog(): Promise<ModelCatalog> {
    const [base, audiences, localEntries] = await Promise.all([
      this.getCatalog(),
      this.credentialAudiences(),
      this.fetchLocalModels(),
    ]);
    const models = [
      ...base.models.map((entry) => applyCloudAvailability(entry, audiences)),
      ...localEntries.map(localEntryToCatalogEntry),
    ];
    const providers: ModelCatalogProvider[] = localEntries.length
      ? [
          ...base.providers,
          {
            id: LOCAL_PROVIDER_ID,
            label: "Local (llama.cpp)",
            baseUrls: Array.from(new Set(localEntries.map((entry) => entry.baseUrl))),
            recommendedModelRef: LOCAL_FALLBACK_MODEL_REF,
            connectable: false,
          },
        ]
      : [...base.providers];
    return { providers, models };
  }

  /** Stored-credential audiences (worker-computed availability, design §7.1).
   *  Failure degrades to "nothing credentialed", never an error snapshot. */
  protected async credentialAudiences(): Promise<UrlAudience[]> {
    try {
      const creds = await this.rpc.call<Array<{ audience?: UrlAudience[] }>>(
        "main",
        "credentials.listStoredCredentials",
        []
      );
      return Array.isArray(creds) ? creds.flatMap((cred) => cred.audience ?? []) : [];
    } catch (err) {
      console.warn("[model-settings] credential audience lookup failed:", err);
      return [];
    }
  }

  /** Live local-models extension entries. Absent extension ⇒ no local models. */
  protected async fetchLocalModels(): Promise<LocalModelEntry[]> {
    try {
      const entries = await this.rpc.call<LocalModelEntry[]>("main", "extensions.invoke", [
        LOCAL_MODELS_EXTENSION_ID,
        "listModels",
        [],
      ]);
      return Array.isArray(entries) ? entries : [];
    } catch {
      return [];
    }
  }

  protected getWorkspaceConfig(): Promise<WorkspaceConfig> {
    return this.rpc.call<WorkspaceConfig>("main", "workspace.getConfig", []);
  }

  protected setWorkspaceConfigField(key: string, value: unknown): Promise<void> {
    return this.rpc.call<void>("main", "workspace.setConfigField", [key, value]);
  }

  private resolveSettings(catalog: ModelCatalog, config: WorkspaceConfig): ModelSettingsSnapshot {
    const stored = parseDefaultAgentConfig(config.defaultAgentConfig);
    const behavior = {
      ...(stored.thinkingLevel ? { thinkingLevel: stored.thinkingLevel } : {}),
      ...(stored.approvalLevel !== undefined ? { approvalLevel: stored.approvalLevel } : {}),
    };
    const storedEntry = stored.model
      ? catalog.models.find((model) => model.ref === stored.model)
      : undefined;
    // The stored default wins while it is usable; a present-but-unavailable
    // default falls back WITHOUT being treated as invalid (design §8) — it
    // comes back the moment its provider does.
    if (storedEntry && isUsable(storedEntry)) {
      return {
        catalog,
        defaultModel: storedEntry.ref,
        defaultModelSource: "workspace",
        defaultAgentConfig: { model: storedEntry.ref, ...behavior },
      };
    }
    const fallback = pickFallbackModel(catalog);
    return {
      catalog,
      defaultModel: fallback.ref,
      defaultModelSource: "fallback",
      ...(stored.model
        ? {
            defaultModelFallbackReason: storedEntry ? "unavailable" : "missing",
            ...(storedEntry ? {} : { invalidDefaultModel: stored.model }),
          }
        : {}),
      defaultAgentConfig: { model: fallback.ref, ...behavior },
    };
  }
}

/** Parse + validate the stored defaultAgentConfig (tolerates legacy/garbage). */
function parseDefaultAgentConfig(value: unknown): {
  model: string | null;
  thinkingLevel?: AgentThinkingLevel;
  approvalLevel?: 0 | 1 | 2;
} {
  if (!value || typeof value !== "object") return { model: null };
  const v = value as Record<string, unknown>;
  const rawModel = v["model"];
  const model = typeof rawModel === "string" && rawModel.trim().length > 0 ? rawModel.trim() : null;
  const rawThinking = v["thinkingLevel"];
  const thinkingLevel = AGENT_THINKING_LEVELS.has(rawThinking as string)
    ? (rawThinking as AgentThinkingLevel)
    : undefined;
  const rawApproval = v["approvalLevel"];
  const approvalLevel =
    rawApproval === 0 || rawApproval === 1 || rawApproval === 2 ? rawApproval : undefined;
  return {
    model,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(approvalLevel !== undefined ? { approvalLevel } : {}),
  };
}

export default {
  async fetch() {
    return new Response(
      "Model Settings service.\nMethods: listCatalog, getSettings, getDefaultModel, setDefaultAgentConfig.\n",
      { headers: { "Content-Type": "text/plain" } }
    );
  },
};
