import type { QuantName, ServerKind } from "@workspace/model-catalog/localModels";
import { LOCAL_FALLBACK_MODEL as CATALOG_FALLBACK_MODEL } from "@workspace/model-catalog/catalog";

/** Machine-global storage layout owned by the local-model implementation. */
export const ROOT_LAYOUT = {
  ownerLock: "owner.lock",
  ownerInfo: "owner.json",
  authKey: "auth.key",
  config: "config.json",
  serverLog: (kind: ServerKind) => `${kind}-server.log`,
  enginesDir: "engines",
  modelsDir: "models",
} as const;

export const FALLBACK_MODEL = {
  slug: CATALOG_FALLBACK_MODEL.id,
  ref: CATALOG_FALLBACK_MODEL.ref,
  displayName: CATALOG_FALLBACK_MODEL.name,
  hfRepo: "LiquidAI/LFM2.5-2.6B-GGUF",
  quant: "Q4_K_M" as QuantName,
  file: "LFM2.5-2.6B-Q4_K_M.gguf",
  downloadSizeBytes: CATALOG_FALLBACK_MODEL.downloadSizeBytes,
  contextLength: CATALOG_FALLBACK_MODEL.contextWindow,
} as const;
