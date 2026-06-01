import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import {
  isTemplatedBaseUrl,
  modelIsConnectable,
  providerIsConnectable,
} from "@natstack/shared/models/providerConnect";
import type {
  AgentThinkingLevel,
  ModelCatalog,
  ModelCatalogEntry,
  ModelCatalogProvider,
} from "@natstack/shared/models/catalog";

const AGENT_THINKING_LEVELS = new Set<string>(["minimal", "low", "medium", "high"]);

type PiAiModule = typeof import("@earendil-works/pi-ai");

/**
 * Flagship-newest curation. pi carries no release-date/rank field, so we keep a
 * small maintained list of important providers plus per-provider family rules
 * that pin the flagship *tier* (not cheap variants). The version comparator then
 * auto-promotes within a family when pi ships a newer version — no code change.
 */
interface FlagshipRule {
  provider: string;
  prefer: RegExp[];
  exclude?: RegExp[];
}

// NOTE: exclude patterns use word boundaries — a bare /mini/ would match
// "ge<mini>" and wrongly drop every Gemini model.
const FLAGSHIP_RULES: FlagshipRule[] = [
  {
    provider: "openai-codex",
    prefer: [/codex/i, /gpt-5/i],
    exclude: [/\bmini\b|\bnano\b|\bspark\b/i],
  },
  { provider: "anthropic", prefer: [/opus/i] },
  {
    provider: "openai",
    prefer: [/gpt-5/i],
    exclude: [/\bmini\b|\bnano\b|\bcodex\b|\bchat\b|\bpro\b/i],
  },
  { provider: "google", prefer: [/gemini.*pro/i, /gemini/i], exclude: [/\bflash\b|\blite\b/i] },
  { provider: "xai", prefer: [/grok/i], exclude: [/\bmini\b|\bfast\b|\breasoning\b/i] },
  { provider: "openrouter", prefer: [/gpt-5/i, /claude.*opus/i], exclude: [/\bmini\b|\bnano\b/i] },
];

/** Extract a comparable version vector from a model id, dropping date-like
 *  tokens (≥5 digits) so dated snapshots don't outrank clean aliases. */
function versionVector(id: string): number[] {
  return (id.match(/\d+/g) ?? []).filter((tok) => tok.length <= 4).map((tok) => parseInt(tok, 10));
}

/** Compare version vectors; returns >0 if a is newer. Ties break toward the
 *  shorter id (the clean alias rather than a longer dated/variant id). */
function compareVersions(aId: string, bId: string): number {
  const a = versionVector(aId);
  const b = versionVector(bId);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return bId.length - aId.length;
}

function pickFlagship(rule: FlagshipRule, models: { id: string }[]): string | null {
  const candidates = models.filter(
    (m) =>
      rule.prefer.some((re) => re.test(m.id)) && !(rule.exclude ?? []).some((re) => re.test(m.id))
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((best, m) => (compareVersions(m.id, best.id) > 0 ? m : best)).id;
}

async function loadPiAi(): Promise<PiAiModule> {
  return import("@earendil-works/pi-ai");
}

async function buildCatalog(): Promise<ModelCatalog> {
  const { getModels, getProviders, getSupportedThinkingLevels } = await loadPiAi();
  const providerIds = getProviders();
  const providers: ModelCatalogProvider[] = [];
  const models: ModelCatalogEntry[] = [];
  const recommendedRefs = new Set<string>();

  // Resolve flagship-newest recommended set.
  for (const rule of FLAGSHIP_RULES) {
    if (!providerIds.includes(rule.provider as never)) continue;
    const provModels = getModels(rule.provider as never);
    const flagshipId = pickFlagship(rule, provModels);
    if (flagshipId) recommendedRefs.add(`${rule.provider}:${flagshipId}`);
  }

  for (const providerId of providerIds) {
    const provModels = getModels(providerId);
    const baseUrls = Array.from(new Set(provModels.map((m) => m.baseUrl)));
    providers.push({
      id: providerId,
      label: providerId,
      baseUrls,
      connectable:
        providerIsConnectable(providerId) && baseUrls.some((u) => !isTemplatedBaseUrl(u)),
    });

    for (const m of provModels) {
      const ref = `${providerId}:${m.id}`;
      const thinkingLevels = m.reasoning
        ? (getSupportedThinkingLevels(m).filter((l) =>
            AGENT_THINKING_LEVELS.has(l)
          ) as AgentThinkingLevel[])
        : [];
      models.push({
        ref,
        id: m.id,
        name: m.name,
        provider: providerId,
        baseUrl: m.baseUrl,
        reasoning: m.reasoning,
        vision: m.input.includes("image"),
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        thinkingLevels,
        templatedBaseUrl: isTemplatedBaseUrl(m.baseUrl),
        connectable: modelIsConnectable(providerId, m.baseUrl),
        recommended: recommendedRefs.has(ref),
      });
    }
  }

  return { providers, models };
}

export function createModelCatalogService(): ServiceDefinition {
  // The pi catalog is static for the process lifetime — build once.
  let cached: ModelCatalog | null = null;
  return {
    name: "models",
    description: "Static model catalog from the pi registry (no credentials/connection state)",
    policy: { allowed: ["panel", "shell", "server", "worker", "app", "do", "extension"] },
    methods: {
      listCatalog: { args: z.tuple([]) },
    },
    handler: async (_ctx, method) => {
      switch (method) {
        case "listCatalog":
          if (!cached) cached = await buildCatalog();
          return cached;
        default:
          throw new Error(`Unknown models method: ${method}`);
      }
    },
  };
}
