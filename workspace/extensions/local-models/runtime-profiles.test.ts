import { describe, expect, it } from "vitest";
import { runtimeContextLengthFor } from "./runtime-profiles.js";
import type { ModelRecord } from "@workspace/model-catalog/localModels";

describe("local model runtime profiles", () => {
  it("uses the context window declared by the model", () => {
    expect(runtimeContextLengthFor(record("Acme/Model-GGUF"))).toBe(128_000);
  });

  it("keeps explicit model configuration above the family default", () => {
    const configured = record("Acme/Model-GGUF");
    configured.config.contextLength = 16_384;
    expect(runtimeContextLengthFor(configured)).toBe(16_384);
  });
});

function record(hfRepo: string): ModelRecord {
  const name = hfRepo.slice(hfRepo.lastIndexOf("/") + 1);
  return {
    slug: name.toLowerCase(),
    displayName: name,
    hfRepo,
    file: `/models/${name}-Q4_K_M.gguf`,
    sizeBytes: 1,
    quant: "Q4_K_M",
    paramCount: "1B",
    arch: "llama",
    trainedContextLength: 128_000,
    toolsCapable: true,
    sha256: "0".repeat(64),
    importedInPlace: false,
    config: { contextLength: null, gpuLayers: null },
    addedAt: 1,
  };
}
