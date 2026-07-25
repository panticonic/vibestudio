import type { ModelRecord } from "./types.js";

/**
 * Runtime context is model-owned unless the user explicitly overrides it.
 * Chat templates and sampler defaults remain in GGUF metadata and are applied
 * by llama.cpp; this layer must not silently replace either per model family.
 */
export function runtimeContextLengthFor(record: ModelRecord): number {
  return record.config.contextLength ?? record.trainedContextLength;
}
