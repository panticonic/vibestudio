import type { QuantName, ServerKind } from "@workspace/model-catalog/localModels";

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
  slug: "lfm2.5-1.2b",
  ref: "local:lfm2.5-1.2b",
  displayName: "LFM2.5 1.2B Instruct",
  hfRepo: "NobodyWho/LFM2.5-1.2B-Instruct-GGUF",
  quant: "Q4_0" as QuantName,
  file: "LFM2.5-1.2B-Instruct-Q4_0-vendor-sampling.gguf",
  contextLength: 32_768,
} as const;
